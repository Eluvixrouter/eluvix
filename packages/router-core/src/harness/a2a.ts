import type { RequestScope } from '../context/types.js';
import type { ChatRequest, UpstreamConfig } from '../index.js';

export async function forwardA2aHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const base = upstream.endpoint.trim().replace(/\/+$/, '');
  const agentId = upstream.harness?.agentId || 'default';

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
    () => controller.abort(new DOMException(`A2A harness timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs
  );
  if (clientSignal) {
    if (clientSignal.aborted) {
      clearTimeout(timer);
      throw new DOMException('Client aborted request', 'AbortError');
    }
    clientSignal.addEventListener('abort', () => controller.abort(clientSignal.reason), { once: true });
  }

  const lastUserMsg =
    [...request.messages]
      .reverse()
      .find((m) => m.role === 'user')?.content || '';
  const promptText = typeof lastUserMsg === 'string' ? lastUserMsg : JSON.stringify(lastUserMsg);
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const sessionId = scope?.sessionId || `sess-${scope?.userId || 'default'}`;

  try {
    const rpcPayload = {
      jsonrpc: '2.0',
      id: taskId,
      method: 'tasks/send',
      params: {
        id: taskId,
        sessionId,
        agentId,
        message: {
          role: 'user',
          parts: [{ type: 'text', text: promptText }]
        }
      }
    };

    const res = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpcPayload),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return new Response(
        JSON.stringify({
          error: {
            message: `A2A harness error (${res.status}): ${errText}`,
            type: 'harness_error'
          }
        }),
        { status: res.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const rpcRes: any = await res.json();
    const taskResult = rpcRes?.result || rpcRes;

    const parts: string[] = [];
    // Extract from status.message.parts or artifacts
    const statusParts = taskResult?.status?.message?.parts;
    if (Array.isArray(statusParts)) {
      for (const p of statusParts) {
        if (typeof p.text === 'string' && p.text.trim()) parts.push(p.text.trim());
      }
    }
    if (Array.isArray(taskResult?.artifacts)) {
      for (const art of taskResult.artifacts) {
        if (Array.isArray(art.parts)) {
          for (const p of art.parts) {
            if (typeof p.text === 'string' && p.text.trim()) parts.push(p.text.trim());
          }
        }
      }
    }
    if (parts.length === 0 && typeof taskResult?.output === 'string') {
      parts.push(taskResult.output);
    }

    const content = parts.join('\n\n');
    const modelId = request.model && request.model !== 'auto' ? request.model : `a2a/${agentId}`;
    const completionId = `chatcmpl-a2a-${Date.now()}`;

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
          'x-eluvix-harness': 'a2a'
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
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-model': modelId,
          'x-eluvix-harness': 'a2a'
        }
      }
    );
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
