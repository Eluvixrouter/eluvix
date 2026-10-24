import type { RequestScope } from '../context/types.js';
import type { ChatRequest, UpstreamConfig } from '../index.js';

export async function forwardMastraHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const base = upstream.endpoint.trim().replace(/\/+$/, '');
  const agentId = upstream.harness?.agentId || 'default';
  const action = request.stream ? 'stream' : 'generate';
  const url = `${base}/api/agents/${encodeURIComponent(agentId)}/${action}`;

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
    () => controller.abort(new DOMException(`Mastra harness timed out after ${timeoutMs}ms`, 'TimeoutError')),
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
      body: JSON.stringify({
        messages: request.messages,
        threadId: scope?.sessionId || `thread-${Date.now()}`,
        resourceId: scope?.userId || 'default'
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return new Response(
        JSON.stringify({
          error: {
            message: `Mastra harness error (${res.status}): ${errText}`,
            type: 'harness_error'
          }
        }),
        { status: res.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const modelId = request.model && request.model !== 'auto' ? request.model : `mastra/${agentId}`;
    const completionId = `chatcmpl-mastra-${Date.now()}`;

    const contentType = res.headers.get('content-type') || '';
    if (request.stream && contentType.includes('text/event-stream') && res.body) {
      return new Response(res.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'x-eluvix-model': modelId,
          'x-eluvix-harness': 'mastra'
        }
      });
    }

    const data: any = await res.json();
    const content = String(
      data?.text ||
        data?.response ||
        data?.content ||
        data?.choices?.[0]?.message?.content ||
        ''
    );

    if (request.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
              })}\n\n`
            )
          );
          ctrl.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
              })}\n\n`
            )
          );
          ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
          ctrl.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'x-eluvix-model': modelId,
          'x-eluvix-harness': 'mastra'
        }
      });
    }

    return new Response(
      JSON.stringify({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop'
          }
        ],
        usage: data?.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-model': modelId,
          'x-eluvix-harness': 'mastra'
        }
      }
    );
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
