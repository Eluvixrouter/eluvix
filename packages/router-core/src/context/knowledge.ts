import type { ChatMessage } from '../index.js';
import type { KnowledgeBaseConfig, RecallBlock, RecallResult, RequestScope } from './types.js';

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

  try {
    if (backend === 'openviking-resources') {
      const endpoint = (config.endpoint || 'http://localhost:1933').replace(/\/+$/, '');
      const res = await fetch(`${endpoint}/api/v1/search/find`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          target_uri: collectionUri,
          limit: topK,
          level: 'L1'
        }),
        signal
      });
      if (!res.ok) {
        return { blocks: [], tokenEstimate: 0, provider: backend, latencyMs: Date.now() - start };
      }
      const data: any = await res.json();
      const items: any[] = Array.isArray(data?.result?.memories)
        ? data.result.memories
        : Array.isArray(data?.memories)
        ? data.memories
        : Array.isArray(data?.results)
        ? data.results
        : [];
      const blocks: RecallBlock[] = [];
      let used = 0;
      for (const item of items.slice(0, topK)) {
        const text = String(item.overview || item.content || item.abstract || item.text || '').trim();
        if (!text) continue;
        const est = Math.ceil(text.length / 4);
        if (used + est > maxTokens && blocks.length > 0) break;
        used += est;
        blocks.push({
          uri: item.uri || collectionUri,
          text,
          score: typeof item.score === 'number' ? item.score : 0.85,
          level: 'L1'
        });
      }
      return { blocks, tokenEstimate: used, provider: backend, latencyMs: Date.now() - start };
    }

    if (backend === 'lightrag') {
      const endpoint = (config.endpoint || 'http://localhost:9621').replace(/\/+$/, '');
      const res = await fetch(`${endpoint}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          mode: 'hybrid',
          only_need_context: true
        }),
        signal
      });
      if (!res.ok) {
        return { blocks: [], tokenEstimate: 0, provider: backend, latencyMs: Date.now() - start };
      }
      const data: any = await res.json();
      const blocks: RecallBlock[] = [];
      let used = 0;
      if (Array.isArray(data?.results)) {
        for (const r of data.results.slice(0, topK)) {
          const text = String(r.text || r.content || '').trim();
          if (!text) continue;
          const est = Math.ceil(text.length / 4);
          if (used + est > maxTokens && blocks.length > 0) break;
          used += est;
          blocks.push({
            uri: r.source || collectionUri,
            text,
            score: typeof r.score === 'number' ? r.score : 0.8,
            level: 'L1'
          });
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
  }
}

export function formatKnowledgeSystemBlock(
  blocks: RecallBlock[],
  config?: KnowledgeBaseConfig
): string {
  if (!blocks || blocks.length === 0) return '';
  const includeCitations = config?.citationMode !== 'silent';
  const body = blocks
    .map((b, idx) => {
      const header =
        includeCitations && b.uri ? `[Doc ${idx + 1}] (${b.uri})` : `[Doc ${idx + 1}]`;
      return `${header}\n${b.text}`;
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
