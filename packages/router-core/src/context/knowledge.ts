import type { ChatMessage } from '../index.js';
import {
  assertProviderEndpointAllowed,
  filterOwnedRecallItems,
  type KnowledgeBaseConfig,
  type RecallBlock,
  type RecallResult,
  type RequestScope
} from './types.js';
import { fetchWithSafeRedirects } from '../fetch-policy.js';

export const KNOWLEDGE_BLOCK_START = '<eluvix-knowledge>';
export const KNOWLEDGE_BLOCK_END = '</eluvix-knowledge>';

export async function recallKnowledgeBase(
  query: string,
  config: KnowledgeBaseConfig | undefined,
  scope: RequestScope,
  signal?: AbortSignal
): Promise<RecallResult> {
  const start = Date.now();
  if (!config?.enabled || !query.trim()) {
    return { blocks: [], tokenEstimate: 0, provider: 'none', latencyMs: 0 };
  }

  const backend = config.backend || 'openviking-resources';
  const topK = Math.max(1, Math.min(20, config.topK ?? 4));
  const maxTokens = Math.max(100, config.maxTokens ?? 1000);
  const collectionUri = config.collectionUri || 'viking://resources/repo-docs';

  // Hunt-3 B-L5: refuse remote plaintext endpoints before any fetch,
  // mirroring the memory providers. Validated here — not inside the
  // try below — so a refused endpoint fails loudly instead of returning
  // an empty recall that looks like "no results".
  const endpoint =
    backend === 'lightrag'
      ? (config.endpoint || 'http://localhost:9621').replace(/\/+$/, '')
      : (config.endpoint || 'http://localhost:1933').replace(/\/+$/, '');
  if (backend !== 'local-fts') {
    assertProviderEndpointAllowed(endpoint, 'KnowledgeBase');
  }

  // Hunt-3 B-M4: time-box recall like the memory providers
  // (recallTimeoutMs, default 1500ms) and forward the caller signal
  // into the same controller — a hung knowledge server must not stall
  // the chat turn indefinitely.
  const timeoutMs = config.recallTimeoutMs ?? 1500;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return { blocks: [], tokenEstimate: 0, provider: backend, latencyMs: 0 };
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    if (backend === 'openviking-resources') {
      const res = await fetchWithSafeRedirects(`${endpoint}/api/v1/search/find`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          target_uri: collectionUri,
          limit: topK,
          level: 'L1'
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        return { blocks: [], tokenEstimate: 0, provider: backend, latencyMs: Date.now() - start };
      }
      const data: any = await res.json();
      const allItems: any[] = Array.isArray(data?.result?.memories)
        ? data.result.memories
        : Array.isArray(data?.memories)
        ? data.memories
        : Array.isArray(data?.results)
        ? data.results
        : [];
      // Hunt-3 B-M3: never trust the server to have scoped the results
      // to the requesting user (audit H-9, mirroring mem0). Entries
      // with no owner field are kept (shared repo-docs carry none).
      const items = filterOwnedRecallItems(allItems, scope.userId || 'default', 'KnowledgeBase');
      const blocks: RecallBlock[] = [];
      let used = 0;
      for (const item of items.slice(0, topK)) {
        let text = String(item.overview || item.content || item.abstract || item.text || '').trim();
        if (!text) continue;
        const est = Math.ceil(text.length / 4);
        if (used + est > maxTokens) {
          const remainingTokens = Math.max(0, maxTokens - used);
          if (remainingTokens <= 10 && blocks.length > 0) break;
          text = text.slice(0, Math.max(100, remainingTokens * 4));
        }
        const finalEst = Math.ceil(text.length / 4);
        used += finalEst;
        blocks.push({
          uri: item.uri || collectionUri,
          text,
          score: typeof item.score === 'number' ? item.score : 0.85,
          level: 'L1'
        });
        if (used >= maxTokens) break;
      }
      return { blocks, tokenEstimate: used, provider: backend, latencyMs: Date.now() - start };
    }

    if (backend === 'lightrag') {
      const res = await fetchWithSafeRedirects(`${endpoint}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          mode: 'hybrid',
          only_need_context: true
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        return { blocks: [], tokenEstimate: 0, provider: backend, latencyMs: Date.now() - start };
      }
      const data: any = await res.json();
      const blocks: RecallBlock[] = [];
      let used = 0;
      // Hunt-3 B-M3: same ownership filter as the resources backend.
      // The synthesized `data.response` string below has no per-item
      // owner to check and is left as-is.
      const rawResults = Array.isArray(data?.results)
        ? filterOwnedRecallItems(data.results, scope.userId || 'default', 'KnowledgeBase')
        : [];
      if (rawResults.length > 0) {
        for (const r of rawResults.slice(0, topK)) {
          let text = String(r.text || r.content || '').trim();
          if (!text) continue;
          const est = Math.ceil(text.length / 4);
          if (used + est > maxTokens) {
            const remainingTokens = Math.max(0, maxTokens - used);
            if (remainingTokens <= 10 && blocks.length > 0) break;
            text = text.slice(0, Math.max(100, remainingTokens * 4));
          }
          const finalEst = Math.ceil(text.length / 4);
          used += finalEst;
          blocks.push({
            uri: r.source || collectionUri,
            text,
            score: typeof r.score === 'number' ? r.score : 0.8,
            level: 'L1'
          });
          if (used >= maxTokens) break;
        }
      } else if (typeof data?.response === 'string' && data.response.trim()) {
        const sliced = data.response.trim().slice(0, maxTokens * 4);
        used = Math.ceil(sliced.length / 4);
        blocks.push({ uri: collectionUri, text: sliced, score: 0.85, level: 'L1' });
      }
      return { blocks, tokenEstimate: used, provider: backend, latencyMs: Date.now() - start };
    }

    // backend === 'local-fts': query builtin FTS5 store scoped to collectionUri
    const { BuiltinContextProvider } = await import('./builtin.js');
    const builtin = new BuiltinContextProvider();
    return await builtin.recall(query, { ...scope, userId: collectionUri }, maxTokens);
  } catch {
    return { blocks: [], tokenEstimate: 0, provider: backend, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

export function escapeKnowledgeBlockText(text: string): string {
  return text.replace(/<\s*(\/?)\s*eluvix-knowledge\b[^>]*>/gi, (_match, slash) => {
    return slash ? '&lt;/eluvix-knowledge&gt;' : '&lt;eluvix-knowledge&gt;';
  });
}

export function formatKnowledgeSystemBlock(
  blocks: RecallBlock[],
  config?: KnowledgeBaseConfig
): string {
  if (!blocks || blocks.length === 0) return '';
  const includeCitations = config?.citationMode !== 'silent';
  const body = blocks
    .map((b, idx) => {
      const safeUri = b.uri ? escapeKnowledgeBlockText(b.uri) : '';
      const header =
        includeCitations && safeUri ? `[Doc ${idx + 1}] (${safeUri})` : `[Doc ${idx + 1}]`;
      const safeText = escapeKnowledgeBlockText(b.text);
      return `${header}\n${safeText}`;
    })
    .join('\n\n');
  return `${KNOWLEDGE_BLOCK_START}\nReference knowledge from ${config?.collectionUri || 'Knowledge Base'}:\n${body}\n${KNOWLEDGE_BLOCK_END}`;
}

export function injectKnowledgeIntoMessages(
  messages: ChatMessage[],
  knowledgeBlock: string
): ChatMessage[] {
  if (!knowledgeBlock) return messages;
  const cloned = messages.map((m) => ({ ...m }));
  const firstSysIdx = cloned.findIndex((m) => m.role === 'system' && typeof m.content === 'string');
  if (firstSysIdx >= 0) {
    cloned[firstSysIdx] = {
      ...cloned[firstSysIdx],
      content: `${cloned[firstSysIdx].content}\n\n${knowledgeBlock}`
    };
    return cloned;
  }
  return [{ role: 'system', content: knowledgeBlock }, ...cloned];
}

export function stripKnowledgeFromMessages(messages: ChatMessage[]): ChatMessage[] {
  const regex = new RegExp(`${KNOWLEDGE_BLOCK_START}[\\s\\S]*?${KNOWLEDGE_BLOCK_END}\\s*`, 'g');
  const result: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' && typeof m.content === 'string' && m.content.includes(KNOWLEDGE_BLOCK_START)) {
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

