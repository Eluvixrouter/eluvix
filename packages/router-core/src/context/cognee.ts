import type { ChatMessage } from '../index.js';
import type { ContextProvider, MemoryConfig, RecallBlock, RecallResult, RequestScope } from './types.js';

function isLocalEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    const h = u.hostname.toLowerCase();
    return (
      h === 'localhost' ||
      h === '127.0.0.1' ||
      h === '::1' ||
      h.endsWith('.local') ||
      h.endsWith('.internal') ||
      h.startsWith('eluvix-') ||
      h === 'cognee' ||
      /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}

export class CogneeContextProvider implements ContextProvider {
  public readonly id = 'cognee';
  private endpoint: string;
  private apiKey?: string;

  constructor(config?: MemoryConfig) {
    this.endpoint = (config?.endpoint || 'http://localhost:8005').replace(/\/+$/, '');
    this.apiKey = config?.apiKey;
  }

  public isLocal(): boolean {
    return isLocalEndpoint(this.endpoint);
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
        const text = String(item.text || item.content || item.summary || '').trim();
        if (!text) continue;
        const est = Math.ceil(text.length / 4);
        if (usedTokens + est > budgetTokens && blocks.length > 0) break;
        usedTokens += est;
        blocks.push({
          uri: item.id ? `cognee://${scope.userId}/${item.id}` : `cognee://${scope.userId}`,
          text,
          score: typeof item.score === 'number' ? item.score : 0.8,
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
