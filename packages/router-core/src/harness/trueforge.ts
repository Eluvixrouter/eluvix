import { setBounded } from '../bounded-map.js';
import type { RequestScope } from '../context/types.js';
import type { ChatMessage, ChatRequest, UpstreamConfig } from '../index.js';
import { isSessionGoneResponse } from './prompt.js';
import { isToolAutoApproved } from './approval.js';
import type { HarnessApprovalPolicy } from './types.js';

const sessionCache = new Map<string, string>();

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

async function respondToApproval(
  baseUrl: string,
  headers: Record<string, string>,
  sessionId: string,
  turnId: string,
  approvalId: string,
  toolName: string,
  policy: HarnessApprovalPolicy,
  autoApproveTools?: readonly string[]
): Promise<boolean> {
  if (policy === 'surface') return false;
  // Auto-approval requires an exact allowlist match (audit M-4): the
  // server-supplied tool name looking read-only is never sufficient.
  const approved = isToolAutoApproved(policy, [toolName], autoApproveTools);
  try {
    await fetch(
      `${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'tool-approval-response',
          approvalId,
          approved,
          reason: approved
            ? 'Auto-approved read-only tool by Eluvix harness policy'
            : `Denied by Eluvix headless approval policy (${policy})`
        })
      }
    );
  } catch {
    // Non-fatal if approval endpoint already closed
  }
  return approved;
}

export async function forwardTrueForgeHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const baseUrl = upstream.endpoint.trim().replace(/\/+$/, '');
  const harnessCfg = upstream.harness || { kind: 'trueforge' as const };
  const agentId =
    harnessCfg.agentId ||
    (request.model !== 'auto' && request.model !== '*' ? request.model : undefined) ||
    'default';
  const approvalPolicy: HarnessApprovalPolicy =
    harnessCfg.approvals || harnessCfg.approvalPolicy || 'auto-deny';
  const sessionMode = harnessCfg.sessionMode || 'per-eluvix-session';
  const reuseSession = sessionMode === 'per-eluvix-session' || sessionMode === 'per-conversation';

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
    () => controller.abort(new DOMException(`TrueForge turn timed out after ${timeoutMs}ms`, 'TimeoutError')),
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
    // 1. Resolve or create TrueForge session
    const cacheKey = `${upstream.id}:${scope?.userId || 'default'}:${scope?.sessionId || 'ephemeral'}`;
    const cacheable = reuseSession && Boolean(scope?.sessionId);

    const createSession = async (): Promise<{ id: string } | { errorRes: Response }> => {
      const sessionRes = await fetch(`${baseUrl}/api/v1/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          agentId,
          metadata: {
            eluvixUserId: scope?.userId || 'default',
            eluvixSessionId: scope?.sessionId
          }
        }),
        signal: controller.signal
      });
      if (!sessionRes.ok) {
        return { errorRes: sessionRes };
      }
      const sessionData: any = await sessionRes.json();
      return { id: String(sessionData?.id || sessionData?.sessionId || `tf-${Date.now()}`) };
    };

    let tfSessionId = cacheable ? sessionCache.get(cacheKey) : undefined;
    let usedCachedSession = Boolean(tfSessionId);

    if (!tfSessionId) {
      const createdSessionId = await createSession();
      if ('errorRes' in createdSessionId) {
        clearTimeout(timer);
        return createdSessionId.errorRes;
      }
      tfSessionId = createdSessionId.id;
      if (cacheable) {
        setBounded(sessionCache, cacheKey, tfSessionId);
      }
    }

    // 2. Start turn (POST /api/v1/sessions/{id}/turns). The full request
    // messages (system context incl. <eluvix-memory>, history, tools) are
    // sent alongside the extracted input prompt.
    const prompt = extractPromptFromMessages(request.messages || []);
    const startTurn = (sessionId: string) =>
      fetch(`${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/turns`, {
        method: 'POST',
        headers: {
          ...headers,
          Accept: 'text/event-stream, application/json'
        },
        body: JSON.stringify({
          input: prompt,
          prompt,
          messages: request.messages,
          ...(Array.isArray(request.tools) && request.tools.length > 0
            ? { tools: request.tools }
            : {}),
          stream: true
        }),
        signal: controller.signal
      });

    let turnRes = await startTurn(tfSessionId!);

    // A cached session id can outlive the server-side session (agent server
    // restart or expiry). Evict it, create a fresh session, and retry the
    // turn exactly once instead of returning the 404 forever.
    if (!turnRes.ok && usedCachedSession && (await isSessionGoneResponse(turnRes))) {
      sessionCache.delete(cacheKey);
      try {
        await turnRes.text();
      } catch {}
      const created = await createSession();
      if ('errorRes' in created) {
        clearTimeout(timer);
        return created.errorRes;
      }
      tfSessionId = created.id;
      usedCachedSession = false;
      if (cacheable) {
        setBounded(sessionCache, cacheKey, tfSessionId);
      }
      turnRes = await startTurn(tfSessionId);
    }

    if (!turnRes.ok) {
      clearTimeout(timer);
      return turnRes;
    }

    const contentType = turnRes.headers.get('content-type') || '';
    const completionId = `chatcmpl-tf-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const servedModel = `trueforge/${agentId}`;

    // If TrueForge returned direct JSON instead of SSE
    if (contentType.includes('application/json')) {
      clearTimeout(timer);
      const data: any = await turnRes.json();
      const text = String(
        data?.output || data?.content || data?.choices?.[0]?.message?.content || ''
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
                  created,
                  model: servedModel,
                  choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
                })}\n\n`
              )
            );
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
            'x-eluvix-model': servedModel,
            'x-eluvix-harness': 'trueforge',
            'x-eluvix-session': tfSessionId
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
          prompt_tokens: Math.ceil(prompt.length / 4),
          completion_tokens: Math.ceil(text.length / 4),
          total_tokens: Math.ceil((prompt.length + text.length) / 4)
        }
      };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-model': servedModel,
          'x-eluvix-harness': 'trueforge',
          'x-eluvix-session': tfSessionId
        }
      });
    }

    // Parse SSE turn stream from TrueForge
    let receivedDelta = false;
    const parseTurnSseEvent = async (
      eventName: string,
      dataStr: string,
      onDelta: (deltaText: string) => void
    ) => {
      if (!dataStr || dataStr === '[DONE]') return;
      try {
        const evt = JSON.parse(dataStr);
        const type = evt?.type || eventName;
        const turnId = String(evt?.turnId || evt?.turn_id || 'current');

        if (
          type === 'text-delta' ||
          type === 'text_delta' ||
          type === 'message.delta' ||
          type === 'content_block_delta' ||
          typeof evt?.delta === 'string'
        ) {
          const delta =
            typeof evt?.delta === 'string'
              ? evt.delta
              : typeof evt?.text === 'string'
              ? evt.text
              : typeof evt?.delta?.text === 'string'
              ? evt.delta.text
              : '';
          if (delta) {
            receivedDelta = true;
            onDelta(delta);
          }
        } else if (
          type === 'approval-required' ||
          type === 'tool-approval-request' ||
          type === 'permission_request'
        ) {
          const approvalId = String(evt?.approvalId || evt?.requestId || evt?.id || 'approval-1');
          const toolName = String(evt?.toolName || evt?.tool || 'unknown_tool');
          if (approvalPolicy === 'surface') {
            onDelta(`\n[Approval Required: tool "${toolName}" (id=${approvalId})]\n`);
          } else {
            await respondToApproval(
              baseUrl,
              headers,
              tfSessionId!,
              turnId,
              approvalId,
              toolName,
              approvalPolicy,
              harnessCfg.autoApproveTools
            );
          }
        } else if (
          type === 'turn.completed' ||
          type === 'turn.end' ||
          type === 'turn_complete' ||
          type === 'message.completed'
        ) {
          if (!receivedDelta && typeof evt?.output === 'string' && evt.output) {
            receivedDelta = true;
            onDelta(evt.output);
          }
        }
      } catch {
        // Ignore non-JSON comments
      }
    };

    if (!request.stream) {
      // Collect full SSE stream into a single OpenAI chat.completion JSON
      let fullText = '';
      if (turnRes.body) {
        const reader = (turnRes.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              await parseTurnSseEvent(currentEvent, line.slice(5).trim(), d => {
                fullText += d;
              });
            }
          }
        }
      }
      clearTimeout(timer);
      const promptTokens = Math.ceil(prompt.length / 4);
      const completionTokens = Math.ceil(fullText.length / 4);
      const payload = {
        id: completionId,
        object: 'chat.completion',
        created,
        model: servedModel,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: fullText },
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
          'x-eluvix-harness': 'trueforge',
          'x-eluvix-session': tfSessionId,
          'x-eluvix-prompt-tokens': String(promptTokens),
          'x-eluvix-completion-tokens': String(completionTokens)
        }
      });
    }

    // Streaming mode: convert TrueForge SSE events into OpenAI chat.completion.chunk SSE
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = (turnRes.body as ReadableStream<Uint8Array>).getReader();

    const outStream = new ReadableStream<Uint8Array>({
      async start(streamController) {
        const roleChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: servedModel,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
        };
        streamController.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

        let buffer = '';
        let currentEvent = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                await parseTurnSseEvent(currentEvent, line.slice(5).trim(), delta => {
                  const chunk = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model: servedModel,
                    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
                  };
                  streamController.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                });
              }
            }
          }
          const stopChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: servedModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          };
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
          streamController.enqueue(encoder.encode('data: [DONE]\n\n'));
          clearTimeout(timer);
          streamController.close();
        } catch (err) {
          clearTimeout(timer);
          streamController.error(err);
        }
      },
      cancel(reason) {
        clearTimeout(timer);
        return reader.cancel(reason).catch(() => {});
      }
    });

    return new Response(outStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'x-eluvix-model': servedModel,
        'x-eluvix-harness': 'trueforge',
        'x-eluvix-session': tfSessionId
      }
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
