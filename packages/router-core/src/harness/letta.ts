import type { RequestScope } from '../context/types.js';
import type { ChatRequest, UpstreamConfig } from '../index.js';

export async function forwardLettaHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const base = upstream.endpoint.trim().replace(/\/+$/, '');
  const agentId = upstream.harness?.agentId || 'default';
  const url = `${base}/v1/agents/${encodeURIComponent(agentId)}/messages`;

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
    () => controller.abort(new DOMException(`Letta harness timed out after ${timeoutMs}ms`, 'TimeoutError')),
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

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [{ role: 'user', content: promptText }],
        user_id: scope?.userId || 'default'
      }),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return new Response(
        JSON.stringify({
          error: {
            message: `Letta harness error (${res.status}): ${errText}`,
            type: 'harness_error'
          }
        }),
        { status: res.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const data: any = await res.json();
    const rawMessages: any[] = Array.isArray(data?.messages) ? data.messages : [];
    const surfaceTools = (upstream.harness?.approvalPolicy || upstream.harness?.approvals) === 'surface';

    const assistantParts: string[] = [];
    for (const msg of rawMessages) {
      const mType = msg.message_type || msg.role;
      if (mType === 'assistant_message' || mType === 'assistant') {
        if (typeof msg.content === 'string' && msg.content.trim()) {
          assistantParts.push(msg.content.trim());
        } else if (typeof msg.assistant_message === 'string' && msg.assistant_message.trim()) {
          assistantParts.push(msg.assistant_message.trim());
        }
      } else if (surfaceTools && mType === 'function_call') {
        assistantParts.push(`[Tool Call: ${msg.function_call?.name || 'tool'}]`);
      }
    }

    const content =
      assistantParts.length > 0
        ? assistantParts.join('\n\n')
        : String(data?.content || data?.response || '');

    const modelId = request.model && request.model !== 'auto' ? request.model : `letta/${agentId}`;
    const completionId = `chatcmpl-letta-${Date.now()}`;

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
          'x-eluvix-harness': 'letta'
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
          'x-eluvix-harness': 'letta'
        }
      }
    );
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
