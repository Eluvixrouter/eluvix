import type { RequestScope } from '../context/types.js';
import type { ChatRequest, UpstreamConfig } from '../index.js';
import { setBounded } from '../bounded-map.js';
import { buildHarnessPrompt } from './prompt.js';

const openHandsSessionMap = new Map<string, string>();

export function clearOpenHandsSessionCache(): void {
  openHandsSessionMap.clear();
}

export async function forwardOpenHandsHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const base = upstream.endpoint.trim().replace(/\/+$/, '');
  const sessionMode = upstream.harness?.sessionMode || 'per-eluvix-session';
  const sessionKey = `${upstream.id}::${scope?.userId || 'default'}::${scope?.sessionId || 'stateless'}`;
  const reuseSession = sessionMode !== 'per-request' && Boolean(scope?.sessionId);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-eluvix-origin': 'harness',
    'x-eluvix-hops': String(hops + 1)
  };
  if (upstream.apiKey) {
    headers['Authorization'] = `Bearer ${upstream.apiKey}`;
  }
  if (upstream.harness?.sandboxEndpoint) {
    headers['x-eluvix-sandbox-endpoint'] = upstream.harness.sandboxEndpoint;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`OpenHands harness timed out after ${timeoutMs}ms`, 'TimeoutError')),
    timeoutMs
  );
  if (clientSignal) {
    if (clientSignal.aborted) {
      clearTimeout(timer);
      throw new DOMException('Client aborted request', 'AbortError');
    }
    clientSignal.addEventListener('abort', () => controller.abort(clientSignal.reason), { once: true });
  }

  const promptText = buildHarnessPrompt(request.messages, { includeHistory: true });

  try {
    let conversationId = reuseSession ? openHandsSessionMap.get(sessionKey) : undefined;
    let usedCached = Boolean(conversationId);

    const createConversation = async (): Promise<string> => {
      const res = await fetch(`${base}/api/conversations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agent_cls: upstream.harness?.agentId || 'CodeActAgent'
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        throw new Error(`OpenHands failed to create conversation: HTTP ${res.status}`);
      }
      const data: any = await res.json();
      const id = String(data.conversation_id || data.id || `oh-${Date.now()}`);
      if (reuseSession) {
        setBounded(openHandsSessionMap, sessionKey, id);
      }
      return id;
    };

    if (!conversationId) {
      conversationId = await createConversation();
      usedCached = false;
    }

    let turnRes = await fetch(`${base}/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: promptText,
        messages: usedCached ? [{ role: 'user', content: promptText }] : request.messages,
        approval_policy: upstream.harness?.approvalPolicy || upstream.harness?.approvals || 'auto-approve-readonly'
      }),
      signal: controller.signal
    });

    if (turnRes.status === 404 && usedCached) {
      openHandsSessionMap.delete(sessionKey);
      conversationId = await createConversation();
      turnRes = await fetch(`${base}/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: promptText,
          messages: request.messages,
          approval_policy: upstream.harness?.approvalPolicy || upstream.harness?.approvals || 'auto-approve-readonly'
        }),
        signal: controller.signal
      });
    }

    clearTimeout(timer);
    if (!turnRes.ok) {
      const errText = await turnRes.text().catch(() => '');
      return new Response(
        JSON.stringify({
          error: {
            message: `OpenHands harness error (${turnRes.status}): ${errText}`,
            type: 'harness_error'
          }
        }),
        { status: turnRes.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const data: any = await turnRes.json();
    const content = String(
      data?.response ||
        data?.content ||
        data?.message ||
        data?.choices?.[0]?.message?.content ||
        ''
    );

    const modelId = request.model && request.model !== 'auto' ? request.model : 'harness/openhands';
    const completionId = `chatcmpl-oh-${Date.now()}`;

    if (request.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(ctrl) {
          const chunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
          };
          const doneChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          };
          ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
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
          'x-eluvix-harness': 'openhands',
          'x-eluvix-harness-session': conversationId
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
          'x-eluvix-harness': 'openhands',
          'x-eluvix-harness-session': conversationId
        }
      }
    );
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
