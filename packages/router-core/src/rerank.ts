/**
 * Cross-Encoder & Sovereign Lexical/Cosine Reranker (`/v1/rerank`).
 *
 * Compatible with Cohere, Jina AI, and vLLM `/v1/rerank` wire payloads:
 * `{ model, query, documents, top_n, return_documents }` ->
 * `{ id, model, results: [{ index, relevance_score, document? }], usage }`.
 *
 * Scrubs `query` and `documents` through `PrivacyGuard` when enabled, forwards to
 * any configured rerank-capable HTTP upstream (with SSRF validation), or falls back
 * to a deterministic BM25 + token-overlap local sovereign scorer when `model: 'auto'`
 * or local fallback is active.
 */

import { applyPrivacyGuard, type PrivacyGuardConfig } from './guard.js';
import { validateUpstreamHttpEndpoint } from './ssrf-guard.js';
import { resolveUpstreamSecret } from './secrets.js';
import { logRequest } from './db.js';
import { estimateUpstreamRequestCostUsd } from './cost.js';
import type { RouterConfig, UpstreamConfig } from './index.js';

export interface RerankRequest {
  model?: string;
  query: string;
  documents: Array<string | { text: string; [k: string]: any }>;
  top_n?: number;
  return_documents?: boolean;
}

export interface RerankResultItem {
  index: number;
  relevance_score: number;
  document?: { text: string; [k: string]: any };
}

export interface RerankResponsePayload {
  id: string;
  model: string;
  results: RerankResultItem[];
  usage: {
    total_tokens: number;
    search_units?: number;
  };
}

function tokenizeText(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Computes a normalized `[0, 1]` lexical + BM25 + bigram overlap relevance score
 * for sovereign local fallback when no external cross-encoder HTTP server is reachable.
 */
export function computeLocalSovereignRerankScore(query: string, docText: string): number {
  const qTokens = tokenizeText(query);
  const dTokens = tokenizeText(docText);
  if (qTokens.length === 0 || dTokens.length === 0) return 0;

  const dFreq = new Map<string, number>();
  for (const t of dTokens) {
    dFreq.set(t, (dFreq.get(t) || 0) + 1);
  }

  let matchedWeight = 0;
  const k1 = 1.2;
  const b = 0.75;
  const avgDl = 32;

  for (const qt of qTokens) {
    const tf = dFreq.get(qt) || 0;
    if (tf > 0) {
      const bm25Term = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dTokens.length / avgDl)));
      matchedWeight += bm25Term;
    }
  }

  // Exact substring / phrase bonus
  const qNorm = qTokens.join(' ');
  const dNorm = dTokens.join(' ');
  const phraseBonus = qNorm.length >= 3 && dNorm.includes(qNorm) ? 0.35 : 0;

  const rawRatio = matchedWeight / (qTokens.length * 1.4) + phraseBonus;
  return Number(Math.max(0, Math.min(0.9999, rawRatio)).toFixed(6));
}

/**
 * Executes a `/v1/rerank` request across configured upstreams (or local sovereign scorer).
 */
