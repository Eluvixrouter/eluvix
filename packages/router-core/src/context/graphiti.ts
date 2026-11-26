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

export class GraphitiContextProvider implements ContextProvider {
  public readonly id = 'graphiti';
  private endpoint: string;
  private apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config?: MemoryConfig) {
    this.endpoint = (config?.endpoint || 'http://localhost:8004').replace(/\/+$/, '');
    // Hunt-3 B-L5: refuse remote plaintext endpoints at construction,
    // mirroring mem0/openviking.
    assertProviderEndpointAllowed(this.endpoint, 'Graphiti');
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
    // 1500ms) and forward the caller signal into the same controller —
    // a hung memory server must not stall the chat turn indefinitely.
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
      const res = await fetchWithSafeRedirects(`${this.endpoint}/search`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          group_id: scope.userId || 'default',
          query,
          max_facts: 10
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        return { blocks: [], tokenEstimate: 0, provider: this.id, latencyMs: Date.now() - start };
      }
      const data: any = await readCappedJson(res);
      const allFacts: any[] = Array.isArray(data?.facts)
        ? data.facts
        : Array.isArray(data?.edges)
        ? data.edges
        : Array.isArray(data)
        ? data
        : [];
      // Hunt-3 B-M3: never trust the server to have scoped the search
      // to the requesting user (audit H-9, mirroring mem0).
      const rawFacts = filterOwnedRecallItems(allFacts, scope.userId || 'default', 'GraphitiContextProvider');

      const blocks: RecallBlock[] = [];
      let usedTokens = 0;

      for (const item of rawFacts) {
        const factText = String(item.fact || item.summary || item.content || '').trim();
        if (!factText) continue;
        const validWindow = item.valid_at
          ? ` [valid: ${item.valid_at}${item.invalid_at ? ` .. ${item.invalid_at}` : ' .. present'}]`
          : '';
        let formatted = `${factText}${validWindow}`;
        const est = Math.ceil(formatted.length / 4);
        if (usedTokens + est > budgetTokens) {
          const remainingTokens = Math.max(0, budgetTokens - usedTokens);
          if (remainingTokens <= 10 && blocks.length > 0) break;
          formatted = formatted.slice(0, Math.max(100, remainingTokens * 4));
        }
        const finalEst = Math.ceil(formatted.length / 4);
        usedTokens += finalEst;
        blocks.push({
          uri: item.uuid ? `graphiti://${scope.userId}/${item.uuid}` : `graphiti://${scope.userId}`,
          text: formatted,
          score: typeof item.score === 'number' ? item.score : 0.85,
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
      const res = await fetchWithSafeRedirects(`${this.endpoint}/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          group_id: scope.userId || 'default',
          messages: [
            { role: 'user', content: userContent, timestamp: new Date().toISOString() },
            { role: 'assistant', content: turn.assistant, timestamp: new Date().toISOString() }
          ]
        }),
        signal: controller.signal
      });
      // Hunt-3 B-L2: surface a server-rejected write instead of
      // silently swallowing it (mirrors openviking).
      if (!res.ok) {
        console.warn(`[GraphitiContextProvider] remember failed: HTTP ${res.status}`);
        return;
      }
    } catch {
      // Non-fatal fire-and-forget
    } finally {
      clearTimeout(timer);
    }
  }
}
