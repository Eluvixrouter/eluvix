import type { ChatMessage } from '../index.js';
import type { ContextProvider, MemoryConfig, RecallBlock, RecallResult, RequestScope } from './types.js';

export class CogneeContextProvider implements ContextProvider {
  public readonly id = 'cognee';
  private endpoint: string;
  private apiKey?: string;

  constructor(config?: MemoryConfig) {
    this.endpoint = (config?.endpoint || 'http://localhost:8005').replace(/\/+$/, '');
    this.apiKey = config?.apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  public async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/health`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }

  public async recall(
    query: string,
    scope: RequestScope,
    budgetTokens: number,
    signal?: AbortSignal
  ): Promise<RecallResult> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.endpoint}/api/v1/search`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          query_params: { query, search_type: 'INSIGHTS' },
          datasets: [`user_${scope.userId || 'default'}`]
        }),
        signal
      });
      if (!res.ok) {
        return { blocks: [], tokenEstimate: 0, provider: this.id, latencyMs: Date.now() - start };
      }
      const data: any = await res.json();
      const items: any[] = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
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
    }
  }

  public async remember(
    turn: { user: ChatMessage; assistant: string },
    scope: RequestScope
  ): Promise<void> {
    try {
      const userContent =
        typeof turn.user.content === 'string' ? turn.user.content : JSON.stringify(turn.user.content);
      await fetch(`${this.endpoint}/api/v1/add`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          dataset_name: `user_${scope.userId || 'default'}`,
          data: `User: ${userContent}\nAssistant: ${turn.assistant}`
        })
      });
    } catch {
      // Non-fatal
    }
  }

  public async commit(scope: RequestScope): Promise<void> {
    try {
      await fetch(`${this.endpoint}/api/v1/cognify`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          datasets: [`user_${scope.userId || 'default'}`]
        })
      });
    } catch {
      // Non-fatal
    }
  }
}
