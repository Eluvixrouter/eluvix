import type { ChatMessage } from '../index.js';
import type { ContextProvider, MemoryConfig, RecallBlock, RecallResult, RequestScope } from './types.js';

export class LightRagContextProvider implements ContextProvider {
  public readonly id = 'lightrag';
  private endpoint: string;
  private apiKey?: string;

  constructor(config?: MemoryConfig) {
    this.endpoint = (config?.endpoint || 'http://localhost:9621').replace(/\/+$/, '');
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
