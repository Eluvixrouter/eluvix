import { setBounded } from '../bounded-map.js';
import type { ChatMessage } from '../index.js';
import {
  assertProviderEndpointAllowed,
  type ContextProvider,
  type MemoryConfig,
  type RecallBlock,
  type RecallResult,
  type RequestScope
} from './types.js';

function extractText(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(p => p.type === 'text')
      .map(p => (p as { type: 'text'; text: string }).text)
      .join('\n');
  }
  return '';
}

export class OpenVikingContextProvider implements ContextProvider {
  public readonly id = 'openviking';
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly autoCommitTurns: number;
  private readonly readingLevel: 'L0' | 'L1' | 'L2';
  private readonly scopePrefixes?: string[];
  private turnCounts: Map<string, number> = new Map();

  constructor(config: MemoryConfig = {}) {
    this.endpoint = (config.endpoint || 'http://127.0.0.1:1933').trim().replace(/\/+$/, '');
    // H-9/M-18: refuse remote plaintext endpoints at construction.
    assertProviderEndpointAllowed(this.endpoint, 'OpenViking');
    this.apiKey = config.apiKey || process.env.OPENVIKING_API_KEY;
    this.timeoutMs = config.recallTimeoutMs ?? 1500;
    this.autoCommitTurns = Math.max(1, config.autoCommitTurns ?? 5);
    this.readingLevel = config.openviking?.readingLevel || 'L1';
    this.scopePrefixes = config.openviking?.scopePrefixes;
  }

