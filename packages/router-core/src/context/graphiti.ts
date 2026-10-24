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
      h === 'graphiti' ||
      /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}

export class GraphitiContextProvider implements ContextProvider {
  public readonly id = 'graphiti';
  private endpoint: string;
  private apiKey?: string;

  constructor(config?: MemoryConfig) {
    this.endpoint = (config?.endpoint || 'http://localhost:8004').replace(/\/+$/, '');
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
      const res = await fetch(`${this.endpoint}/search`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          group_id: scope.userId || 'default',
          query,
          max_facts: 10
        }),
        signal
      });
      if (!res.ok) {
        return { blocks: [], tokenEstimate: 0, provider: this.id, latencyMs: Date.now() - start };
      }
      const data: any = await res.json();
      const rawFacts: any[] = Array.isArray(data?.facts)
        ? data.facts
        : Array.isArray(data?.edges)
        ? data.edges
        : Array.isArray(data)
        ? data
        : [];

      const blocks: RecallBlock[] = [];
      let usedTokens = 0;

      for (const item of rawFacts) {
        const factText = String(item.fact || item.summary || item.content || '').trim();
        if (!factText) continue;
        const validWindow = item.valid_at
          ? ` [valid: ${item.valid_at}${item.invalid_at ? ` .. ${item.invalid_at}` : ' .. present'}]`
          : '';
        const formatted = `${factText}${validWindow}`;
        const est = Math.ceil(formatted.length / 4);
        if (usedTokens + est > budgetTokens && blocks.length > 0) break;
        usedTokens += est;
        blocks.push({
          uri: item.uuid ? `graphiti://${scope.userId}/${item.uuid}` : `graphiti://${scope.userId}`,
          text: formatted,
          score: typeof item.score === 'number' ? item.score : 0.85,
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
      await fetch(`${this.endpoint}/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          group_id: scope.userId || 'default',
          messages: [
            { role: 'user', content: userContent, timestamp: new Date().toISOString() },
            { role: 'assistant', content: turn.assistant, timestamp: new Date().toISOString() }
          ]
        })
      });
    } catch {
      // Non-fatal fire-and-forget
    }
  }
}
