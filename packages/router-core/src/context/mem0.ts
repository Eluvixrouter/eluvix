import type { ChatMessage } from '../index.js';
import type { ContextProvider, MemoryConfig, RecallBlock, RecallResult, RequestScope } from './types.js';

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

export class Mem0ContextProvider implements ContextProvider {
  public readonly id = 'mem0';
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(config: MemoryConfig = {}) {
    this.endpoint = (config.endpoint || 'http://127.0.0.1:8888').trim().replace(/\/+$/, '');
    this.apiKey = config.apiKey || process.env.MEM0_API_KEY;
    this.timeoutMs = config.recallTimeoutMs ?? 1500;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (this.apiKey) {
      headers['Authorization'] = `Token ${this.apiKey}`;
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
      const res = await fetch(`${this.endpoint}/v1/memories/search/`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          query: trimmed,
          user_id: scope.userId || 'default',
          agent_id: scope.agentId,
          run_id: scope.sessionId,
          limit: 8
        }),
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`Mem0 search returned HTTP ${res.status}`);
      }

      const data: any = await res.json();
      const rawItems: any[] = Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data)
        ? data
        : [];

      const blocks: RecallBlock[] = [];
      let usedTokens = 0;
      const maxTokens = Math.max(64, budgetTokens || 800);

      for (const entry of rawItems) {
        const text = String(entry?.memory || entry?.text || entry?.content || '').trim();
        if (!text) continue;
        const est = Math.max(1, Math.ceil(text.length / 4));
        if (usedTokens + est > maxTokens) {
          if (blocks.length === 0) {
            const sliced = text.slice(0, maxTokens * 4);
            blocks.push({
              uri: entry?.id ? `mem0://${entry.id}` : undefined,
              text: sliced,
              score: typeof entry?.score === 'number' ? entry.score : undefined,
              level: 'L1'
            });
            usedTokens += Math.ceil(sliced.length / 4);
          }
          break;
        }
        blocks.push({
          uri: entry?.id ? `mem0://${entry.id}` : undefined,
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
    turn: { user: ChatMessage; assistant: string },
    scope: RequestScope
  ): Promise<void> {
    const userText = extractText(turn.user).trim();
    const assistantText = (turn.assistant || '').trim();
    if (!userText && !assistantText) return;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(`${this.endpoint}/v1/memories/`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          user_id: scope.userId || 'default',
          agent_id: scope.agentId,
          run_id: scope.sessionId,
          messages: [
            { role: 'user', content: userText },
            { role: 'assistant', content: assistantText }
          ]
        }),
        signal: controller.signal
      });
    } catch {
      // Fail open
    } finally {
      clearTimeout(timer);
    }
  }
}