  private buildHeaders(scope?: RequestScope): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
      headers['X-Api-Key'] = this.apiKey;
    }
    if (scope?.userId) {
      headers['X-OpenViking-User'] = scope.userId;
    }
    return headers;
  }

  public async health(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${this.endpoint}/health`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: controller.signal
      });
      return res.ok;
    } catch {
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

    const userId = scope.userId || 'default';
    const userPrefix = `viking://user/${userId}`;
    let targetUris: string[];
    if (Array.isArray(this.scopePrefixes) && this.scopePrefixes.length > 0) {
      // Audit H-9: scopePrefixes may only NARROW the search within the
      // requesting user's own prefix. Previously the configured list
      // REPLACED the per-user target outright, so one user's recall could
      // be pointed at (or leak) another user's tree.
      for (const prefix of this.scopePrefixes) {
        if (prefix !== userPrefix && !prefix.startsWith(`${userPrefix}/`)) {
          throw new Error(
            `openviking.scopePrefixes entry '${prefix}' is outside the requesting user's prefix '${userPrefix}/' — scopePrefixes can only narrow within the per-user prefix`
          );
        }
      }
      targetUris = this.scopePrefixes;
    } else {
      targetUris = [`${userPrefix}/memories`];
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
      const res = await fetch(`${this.endpoint}/api/v1/search/find`, {
        method: 'POST',
        headers: this.buildHeaders(scope),
        body: JSON.stringify({
          query: trimmed,
          target_uri: targetUris[0],
          target_uris: targetUris,
          level: this.readingLevel,
          limit: 8
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`OpenViking search/find returned HTTP ${res.status}`);
      }

      const data: any = await res.json();
      const allItems: any[] = Array.isArray(data?.result?.memories)
        ? data.result.memories
        : Array.isArray(data?.result?.resources)
        ? data.result.resources
        : Array.isArray(data?.result)
        ? data.result
        : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.items)
        ? data.items
        : [];

      // Audit H-9: do not trust the server to have scoped results to the
      // requesting user. Drop entries whose owner field names someone
      // else, and entries whose URI falls outside the user's prefix.
      // Entries carrying neither an owner field nor a URI are kept but
      // counted as unattributed (logged as a count, never content).
      let foreignDropped = 0;
      let unattributed = 0;
      const rawItems = allItems.filter((entry) => {
        const owner = entry?.user_id ?? entry?.userId ?? entry?.owner ?? entry?.metadata?.user_id;
        if (owner != null && String(owner) !== '') {
          if (String(owner) !== userId) {
            foreignDropped++;
            return false;
          }
          return true;
        }
        const uri = typeof entry?.uri === 'string' ? entry.uri : '';
        if (uri) {
          if (uri === userPrefix || uri.startsWith(`${userPrefix}/`)) return true;
          foreignDropped++;
          return false;
        }
        unattributed++;
        return true;
      });
      if (foreignDropped > 0 || unattributed > 0) {
        console.log(
          `[OpenVikingContextProvider] recall ownership filter: dropped ${foreignDropped} foreign-owned/out-of-prefix, kept ${unattributed} unattributed (no owner field or URI) of ${allItems.length} returned`
        );
      }

      const blocks: RecallBlock[] = [];
      let usedTokens = 0;
      const maxTokens = Math.max(64, budgetTokens || 800);

      for (const entry of rawItems) {
        const l0 = entry?.abstract || entry?.L0 || entry?.l0;
        const l1 = entry?.overview || entry?.L1 || entry?.l1;
        const l2 = entry?.content || entry?.L2 || entry?.l2;
        const picked =
          this.readingLevel === 'L0'
            ? l0 || l1 || l2
            : this.readingLevel === 'L1'
            ? l1 || l0 || l2
            : l2 || l1 || l0;
        const text = String(picked || entry?.text || '').trim();
        if (!text) continue;

        const est = Math.max(1, Math.ceil(text.length / 4));
        if (usedTokens + est > maxTokens) {
          if (blocks.length === 0) {
            const sliced = text.slice(0, maxTokens * 4);
            blocks.push({
              uri: entry?.uri,
              text: sliced,
              score: typeof entry?.score === 'number' ? entry.score : undefined,
              level: (entry?.level as 'L0' | 'L1' | 'L2') || this.readingLevel
            });
            usedTokens += Math.ceil(sliced.length / 4);
          }
          break;
        }

        blocks.push({
          uri: entry?.uri,
          text,
          score: typeof entry?.score === 'number' ? entry.score : undefined,
          level: (entry?.level as 'L0' | 'L1' | 'L2') || this.readingLevel
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
    turn: { user: ChatMessage; assistant: string },
    scope: RequestScope
  ): Promise<void> {
    const userText = extractText(turn.user).trim();
    const assistantText = (turn.assistant || '').trim();
    if (!userText && !assistantText) return;

    const userId = scope.userId || 'default';
    const sessionId = scope.sessionId || `eluvix-${userId}`;
    const targetUri = `viking://user/${userId}/memories`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    try {
      const res = await fetch(`${this.endpoint}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        headers: this.buildHeaders(scope),
        body: JSON.stringify({
          user_id: userId,
          target_uri: targetUri,
          messages: [
            { role: 'user', content: userText },
            { role: 'assistant', content: assistantText }
          ]
        }),
        signal: controller.signal
      });

      // Hunt-2 L-B2: a server-rejected write must not advance auto-commit
      // progress — commits would otherwise fire for turns the server
      // never stored. Only a successful write counts toward the threshold.
      if (!res.ok) return;

      const count = (this.turnCounts.get(sessionId) || 0) + 1;
      // Bounded: one counter per session id, evicted oldest-first, so the
      // map cannot grow without bound for the process lifetime. (Eviction
      // only loses auto-commit progress for the evicted session.)
      setBounded(this.turnCounts, sessionId, count);
      if (count >= this.autoCommitTurns) {
        this.turnCounts.set(sessionId, 0);
        await this.commit(scope);
      }
    } catch {
      // Fail open on write-back errors
    } finally {
      clearTimeout(timer);
    }
  }

  public async commit(scope: RequestScope): Promise<void> {
    const userId = scope.userId || 'default';
    const sessionId = scope.sessionId || `eluvix-${userId}`;
    const targetUri = `viking://user/${userId}/memories`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(`${this.endpoint}/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
        method: 'POST',
        headers: this.buildHeaders(scope),
        body: JSON.stringify({
          user_id: userId,
          target_uri: targetUri
        }),
        signal: controller.signal
      });
    } catch {
      // Ignore commit failure
    } finally {
      clearTimeout(timer);
    }
  }
}
