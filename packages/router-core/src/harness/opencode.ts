import { setBounded } from '../bounded-map.js';
import type { RequestScope } from '../context/types.js';
import type { ChatRequest, UpstreamConfig } from '../index.js';
import { buildHarnessPrompt, isSessionGoneResponse } from './prompt.js';

const sessionCache = new Map<string, string>();

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

  // The opencode session API has no tool-calling channel: forwarding a
  // tool-bearing request would silently drop the tools. Fail the attempt
  // instead so router failover can pick an upstream that supports them.
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    throw new Error(
      'opencode harness does not support tool calling; refusing to silently drop request tools'
    );
  }

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
    const cacheable = sessionMode === 'per-eluvix-session' && Boolean(scope?.sessionId);
    const cacheKey = `${upstream.id}:${scope?.userId || 'default'}:${scope?.sessionId || 'ephemeral'}`;

    const createSession = async (): Promise<{ id: string } | { errorRes: Response }> => {
      const sessionRes = await fetch(`${baseUrl}/session`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: `Eluvix Session (${scope?.userId || 'default'})` }),
        signal: controller.signal
      });
      if (!sessionRes.ok) {
        return { errorRes: sessionRes };
      }
      const sessionData: any = await sessionRes.json();
      return { id: String(sessionData?.id || `oc-${Date.now()}`) };
    };

    const sendMessage = (sessionId: string, prompt: string) =>
      fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agent,
          parts: [{ type: 'text', text: prompt }]
        }),
        signal: controller.signal
      });

    let ocSessionId = cacheable ? sessionCache.get(cacheKey) : undefined;
    let usedCachedSession = Boolean(ocSessionId);
    let createdFreshSession = false;

    if (!ocSessionId) {
      const created = await createSession();
      if ('errorRes' in created) {
        clearTimeout(timer);
        return created.errorRes;
      }
      ocSessionId = created.id;
      createdFreshSession = true;
      if (cacheable) {
        setBounded(sessionCache, cacheKey, ocSessionId);
      }
    }

    // The system context (incl. the injected <eluvix-memory> block) rides on
    // every turn. History is folded in whenever the server-side session does
    // not already hold it: per-request mode, or a session created fresh by
    // this call.
    const buildPrompt = () =>
      buildHarnessPrompt(request.messages || [], {
        includeHistory: sessionMode === 'per-request' || createdFreshSession
      });

    let prompt = buildPrompt();
    let msgRes = await sendMessage(ocSessionId!, prompt);

    // A cached session id can outlive the server-side session (agent server
    // restart or expiry). Evict it, create a fresh session, and retry the
    // turn exactly once instead of returning the 404 forever.
    if (!msgRes.ok && usedCachedSession && (await isSessionGoneResponse(msgRes))) {
      sessionCache.delete(cacheKey);
      try {
        await msgRes.text();
      } catch {}
      const created = await createSession();
      if ('errorRes' in created) {
        clearTimeout(timer);
        return created.errorRes;
      }
      ocSessionId = created.id;
      createdFreshSession = true;
      usedCachedSession = false;
      if (cacheable) {
        setBounded(sessionCache, cacheKey, ocSessionId);
      }
      prompt = buildPrompt();
      msgRes = await sendMessage(ocSessionId, prompt);
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
