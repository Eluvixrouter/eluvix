import type { ChatMessage } from '../index.js';
import type { ContextProvider, MemoryConfig, RecallBlock, RecallResult, RequestScope } from './types.js';

function isLocalEndpointUrl(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host === 'openviking' ||
      host === 'host.docker.internal' ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return true;
    }
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

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
    this.apiKey = config.apiKey || process.env.OPENVIKING_API_KEY;
    this.timeoutMs = config.recallTimeoutMs ?? 1500;
    this.autoCommitTurns = Math.max(1, config.autoCommitTurns ?? 5);
    this.readingLevel = config.openviking?.readingLevel || 'L1';
    this.scopePrefixes = config.openviking?.scopePrefixes;
  }

  public isLocal(): boolean {
    return isLocalEndpointUrl(this.endpoint);
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
    const targetUris =
      Array.isArray(this.scopePrefixes) && this.scopePrefixes.length > 0
        ? this.scopePrefixes
        : [`viking://user/${userId}/memories`];

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
      const rawItems: any[] = Array.isArray(data?.result?.memories)
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
      await fetch(`${this.endpoint}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
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

      const count = (this.turnCounts.get(sessionId) || 0) + 1;
      this.turnCounts.set(sessionId, count);
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
