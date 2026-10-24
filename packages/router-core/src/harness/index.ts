export * from './types.js';
export * from './trueforge.js';
export * from './opencode.js';
export * from './acp.js';
export * from './openhands.js';
export * from './mastra.js';
export * from './letta.js';
export * from './a2a.js';

import type { RequestScope } from '../context/types.js';
import type { ChatRequest, UpstreamConfig } from '../index.js';
import { forwardA2aHarness } from './a2a.js';
import { forwardAcpHarness } from './acp.js';
import { forwardLettaHarness } from './letta.js';
import { forwardMastraHarness } from './mastra.js';
import { forwardOpencodeHarness } from './opencode.js';
import { forwardOpenHandsHarness } from './openhands.js';
import { forwardTrueForgeHarness } from './trueforge.js';

export async function forwardHarnessRequest(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const kind = upstream.harness?.kind || 'trueforge';
  if (kind === 'trueforge') {
    return forwardTrueForgeHarness(upstream, request, timeoutMs, clientSignal, scope, hops);
  }
  if (kind === 'opencode') {
    return forwardOpencodeHarness(upstream, request, timeoutMs, clientSignal, scope, hops);
  }
  if (kind === 'acp') {
    return forwardAcpHarness(upstream, request, timeoutMs, clientSignal, scope, hops);
  }
  if (kind === 'openhands') {
    return forwardOpenHandsHarness(upstream, request, timeoutMs, clientSignal, scope, hops);
  }
  if (kind === 'mastra') {
    return forwardMastraHarness(upstream, request, timeoutMs, clientSignal, scope, hops);
  }
  if (kind === 'letta') {
    return forwardLettaHarness(upstream, request, timeoutMs, clientSignal, scope, hops);
  }
  if (kind === 'a2a') {
    return forwardA2aHarness(upstream, request, timeoutMs, clientSignal, scope, hops);
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
