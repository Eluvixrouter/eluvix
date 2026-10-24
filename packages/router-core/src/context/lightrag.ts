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
      h === 'lightrag' ||
      /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}

export class LightRagContextProvider implements ContextProvider {
  public readonly id = 'lightrag';
  private endpoint: string;
  private apiKey?: string;

  constructor(config?: MemoryConfig) {
    this.endpoint = (config?.endpoint || 'http://localhost:9621').replace(/\/+$/, '');
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
      const res = await fetch(`${this.endpoint}/query`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          query,
          mode: 'hybrid',
          only_need_context: true,
          user_id: scope.userId
        }),
        signal
      });
      if (!res.ok) {
        return { blocks: [], tokenEstimate: 0, provider: this.id, latencyMs: Date.now() - start };
      }
      const data: any = await res.json();
      const blocks: RecallBlock[] = [];
      let usedTokens = 0;

      if (Array.isArray(data?.results) && data.results.length > 0) {
        for (const r of data.results) {
          const text = String(r.text || r.content || '').trim();
          if (!text) continue;
          const est = Math.ceil(text.length / 4);
          if (usedTokens + est > budgetTokens && blocks.length > 0) break;
          usedTokens += est;
          blocks.push({
            uri: r.source || `lightrag://${scope.userId}/chunk`,
            text,
            score: typeof r.score === 'number' ? r.score : 0.8,
            level: 'L1'
          });
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
    }
  }

  public async remember(
    turn: { user: ChatMessage; assistant: string },
    scope: RequestScope
  ): Promise<void> {
    try {
      const userContent =
        typeof turn.user.content === 'string' ? turn.user.content : JSON.stringify(turn.user.content);
      const formatted = `User (${scope.userId}): ${userContent}\nAssistant: ${turn.assistant}`;
      await fetch(`${this.endpoint}/texts`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          texts: [formatted],
          file_source: `session:${scope.userId}:${scope.sessionId || 'default'}`
        })
      });
    } catch {
      // Non-fatal fire-and-forget
    }
  }
}
