import type { ChatMessage } from '../index.js';
import {
  assertProviderEndpointAllowed,
  filterOwnedRecallItems,
  type ContextProvider,
  type MemoryConfig,
  type RecallBlock,
  type RecallResult,
  type RequestScope
} from './types.js';
import { fetchWithSafeRedirects, readCappedJson } from '../fetch-policy.js';

export class LightRagContextProvider implements ContextProvider {
  public readonly id = 'lightrag';
  private endpoint: string;
  private apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config?: MemoryConfig) {
    this.endpoint = (config?.endpoint || 'http://localhost:9621').replace(/\/+$/, '');
    // Hunt-3 B-L5: refuse remote plaintext endpoints at construction,
    // mirroring mem0/openviking.
    assertProviderEndpointAllowed(this.endpoint, 'LightRag');
    this.apiKey = config?.apiKey;
    // Hunt-3 B-M4: recall timeout, default 1500ms like mem0.
    this.timeoutMs = config?.recallTimeoutMs ?? 1500;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  public async health(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetchWithSafeRedirects(`${this.endpoint}/health`, {
        method: 'GET',
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
    // Hunt-3 B-M4: time-box recall like mem0 (recallTimeoutMs, default
    // 1500ms) and forward the caller signal into the same controller.
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
      const res = await fetchWithSafeRedirects(`${this.endpoint}/query`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          query,
          mode: 'hybrid',
          only_need_context: true,
          user_id: scope.userId
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        return { blocks: [], tokenEstimate: 0, provider: this.id, latencyMs: Date.now() - start };
      }
      const data: any = await readCappedJson(res);
      const blocks: RecallBlock[] = [];
      let usedTokens = 0;

      // Hunt-3 B-M3: never trust the server to have scoped the search
      // to the requesting user (audit H-9, mirroring mem0). The
      // synthesized `data.response` string below has no per-item owner
      // to check and is left as-is.
      const rawResults = Array.isArray(data?.results)
        ? filterOwnedRecallItems(data.results, scope.userId || 'default', 'LightRagContextProvider')
        : [];
      if (rawResults.length > 0) {
        for (const r of rawResults) {
          let text = String(r.text || r.content || '').trim();
          if (!text) continue;
          const est = Math.ceil(text.length / 4);
          if (usedTokens + est > budgetTokens) {
            const remainingTokens = Math.max(0, budgetTokens - usedTokens);
            if (remainingTokens <= 10 && blocks.length > 0) break;
            text = text.slice(0, Math.max(100, remainingTokens * 4));
          }
          const finalEst = Math.ceil(text.length / 4);
          usedTokens += finalEst;
          blocks.push({
            uri: r.source || `lightrag://${scope.userId}/chunk`,
            text,
            score: typeof r.score === 'number' ? r.score : 0.8,
            level: 'L1'
          });
          if (usedTokens >= budgetTokens) break;
        }
      } else if (typeof data?.response === 'string' && data.response.trim()) {
        const maxChars = budgetTokens * 4;
        const trimmed = data.response.trim().slice(0, maxChars);
        usedTokens = Math.ceil(trimmed.length / 4);
        blocks.push({
          uri: `lightrag://${scope.userId}/hybrid`,
          text: trimmed,
          score: 0.85,
          level: 'L1'
        });
      }

      return {
        blocks,
        tokenEstimate: usedTokens,
        provider: this.id,
        latencyMs: Date.now() - start
      };
    } catch {
      return { blocks: [], tokenEstimate: 0, provider: this.id, latencyMs: Date.now() - start };
    } finally {
      clearTimeout(timer);
    }
  }

  public async remember(
    turn: { user: ChatMessage; assistant: string },
    scope: RequestScope
  ): Promise<void> {
    // Hunt-3 B-M4: time-box the write like mem0 (3s).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const userContent =
        typeof turn.user.content === 'string' ? turn.user.content : JSON.stringify(turn.user.content);
      const formatted = `User (${scope.userId}): ${userContent}\nAssistant: ${turn.assistant}`;
      const res = await fetchWithSafeRedirects(`${this.endpoint}/texts`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          texts: [formatted],
          file_source: `session:${scope.userId}:${scope.sessionId || 'default'}`
        }),
        signal: controller.signal
      });
      // Hunt-3 B-L2: surface a server-rejected write instead of
      // silently swallowing it (mirrors openviking).
      if (!res.ok) {
        console.warn(`[LightRagContextProvider] remember failed: HTTP ${res.status}`);
        return;
      }
    } catch {
      // Non-fatal fire-and-forget
    } finally {
      clearTimeout(timer);
    }
  }
}
