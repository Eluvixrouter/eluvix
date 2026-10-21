import { addMemoryItem, searchMemoryItems } from '../db.js';
import type { ChatMessage } from '../index.js';
import type { ContextProvider, RecallBlock, RecallResult, RequestScope } from './types.js';

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

export class BuiltinContextProvider implements ContextProvider {
  public readonly id = 'builtin';

  public isLocal(): boolean {
    return true;
  }

  public async health(): Promise<boolean> {
    return true;
  }

  public async recall(
    query: string,
    scope: RequestScope,
    budgetTokens: number
  ): Promise<RecallResult> {
    const start = Date.now();
    const trimmed = (query || '').trim();
    if (!trimmed) {
      return { blocks: [], tokenEstimate: 0, provider: this.id, latencyMs: 0 };
    }

    const items = searchMemoryItems(trimmed, scope.userId || 'default', 10);
    const blocks: RecallBlock[] = [];
    let usedTokens = 0;
    const maxTokens = Math.max(64, budgetTokens || 800);

    for (const item of items) {
      const est = Math.max(1, Math.ceil(item.content.length / 4));
      if (usedTokens + est > maxTokens) {
        if (blocks.length === 0) {
          // Truncate single oversized item to fit budget
          const allowedChars = maxTokens * 4;
          const sliced = item.content.slice(0, allowedChars);
          blocks.push({
            uri: item.uri || `viking://user/${scope.userId}/memories/${item.id}`,
            text: sliced,
            score: item.score,
            level: item.level || 'L1'
          });
          usedTokens += Math.ceil(sliced.length / 4);
        }
        break;
      }
      blocks.push({
        uri: item.uri || `viking://user/${scope.userId}/memories/${item.id}`,
        text: item.content,
        score: item.score,
        level: item.level || 'L1'
      });
      usedTokens += est;
    }

    return {
      blocks,
      tokenEstimate: usedTokens,
      provider: this.id,
      latencyMs: Date.now() - start
    };
  }

  public async remember(
    turn: { user: ChatMessage; assistant: string },
    scope: RequestScope
  ): Promise<void> {
    const userText = extractText(turn.user).trim();
    const assistantText = (turn.assistant || '').trim();
    if (!userText && !assistantText) return;

    // Synthesize a concise L1 memory summary from the turn
    const summary =
      assistantText.length > 600
        ? `User: ${userText.slice(0, 300)}\nAssistant: ${assistantText.slice(0, 600)}...`
        : `User: ${userText.slice(0, 300)}\nAssistant: ${assistantText}`;

    addMemoryItem({
      userId: scope.userId || 'default',
      sessionId: scope.sessionId,
      uri: `viking://user/${scope.userId || 'default'}/memories/${Date.now()}`,
      level: 'L1',
      content: summary,
      metadata: {
        origin: scope.origin,
        agentId: scope.agentId
      }
    });
  }
}
