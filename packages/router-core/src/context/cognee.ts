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
import { fetchWithSafeRedirects } from '../fetch-policy.js';

export class CogneeContextProvider implements ContextProvider {
  public readonly id = 'cognee';
  private endpoint: string;
  private apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config?: MemoryConfig) {
    this.endpoint = (config?.endpoint || 'http://localhost:8005').replace(/\/+$/, '');
    // Hunt-3 B-L5: refuse remote plaintext endpoints at construction,
    // mirroring mem0/openviking.
    assertProviderEndpointAllowed(this.endpoint, 'Cognee');
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
      const res = await fetchWithSafeRedirects(`${this.endpoint}/api/v1/search`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          query_params: { query, search_type: 'INSIGHTS' },
          datasets: [`user_${scope.userId || 'default'}`]
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        return { blocks: [], tokenEstimate: 0, provider: this.id, latencyMs: Date.now() - start };
      }
      const data: any = await res.json();
      const allItems: any[] = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
      // Hunt-3 B-M3: never trust the server to have scoped the search
      // to the requesting user (audit H-9, mirroring mem0).
      const items = filterOwnedRecallItems(allItems, scope.userId || 'default', 'CogneeContextProvider');
      const blocks: RecallBlock[] = [];
      let usedTokens = 0;

      for (const item of items) {
        let text = String(item.text || item.content || item.summary || '').trim();
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
          uri: item.id ? `cognee://${scope.userId}/${item.id}` : `cognee://${scope.userId}`,
          text,
          score: typeof item.score === 'number' ? item.score : 0.8,
          level: 'L1'
        });
        if (usedTokens >= budgetTokens) break;
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
      await fetchWithSafeRedirects(`${this.endpoint}/api/v1/add`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          dataset_name: `user_${scope.userId || 'default'}`,
          data: `User: ${userContent}\nAssistant: ${turn.assistant}`
        }),
        signal: controller.signal
      });
    } catch {
      // Non-fatal
    } finally {
      clearTimeout(timer);
    }
  }

  public async commit(scope: RequestScope): Promise<void> {
    // Hunt-3 B-M4: time-box the commit like remember (3s) — same class
    // of unbounded write.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await fetchWithSafeRedirects(`${this.endpoint}/api/v1/cognify`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          datasets: [`user_${scope.userId || 'default'}`]
        }),
        signal: controller.signal
      });
    } catch {
      // Non-fatal
    } finally {
      clearTimeout(timer);
    }
  }
}
