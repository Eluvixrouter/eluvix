import type { ChatMessage } from '../index.js';
import {
  assertProviderEndpointAllowed,
  type ContextProvider,
  type MemoryConfig,
  type RecallBlock,
  type RecallResult,
  type RequestScope
} from './types.js';
import { fetchWithSafeRedirects, readCappedJson } from '../fetch-policy.js';

/**
 * claude-mem worker API version this provider was built and verified
 * against (thedotmack/claude-mem v16.1.0). The worker API has no versioned
 * path, so health() checks the version the worker reports and warns when
 * the major.minor drifts from this target.
 */
export const CLAUDEMEM_TARGET_VERSION = '16.1.0';

/** Worker port base: claude-mem listens on 37700 + (uid % 100) by default. */
const CLAUDEMEM_PORT_BASE = 37700;

/**
 * claude-mem project key for an Eluvix user. claude-mem scopes by project,
 * not by user, so each Eluvix user gets their own project namespace inside
 * the one shared worker/data dir. Recall is exact-match on this key (the
 * worker expands it to its stored read keys), and — once write-back lands
 * — saves will carry the same key.
 */
export function claudeMemProjectForUser(userId: string): string {
  return `eluvix:${userId || 'default'}`;
}

function uidOffset(): number {
  try {
    if (
      typeof process !== 'undefined' &&
      typeof process.getuid === 'function'
    ) {
      const uid = process.getuid();
      return ((uid % 100) + 100) % 100;
    }
  } catch {
    // Non-POSIX runtime (or a sandbox without getuid): fall through.
  }
  return 0;
}

/**
 * Resolve the worker endpoint. Precedence:
 *   1. explicit config.endpoint (canvas node / config file)
 *   2. CLAUDE_MEM_WORKER_ENDPOINT env (full URL)
 *   3. CLAUDE_MEM_WORKER_PORT env (port on loopback)
 *   4. claude-mem default: http://127.0.0.1:37700 + (uid % 100)
 *
 * NOTE: on Windows claude-mem derives its default port from a hash of the
 * data dir instead of the uid, so the uid-based default above is wrong
 * there — set the endpoint (or CLAUDE_MEM_WORKER_PORT) explicitly on
 * Windows. The settings.json CLAUDE_MEM_WORKER_PORT override is likewise
 * not read here; env/config cover it.
 */
export function resolveClaudeMemEndpoint(config: MemoryConfig = {}): string {
  const fromConfig = (config.endpoint || '').trim();
  if (fromConfig) return fromConfig.replace(/\/+$/, '');
  const fromEnv = (process.env.CLAUDE_MEM_WORKER_ENDPOINT || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const portEnv = (process.env.CLAUDE_MEM_WORKER_PORT || '').trim();
  if (portEnv) {
    const port = Number(portEnv);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return `http://127.0.0.1:${port}`;
    }
  }
  return `http://127.0.0.1:${CLAUDEMEM_PORT_BASE + uidOffset()}`;
}

export class ClaudeMemContextProvider implements ContextProvider {
  public readonly id = 'claudemem';
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  /** Last health() outcome, so the down-guidance is logged once per outage. */
  private lastHealth: boolean | undefined = undefined;

