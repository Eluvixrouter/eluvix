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
      const header = b.uri ? `[${idx + 1}] (${b.level || 'L1'}) ${b.uri}` : `[${idx + 1}] (${b.level || 'L1'})`;
      return `${header}\n${b.text}`;
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
