export * from './types.js';
export * from './stream-tee.js';
export * from './builtin.js';
export * from './openviking.js';
export * from './mem0.js';

import type { ChatMessage } from '../index.js';
import { BuiltinContextProvider } from './builtin.js';
import { Mem0ContextProvider } from './mem0.js';
import { OpenVikingContextProvider } from './openviking.js';
import type { ContextProvider, MemoryConfig, RecallBlock } from './types.js';

export const MEMORY_BLOCK_START = '<eluvix-memory>';
export const MEMORY_BLOCK_END = '</eluvix-memory>';

/**
 * Escape the block delimiters inside recalled memory text (security audit
 * H-5). Memory text is stored, attacker-influenceable content: if it could
 * emit a literal `</eluvix-memory>`, it would terminate its own block
 * early — and in cloud-egress `strip` mode the non-greedy strip regex
 * would stop at that fake closing tag and forward the remaining text to
 * the cloud upstream. Escaping the angle brackets of any delimiter
 * occurrence makes the real closing tag the only literal one in the
 * formatted block. Applied at format time (per request), so memories
 * stored before this fix are covered too. The escaped form stays
 * human/model-readable as inert text.
 */
export function escapeMemoryBlockText(text: string): string {
  return text
    .split(MEMORY_BLOCK_END)
    .join('&lt;/eluvix-memory&gt;')
    .split(MEMORY_BLOCK_START)
    .join('&lt;eluvix-memory&gt;');
}

export function createContextProvider(config?: MemoryConfig): ContextProvider {
  const providerType = config?.provider || 'builtin';
  if (providerType === 'openviking') {
    return new OpenVikingContextProvider(config);
  }
  if (providerType === 'mem0') {
    return new Mem0ContextProvider(config);
  }
  return new BuiltinContextProvider();
}

export function formatMemorySystemBlock(blocks: RecallBlock[], providerId: string): string {
  if (!blocks || blocks.length === 0) return '';
  const body = blocks
    .map((b, idx) => {
      const header = b.uri ? `[${idx + 1}] (${b.level || 'L1'}) ${escapeMemoryBlockText(b.uri)}` : `[${idx + 1}] (${b.level || 'L1'})`;
      return `${header}\n${escapeMemoryBlockText(b.text)}`;
    })
    .join('\n\n');
  return `${MEMORY_BLOCK_START}\nRelevant context recalled from ${providerId} memory:\n${body}\n${MEMORY_BLOCK_END}`;
}

export function injectMemoryIntoMessages(messages: ChatMessage[], memoryBlock: string): ChatMessage[] {
  if (!memoryBlock) return messages;
  const cloned = messages.map(m => ({ ...m }));
  const firstSysIdx = cloned.findIndex(m => m.role === 'system' && typeof m.content === 'string');
  if (firstSysIdx >= 0) {
    cloned[firstSysIdx] = {
      ...cloned[firstSysIdx],
      content: `${memoryBlock}\n\n${cloned[firstSysIdx].content}`
    };
    return cloned;
  }
  return [{ role: 'system', content: memoryBlock }, ...cloned];
}

export function stripMemoryFromMessages(messages: ChatMessage[]): ChatMessage[] {
  // Blocks produced by formatMemorySystemBlock are delimiter-escaped
  // (audit H-5), so the only literal MEMORY_BLOCK_END in a system message
  // is the block's real closing tag and this non-greedy match spans
  // exactly one block. (Transcripts formatted by pre-fix code and
  // replayed by a client can still contain unescaped blocks; those are
  // stripped only up to their first closing tag, as before.)
  const regex = new RegExp(`${MEMORY_BLOCK_START}[\\s\\S]*?${MEMORY_BLOCK_END}\\s*`, 'g');
  const result: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' && typeof m.content === 'string' && m.content.includes(MEMORY_BLOCK_START)) {
      const cleaned = m.content.replace(regex, '').trim();
      if (cleaned.length > 0) {
        result.push({ ...m, content: cleaned });
      }
    } else {
      result.push(m);
    }
  }
  return result;
}