  constructor(config: MemoryConfig = {}) {
    this.endpoint = resolveClaudeMemEndpoint(config);
    // H-9/M-18: refuse remote plaintext endpoints at construction.
    assertProviderEndpointAllowed(this.endpoint, 'ClaudeMem');
    // Token mode: the worker accepts X-Claude-Mem-Token (or Bearer) when
    // CLAUDE_MEM_LOCAL_API_TOKEN is set on its side. Read it from the
    // provider config (apiKey) or the environment, like the mem0 provider.
    this.apiKey =
      config.apiKey || process.env.CLAUDE_MEM_LOCAL_API_TOKEN || undefined;
    this.timeoutMs = config.recallTimeoutMs ?? 1500;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.apiKey) {
      headers['X-Claude-Mem-Token'] = this.apiKey;
    }
    return headers;
  }

  private downGuidance(cause: string): string {
    return (
      `[ClaudeMemContextProvider] worker is not healthy at ${this.endpoint} (${cause}). ` +
      `The claude-mem worker must already be running — install/start claude-mem ` +
      `(\`npx claude-mem install\`) and make sure the worker is up, or set the ` +
      `memory endpoint to the worker URL (config endpoint or ` +
      `CLAUDE_MEM_WORKER_ENDPOINT). Recall returns nothing until it answers.`
    );
  }

  public async health(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetchWithSafeRedirects(`${this.endpoint}/api/health`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: controller.signal
      });
      if (!res.ok) {
        if (this.lastHealth !== false) {
          console.warn(this.downGuidance(`HTTP ${res.status}`));
        }
        this.lastHealth = false;
        return false;
      }
      let version: unknown;
      try {
        const data: any = await readCappedJson(res);
        version = data?.version;
      } catch {
        version = undefined;
      }
      if (typeof version === 'string' && version.length > 0) {
        const match = /^(\d+)\.(\d+)/.exec(version);
        const target = /^(\d+)\.(\d+)/.exec(CLAUDEMEM_TARGET_VERSION);
        if (
          match &&
          target &&
          (match[1] !== target[1] || match[2] !== target[2])
        ) {
          console.warn(
            `[ClaudeMemContextProvider] worker version ${version} differs from ` +
              `the ${CLAUDEMEM_TARGET_VERSION} this provider targets; the worker ` +
              `API is unversioned, so recall may behave differently.`
          );
        }
      }
      this.lastHealth = true;
      return true;
    } catch {
      if (this.lastHealth !== false) {
        console.warn(this.downGuidance('unreachable'));
      }
      this.lastHealth = false;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  public async recall(
    query: string,
    scope: RequestScope,
    budgetTokens: number,
    signal?: AbortSignal
  ): Promise<RecallResult> {
    const start = Date.now();
    const trimmed = (query || '').trim();
    if (!trimmed) {
      return { blocks: [], tokenEstimate: 0, provider: this.id, latencyMs: 0 };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        return { blocks: [], tokenEstimate: 0, provider: this.id, latencyMs: 0 };
      }
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const project = claudeMemProjectForUser(scope.userId || 'default');
      const params = new URLSearchParams({
        query: trimmed,
        project,
        format: 'json',
        limit: '8'
      });
      const res = await fetchWithSafeRedirects(`${this.endpoint}/api/search?${params}`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`ClaudeMem search returned HTTP ${res.status}`);
      }

      const data: any = await readCappedJson(res);
      const observations: any[] = Array.isArray(data?.observations)
        ? data.observations
        : [];
      const sessions: any[] = Array.isArray(data?.sessions) ? data.sessions : [];
      const allItems: any[] = [...observations, ...sessions];

      // Audit H-9: never trust the server to have scoped the search to
      // the requesting user. Drop any entry whose project field is present
      // and names a different project. Entries with NO project field are
      // kept but counted as unattributed — the count is logged, never the
      // content.
      const requestingProject = project;
      let foreignDropped = 0;
      let unattributed = 0;
      const rawItems = allItems.filter((entry) => {
        const owner = entry?.project;
        if (owner != null && String(owner) !== '') {
          if (String(owner) !== requestingProject) {
            foreignDropped++;
            return false;
          }
          return true;
        }
        unattributed++;
        return true;
      });
      if (foreignDropped > 0 || unattributed > 0) {
        console.log(
          `[ClaudeMemContextProvider] recall ownership filter: dropped ${foreignDropped} foreign-project, kept ${unattributed} unattributed (no project field) of ${allItems.length} returned`
        );
      }

      const blocks: RecallBlock[] = [];
      let usedTokens = 0;
      const maxTokens = Math.max(64, budgetTokens || 800);

      for (const entry of rawItems) {
        const text = claudeMemEntryText(entry);
        if (!text) continue;
        const est = Math.max(1, Math.ceil(text.length / 4));
        if (usedTokens + est > maxTokens) {
          if (blocks.length === 0) {
            const sliced = text.slice(0, maxTokens * 4);
            blocks.push({
              uri: claudeMemEntryUri(entry),
              text: sliced,
              score: typeof entry?.score === 'number' ? entry.score : undefined,
              level: 'L1'
            });
            usedTokens += Math.ceil(sliced.length / 4);
          }
          break;
        }
        blocks.push({
          uri: claudeMemEntryUri(entry),
          text,
          score: typeof entry?.score === 'number' ? entry.score : undefined,
          level: 'L1'
        });
        usedTokens += est;
      }

      return {
        blocks,
        tokenEstimate: usedTokens,
        provider: this.id,
        latencyMs: Date.now() - start
      };
    } finally {
      clearTimeout(timer);
    }
  }

  public async remember(
    _turn: { user: ChatMessage; assistant: string },
    _scope: RequestScope
  ): Promise<void> {
    // RECALL-ONLY in v1 (accepted design decision): claude-mem's save path
    // stores an explicit manual note, and observer-distilled observations
    // only come from live hook-fed activity with no replay. Saving the raw
    // turn here would pollute the distilled store with untyped manual
    // observations, so remember() is a deliberate no-op. Capture already
    // happens through claude-mem's own OpenCode/Antigravity plugins where
    // they are installed.
    return;
  }
}

/**
 * Observation rows carry text/narrative/facts; session-summary rows carry
 * learned/completed/request. Prefer the distilled body, fall back to the
 * next-best field, and lead with the title when one exists.
 */
function claudeMemEntryText(entry: any): string {
  const title = String(entry?.title || '').trim();
  let body = '';
  if (typeof entry?.text === 'string' && entry.text.trim()) {
    body = entry.text.trim();
  } else if (typeof entry?.narrative === 'string' && entry.narrative.trim()) {
    body = entry.narrative.trim();
  } else if (typeof entry?.facts === 'string' && entry.facts.trim()) {
    body = entry.facts.trim();
  } else {
    // Session-summary rows: the distilled outcomes first; the original
    // request only as a last resort (it can be long and un-distilled).
    const distilled = [entry?.learned, entry?.completed]
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => String(p).trim());
    if (distilled.length > 0) {
      body = distilled.join('\n');
    } else if (typeof entry?.request === 'string' && entry.request.trim()) {
      body = entry.request.trim();
    }
  }
  if (!body) return '';
  return title ? `${title}\n${body}` : body;
}

function claudeMemEntryUri(entry: any): string | undefined {
  if (entry?.id === undefined || entry?.id === null || entry?.id === '') {
    return undefined;
  }
  const kind =
    typeof entry?.learned === 'string' ||
    typeof entry?.completed === 'string' ||
    typeof entry?.request === 'string'
      ? 'session'
      : 'observation';
  return `claudemem://${kind}/${entry.id}`;
}
