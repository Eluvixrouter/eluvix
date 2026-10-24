import type { RequestScope } from '../context/types.js';
import type { ChatMessage, ChatRequest, UpstreamConfig } from '../index.js';

const MAX_SESSION_CACHE = 500;
const sessionCache = new Map<string, string>();

function setCachedSession(key: string, sessionId: string) {
  if (sessionCache.size >= MAX_SESSION_CACHE) {
    const oldest = sessionCache.keys().next().value;
    if (oldest) sessionCache.delete(oldest);
  }
  sessionCache.set(key, sessionId);
}

function extractPromptFromMessages(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find(m => m.role === 'user') || messages[messages.length - 1];
  if (!lastUser) return '';
  if (typeof lastUser.content === 'string') return lastUser.content;
  if (Array.isArray(lastUser.content)) {
    return lastUser.content
      .filter(p => p.type === 'text')
      .map(p => (p as { type: 'text'; text: string }).text)
      .join('\n');
  }
  return '';
}

export async function forwardOpencodeHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const baseUrl = upstream.endpoint.trim().replace(/\/+$/, '');
  const harnessCfg = upstream.harness || { kind: 'opencode' as const };
  const agent = harnessCfg.agentId || 'build';
  const sessionMode = harnessCfg.sessionMode || 'per-eluvix-session';
  const reuseSession = sessionMode === 'per-eluvix-session' || sessionMode === 'per-conversation';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-eluvix-origin': 'harness',
    'x-eluvix-hops': String(hops + 1)
  };
  if (upstream.apiKey) {
    if (upstream.apiKey.includes(':')) {
      headers['Authorization'] = `Basic ${Buffer.from(upstream.apiKey).toString('base64')}`;
    } else {
      headers['Authorization'] = `Bearer ${upstream.apiKey}`;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`opencode turn timed out after ${timeoutMs}ms`, 'TimeoutError')),
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
    const cacheKey = `${upstream.id}:${scope?.userId || 'default'}:${scope?.sessionId || 'ephemeral'}`;
    let usedCachedSession = false;
    let ocSessionId =
      reuseSession && scope?.sessionId ? sessionCache.get(cacheKey) : undefined;
    if (ocSessionId) {
      usedCachedSession = true;
    }

    const createNewSession = async (): Promise<Response | string> => {
      const sessionRes = await fetch(`${baseUrl}/session`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: `Eluvix Session (${scope?.userId || 'default'})` }),
        signal: controller.signal
      });
      if (!sessionRes.ok) {
        return sessionRes;
      }
      const sessionData: any = await sessionRes.json();
      const newId = String(sessionData?.id || `oc-${Date.now()}`);
      if (reuseSession && scope?.sessionId) {
        setCachedSession(cacheKey, newId);
      }
      return newId;
    };

    if (!ocSessionId) {
      const createdSession = await createNewSession();
      if (createdSession instanceof Response) {
        clearTimeout(timer);
        return createdSession;
      }
      ocSessionId = createdSession;
    }

    const prompt = extractPromptFromMessages(request.messages || []);
    const postMessage = (sid: string) =>
      fetch(`${baseUrl}/session/${encodeURIComponent(sid)}/message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agent,
          parts: [{ type: 'text', text: prompt }]
        }),
        signal: controller.signal
      });

    let msgRes = await postMessage(ocSessionId);
    if (msgRes.status === 404 && usedCachedSession) {
      sessionCache.delete(cacheKey);
      const recreated = await createNewSession();
      if (recreated instanceof Response) {
        clearTimeout(timer);
        return recreated;
      }
      ocSessionId = recreated;
      msgRes = await postMessage(ocSessionId);
    }

    clearTimeout(timer);
    if (!msgRes.ok) {
      return msgRes;
    }

    const data: any = await msgRes.json();
    const parts: any[] = Array.isArray(data?.parts) ? data.parts : [];
    const text =
      parts
        .filter(p => p?.type === 'text' && typeof p?.text === 'string')
        .map(p => p.text)
        .join('\n') ||
      String(data?.text || data?.content || data?.output || '');

    const completionId = `chatcmpl-oc-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const servedModel = `opencode/${agent}`;
    const promptTokens = Math.ceil(prompt.length / 4);
    const completionTokens = Math.ceil(text.length / 4);

    if (request.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: servedModel,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
              })}\n\n`
            )
          );
          if (text) {
            ctrl.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model: servedModel,
                  choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
                })}\n\n`
              )
            );
          }
          ctrl.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: servedModel,
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
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'x-eluvix-model': servedModel,
          'x-eluvix-harness': 'opencode',
          'x-eluvix-session': ocSessionId
        }
      });
    }

    const payload = {
      id: completionId,
      object: 'chat.completion',
      created,
      model: servedModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-eluvix-model': servedModel,
        'x-eluvix-harness': 'opencode',
        'x-eluvix-session': ocSessionId,
        'x-eluvix-prompt-tokens': String(promptTokens),
        'x-eluvix-completion-tokens': String(completionTokens)
      }
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
