import type { RequestScope } from '../context/types.js';
import type { ChatMessage, ChatRequest, UpstreamConfig } from '../index.js';
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

function isReadonlyToolName(toolName: string): boolean {
  return /^(read|get|list|search|find|fetch|query|view|inspect|cat|ls|grep)/i.test(toolName || '');
}

async function respondToApproval(
  baseUrl: string,
  headers: Record<string, string>,
  sessionId: string,
  turnId: string,
  approvalId: string,
  toolName: string,
  policy: HarnessApprovalPolicy
): Promise<boolean> {
  if (policy === 'surface') return false;
  const approved =
    (policy === 'auto-approve-readonly' || policy === 'read-only') && isReadonlyToolName(toolName);
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
    let tfSessionId =
      reuseSession && scope?.sessionId ? sessionCache.get(cacheKey) : undefined;

    if (!tfSessionId) {
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
        clearTimeout(timer);
        return sessionRes;
      }
      const sessionData: any = await sessionRes.json();
      tfSessionId = String(sessionData?.id || sessionData?.sessionId || `tf-${Date.now()}`);
      if (reuseSession && scope?.sessionId) {
        sessionCache.set(cacheKey, tfSessionId);
      }
    }

    // 2. Start turn (POST /api/v1/sessions/{id}/turns)
    const prompt = extractPromptFromMessages(request.messages || []);
    const turnRes = await fetch(
      `${baseUrl}/api/v1/sessions/${encodeURIComponent(tfSessionId)}/turns`,
      {
        method: 'POST',
        headers: {
          ...headers,
          Accept: 'text/event-stream, application/json'
        },
        body: JSON.stringify({
          input: prompt,
          messages: request.messages,
          stream: true
        }),
        signal: controller.signal
      }
    );

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
          if (delta) onDelta(delta);
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
              approvalPolicy
            );
          }
        } else if (type === 'turn.completed' || type === 'turn_complete' || type === 'message.completed') {
          if (typeof evt?.output === 'string' && evt.output) {
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
