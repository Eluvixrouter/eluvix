import type { ChatMessage } from '../index.js';

/** Extract the plain text of a single chat message (string or text parts). */
export function messageText(msg: ChatMessage | undefined): string {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(p => p.type === 'text')
      .map(p => (p as { type: 'text'; text: string }).text)
      .join('\n');
  }
  return '';
}

/**
 * Build the single text prompt handed to a harness agent.
 *
 * System messages (which carry the injected <eluvix-memory> block) are always
 * included, on every turn — previously only the last user message was sent,
 * so recalled memories, the system prompt, history, and tools never reached
 * opencode/ACP agents at all.
 *
 * When `includeHistory` is true (stateless/per-request mode, a freshly
 * created server-side session, or an inherently per-request transport like
 * ACP), the prior conversation turns are folded in as a labeled transcript
 * so the agent sees the full conversation. When false (a persistent
 * server-side session that already holds the earlier turns), only the system
 * context plus the latest user message are sent.
 */
export function buildHarnessPrompt(
  messages: ChatMessage[],
  options: { includeHistory: boolean }
): string {
  const list = Array.isArray(messages) ? messages : [];
  const systemParts = list
    .filter(m => m.role === 'system')
    .map(m => messageText(m))
    .filter(t => t.trim().length > 0);
  const convo = list.filter(m => m.role !== 'system');

  const sections: string[] = [];
  if (systemParts.length > 0) {
    sections.push(systemParts.join('\n\n'));
  }

  if (options.includeHistory) {
    if (convo.length > 0) {
      const transcript = convo
        .map(m => {
          const label =
            m.role === 'user'
              ? 'User'
              : m.role === 'assistant'
              ? 'Assistant'
              : m.role === 'tool'
              ? 'Tool'
              : m.role;
          return `${label}: ${messageText(m)}`;
        })
        .join('\n\n');
      sections.push(transcript);
    }
  } else {
    const lastUser = [...convo].reverse().find(m => m.role === 'user') || convo[convo.length - 1];
    const text = messageText(lastUser);
    if (text) sections.push(text);
  }

  return sections.join('\n\n');
}

/**
 * Decide whether a failed harness turn failed because the cached server-side
 * session no longer exists (server restart, session expiry). A 404/410 on a
 * session-scoped request is the canonical signal; for other error statuses
 * the body is peeked at (via a clone, leaving the original response intact)
 * for an explicit session-not-found message.
 */
export async function isSessionGoneResponse(res: Response): Promise<boolean> {
  if (res.status === 404 || res.status === 410) return true;
  if (res.status >= 400) {
    try {
      const text = await res.clone().text();
      return /session[^a-z0-9]{0,4}(not found|does not exist|expired|unknown)|unknown session|no such session/i.test(
        text
      );
    } catch {
      return false;
    }
  }
  return false;
}