export async function executeRerankRequest(
  config: RouterConfig,
  upstreams: UpstreamConfig[],
  request: RerankRequest,
  options?: {
    fetchImpl?: typeof fetch;
    userId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }
): Promise<Response> {
  if (!request || typeof request.query !== 'string' || !request.query.trim()) {
    return new Response(
      JSON.stringify({
        error: {
          message: 'Missing required parameter: "query" must be a non-empty string.',
          type: 'invalid_request_error',
          code: 'missing_query',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!Array.isArray(request.documents) || request.documents.length === 0) {
    return new Response(
      JSON.stringify({
        error: {
          message: 'Missing required parameter: "documents" must be a non-empty array.',
          type: 'invalid_request_error',
          code: 'missing_documents',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const normalizedDocs = request.documents.map((doc) => {
    if (typeof doc === 'string') return { text: doc };
    if (doc && typeof doc === 'object' && typeof doc.text === 'string') return { ...doc };
    return { text: String(doc ?? '') };
  });

  // Apply PrivacyGuard scrubbing before any outbound reranker call
  let effectiveQuery = request.query;
  let effectiveDocs = normalizedDocs;
  const privacyConfig: PrivacyGuardConfig | undefined = config.privacyGuard;
  if (privacyConfig?.enabled) {
    const qRes = applyPrivacyGuard([{ role: 'user', content: effectiveQuery }], privacyConfig);
    if (!qRes.passed) {
      return new Response(
        JSON.stringify({
          error: {
            message: qRes.reason || 'Rerank query blocked by Privacy Guard.',
            type: 'privacy_violation',
            code: 'pii_blocked',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    effectiveQuery = String(qRes.modifiedMessages[0]?.content ?? effectiveQuery);

    const dMsgs = effectiveDocs.map((d) => ({ role: 'user', content: d.text }));
    const dRes = applyPrivacyGuard(dMsgs, privacyConfig);
    if (!dRes.passed) {
      return new Response(
        JSON.stringify({
          error: {
            message: dRes.reason || 'Rerank document blocked by Privacy Guard.',
            type: 'privacy_violation',
            code: 'pii_blocked',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    effectiveDocs = effectiveDocs.map((d, idx) => ({
      ...d,
      text: String(dRes.modifiedMessages[idx]?.content ?? d.text),
    }));
  }

  const requestedModel = (request.model || 'auto').trim();
  const topN =
    typeof request.top_n === 'number' && request.top_n > 0
      ? Math.min(effectiveDocs.length, Math.floor(request.top_n))
      : effectiveDocs.length;
  const returnDocuments = request.return_documents !== false;

  const estTokens = Math.max(
    1,
    Math.ceil(
      (effectiveQuery.length + effectiveDocs.reduce((acc, d) => acc + d.text.length, 0)) / 4
    )
  );

  // Filter candidate HTTP upstreams that support rerank
  const candidates = (upstreams || []).filter((u) => {
    if (u.type === 'comfyui' || u.type === 'antigravity' || u.type === 'harness') return false;
    if (requestedModel !== 'auto') {
      if (u.models?.includes(requestedModel) || u.models?.includes('*')) return true;
    }
    return (
      u.capabilities?.includes('rerank') ||
      u.models?.some((m) => /rerank|bge-reranker|jina-reranker/i.test(m))
    );
  });

  const fetchFn = options?.fetchImpl || globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 15_000;

  for (const upstream of candidates) {
    const ssrf = validateUpstreamHttpEndpoint(upstream.endpoint, { allowLoopbackAndLan: true });
    if (!ssrf.ok) continue;

    const effectiveModel =
      requestedModel !== 'auto'
        ? requestedModel
        : upstream.models?.find((m) => /rerank/i.test(m)) ||
          upstream.models?.find((m) => m !== '*' && m !== 'auto') ||
          'bge-reranker-v2-m3';

    const trimmed = upstream.endpoint.trim().replace(/\/+$/, '');
    const url = trimmed.endsWith('/v1') ? `${trimmed}/rerank` : `${trimmed}/v1/rerank`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (upstream.apiKey) {
      const resolvedKey =
        (await resolveUpstreamSecret(upstream.apiKey, { fetchImpl: fetchFn })) || upstream.apiKey;
      headers['Authorization'] = `Bearer ${resolvedKey}`;
    }

    const startTime = Date.now();
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: effectiveModel,
          query: effectiveQuery,
          documents: effectiveDocs.map((d) => d.text),
          top_n: topN,
          return_documents: returnDocuments,
        }),
        signal: options?.signal || AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, any>;
      if (!Array.isArray(json.results)) continue;

      const formattedResults: RerankResultItem[] = json.results
        .map((item: any) => {
          const idx = Number(item.index ?? 0);
          const score = Number(item.relevance_score ?? item.score ?? 0);
          return {
            index: idx,
            relevance_score: score,
            ...(returnDocuments ? { document: effectiveDocs[idx] || { text: '' } } : {}),
          };
        })
        .sort((a: RerankResultItem, b: RerankResultItem) => b.relevance_score - a.relevance_score)
        .slice(0, topN);

      const duration_ms = Date.now() - startTime;
      const totalTokens = Number(json?.usage?.total_tokens ?? estTokens);
      const costUsd = estimateUpstreamRequestCostUsd(upstream, totalTokens, 0);

      try {
        logRequest({
          model: effectiveModel,
          upstream_id: upstream.id,
          status: 200,
          duration_ms,
          prompt_tokens: totalTokens,
          completion_tokens: 0,
          ttft_ms: duration_ms,
          cost_usd: costUsd,
          user_id: options?.userId || 'default',
        });
      } catch {}

      const responsePayload: RerankResponsePayload = {
        id: json.id || `rerank_${Date.now()}`,
        model: effectiveModel,
        results: formattedResults,
        usage: {
          total_tokens: totalTokens,
          search_units: 1,
        },
      };

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-upstream': upstream.id,
          'x-eluvix-rerank-model': effectiveModel,
          'x-eluvix-cost-usd': costUsd.toFixed(6),
        },
      });
    } catch {
      continue;
    }
  }

  // Deterministic local sovereign BM25 + token-overlap fallback
  const fallbackModel =
    requestedModel !== 'auto' ? requestedModel : 'eluvix-sovereign-rerank-v1';
  const scored: RerankResultItem[] = effectiveDocs
    .map((doc, index) => ({
      index,
      relevance_score: computeLocalSovereignRerankScore(effectiveQuery, doc.text),
      ...(returnDocuments ? { document: doc } : {}),
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
    .slice(0, topN);

  try {
    logRequest({
      model: fallbackModel,
      upstream_id: 'local-sovereign-rerank',
      status: 200,
      duration_ms: 1,
      prompt_tokens: estTokens,
      completion_tokens: 0,
      ttft_ms: 1,
      cost_usd: 0,
      user_id: options?.userId || 'default',
    });
  } catch {}

  const payload: RerankResponsePayload = {
    id: `rerank_local_${Date.now()}`,
    model: fallbackModel,
    results: scored,
    usage: {
      total_tokens: estTokens,
      search_units: 1,
    },
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-eluvix-upstream': 'local-sovereign-rerank',
      'x-eluvix-rerank-model': fallbackModel,
      'x-eluvix-cost-usd': '0.000000',
    },
  });
}
