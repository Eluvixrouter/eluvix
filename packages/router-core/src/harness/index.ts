export * from './types.js';
export * from './trueforge.js';
export * from './opencode.js';
export * from './acp.js';

import type { RequestScope } from '../context/types.js';
import type { ChatRequest, UpstreamConfig } from '../index.js';
import { forwardAcpHarness } from './acp.js';
import { forwardOpencodeHarness } from './opencode.js';
import { forwardTrueForgeHarness } from './trueforge.js';
import type { HarnessKind } from './types.js';

/**
 * Resolve the harness kind for an upstream. An explicit `harness.kind`
 * always wins. When the harness block (or its kind) is absent — e.g. a
 * hand-edited or API-written config — the kind is inferred from the
 * endpoint scheme instead of blindly defaulting to TrueForge: `acp://`
 * (and `cli://` agent wrappers) route to the ACP stdio forwarder, HTTP(S)
 * endpoints route to the TrueForge REST forwarder. This matches the
 * inference the router's model detection already applies.
 */
export function resolveHarnessKind(upstream: UpstreamConfig): HarnessKind {
  if (upstream.harness?.kind) {
    return upstream.harness.kind;
  }
  const endpoint = (upstream.endpoint || '').trim().toLowerCase();
  if (endpoint.startsWith('acp://') || endpoint.startsWith('cli://')) {
    return 'acp';
  }
  return 'trueforge';
}

export async function forwardHarnessRequest(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const kind = resolveHarnessKind(upstream);
  if (kind === 'trueforge') {
    return forwardTrueForgeHarness(upstream, request, timeoutMs, clientSignal, scope, hops);
  }
  if (kind === 'opencode') {
    return forwardOpencodeHarness(upstream, request, timeoutMs, clientSignal, scope, hops);
  }
  if (kind === 'acp') {
    return forwardAcpHarness(upstream, request, timeoutMs, clientSignal, scope, hops);
  }

  // kind === 'hermes': OpenAI-compatible HTTP endpoint with origin + hop headers
  const trimmed = upstream.endpoint.trim().replace(/\/+$/, '');
  const url = trimmed.endsWith('/v1')
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-eluvix-origin': 'harness',
    'x-eluvix-hops': String(hops + 1)
  };
  if (upstream.apiKey) {
    headers['Authorization'] = `Bearer ${upstream.apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Hermes harness timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs
  );
  if (clientSignal) {
    if (clientSignal.aborted) {
      clearTimeout(timer);
      throw new DOMException('Client aborted request', 'AbortError');
    }
    clientSignal.addEventListener('abort', () => controller.abort(clientSignal.reason), { once: true });
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal: controller.signal
    });
    clearTimeout(timer);
    const resHeaders = new Headers(res.headers);
    resHeaders.set('x-eluvix-model', request.model || 'hermes-agent');
    resHeaders.set('x-eluvix-harness', 'hermes');
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
