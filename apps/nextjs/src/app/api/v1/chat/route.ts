import { NextResponse } from 'next/server';
import {
  forwardHarnessRequest,
  saveChatMessage,
  upsertHarnessSession,
  getHarnessSession,
  isLocalUpstream,
  type HarnessKind,
  type UpstreamConfig,
} from '@eluvix/router-core';
import { getRouter, getConfig } from '@/lib/router';
import { resolveCallerIdentity } from '@/lib/caller-identity';
import { isBlockedDns } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

function normalizeContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c?.type === 'text' && typeof c.text === 'string') return c.text;
        if (c?.type === 'image_url') return '[Attached Image]';
        return c?.text || JSON.stringify(c);
      })
      .join('\n');
  }
  if (content === null || content === undefined) return '';
  return String(content);
}

function persistConversationTurn(params: {
  sessionId?: string;
  sessionTitle?: string;
  userId: string;
  messages: any[];
  assistantRole: string;
  assistantContent: string;
  toolCalls?: any;
  trace: Record<string, any>;
  harness?: string;
  harnessOverride?: any;
  prefixHash?: string;
  switchyardTier?: string;
  guardRedactions: number;
  guardInjections: number;
}) {
  const {
    sessionId,
    sessionTitle,
    userId,
    messages,
    assistantRole,
    assistantContent,
    toolCalls,
    trace,
    harness,
    harnessOverride,
    prefixHash,
    switchyardTier,
    guardRedactions,
    guardInjections,
  } = params;

  if (!sessionId || !Array.isArray(messages)) return;

  const userMsg = messages[messages.length - 1];
  if (userMsg) {
    saveChatMessage(sessionId, userMsg.role, normalizeContent(userMsg.content), userId);
  }

  if (assistantContent || toolCalls) {
    const msgMeta =
      toolCalls || harness
        ? {
            tool_calls: toolCalls,
            trace,
          }
        : undefined;
    saveChatMessage(sessionId, assistantRole || 'assistant', assistantContent, userId, msgMeta);
  }

  let resolvedTitle = sessionTitle;
  if (!resolvedTitle) {
    const existingSession = getHarnessSession(sessionId, userId);
    if (existingSession?.title) {
      resolvedTitle = existingSession.title;
    } else {
      const firstUserMsg = messages.find((m: any) => m.role === 'user');
      resolvedTitle = normalizeContent(firstUserMsg?.content).trim().slice(0, 72) || undefined;
    }
  }

  upsertHarnessSession({
    sessionId,
    userId,
    title: resolvedTitle || undefined,
    harnessKind: (harness as any) || harnessOverride?.kind || 'opencode',
    agentId: harnessOverride?.agentId || 'build',
    nodeId: harnessOverride?.nodeId || null,
    endpoint: harnessOverride?.endpoint || null,
    kvPrefixHash: prefixHash || null,
    lastTier: switchyardTier || null,
    redactionDelta: guardRedactions,
    injectionDelta: guardInjections,
  });
}

export async function POST(req: Request) {
  const reqStartedAt = Date.now();
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON request body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      { success: false, error: "Missing required parameter: 'messages' must be a non-empty array" },
      { status: 400 }
    );
  }

  try {
    const caller = await resolveCallerIdentity(req);
    if (!caller.ok) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    const userId = caller.userId;

    const wantStream = body.stream === true;
    const { session_id, session_title, harnessOverride, ...rawForwardBody } = body;
    const forwardBody = { ...rawForwardBody, stream: wantStream };

    let res: Response;
    if (harnessOverride && typeof harnessOverride === 'object' && harnessOverride.kind) {
      if (caller.role !== 'admin' && caller.role !== 'operator') {
        return NextResponse.json(
          {
            success: false,
            error: 'Forbidden: only admin or operator roles may supply harnessOverride',
          },
          { status: 403 }
        );
      }

      const kind = String(harnessOverride.kind) as HarnessKind;
      const defaultEmbeddedEndpoint =
        kind === 'opencode'
          ? 'opencode-eluvix://embedded'
          : kind === 'trueforge'
          ? 'trueforge://embedded'
          : kind === 'aider'
          ? 'aider://embedded'
          : kind === 'swe-agent'
          ? 'swe-agent://embedded'
          : kind === 'cline'
          ? 'cline://embedded'
          : kind === 'plandex'
          ? 'plandex://embedded'
          : 'trueforge://embedded';

      const endpoint =
        typeof harnessOverride.endpoint === 'string' && harnessOverride.endpoint.trim().length > 0
          ? harnessOverride.endpoint.trim()
          : defaultEmbeddedEndpoint;

      if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(endpoint);
        } catch {
          return NextResponse.json(
            { success: false, error: 'Invalid harnessOverride endpoint URL' },
            { status: 400 }
          );
        }
        if (await isBlockedDns(parsedUrl.hostname)) {
          return NextResponse.json(
            { success: false, error: `harnessOverride endpoint ${parsedUrl.hostname} is blocked` },
            { status: 403 }
          );
        }
      }

      const overrideUpstream: UpstreamConfig = {
        id: harnessOverride.nodeId || `harness-${kind}`,
        name: harnessOverride.label || `${kind} Harness`,
        type: 'harness',
        endpoint,
        priority: 100,
        models: [forwardBody.model || `harness/${kind}`, '*'],
        harness: {
          kind,
          agentId: harnessOverride.agentId || 'build',
          embedded: harnessOverride.embedded ?? endpoint.includes('://embedded'),
          forked: harnessOverride.forked ?? true,
          deepIntegration: harnessOverride.deepIntegration ?? true,
          approvalPolicy: harnessOverride.approvalPolicy || harnessOverride.approvals || 'never',
          autoApproveTools: Array.isArray(harnessOverride.autoApproveTools)
            ? harnessOverride.autoApproveTools
            : undefined,
          mcpServers: Array.isArray(harnessOverride.mcpServers) ? harnessOverride.mcpServers : undefined,
          midLoopGuard: harnessOverride.midLoopGuard || {
            enabled: true,
            redactPii: true,
            stripInjection: true,
            blockOnInjection: false,
          },
          architectModel: harnessOverride.architectModel,
          editorModel: harnessOverride.editorModel,
          repoMapTokens: harnessOverride.repoMapTokens,
          editFormat: harnessOverride.editFormat,
          aciProfile: harnessOverride.aciProfile,
        },
      };

      const currentCfg = getConfig();
      if (currentCfg.egressPolicy === 'local-only' && !isLocalUpstream(overrideUpstream)) {
        return NextResponse.json(
          { success: false, error: 'Egress violation: router is configured for local-only egress' },
          { status: 403 }
        );
      }

      res = await forwardHarnessRequest(
        overrideUpstream,
        { ...forwardBody, stream: false },
        60000,
        undefined,
        {
          userId,
          sessionId: typeof session_id === 'string' ? session_id : undefined,
          origin: 'playground',
        },
        0
      );
    } else {
      // Route in-process via Eluvix core router
      const router = getRouter();
      res = await router.routeChatCompletion(forwardBody, {
        scope: {
          userId,
          sessionId: typeof session_id === 'string' ? session_id : undefined,
          origin: 'playground',
        },
      });
    }

    // Extract our custom trace & deep-harness headers
    const upstream =
      res.headers.get('x-eluvix-upstream') ||
      (harnessOverride?.kind ? `harness-${harnessOverride.kind}` : 'unknown');
    const resolvedModel = res.headers.get('x-eluvix-model') || forwardBody.model || 'auto';
    const complexity = res.headers.get('x-eluvix-complexity') || '0';
    const tokens =
      res.headers.get('x-eluvix-tokens') || res.headers.get('x-eluvix-prompt-tokens') || '0';
    const memory = res.headers.get('x-eluvix-memory') || undefined;
    const memoryTokens = res.headers.get('x-eluvix-memory-tokens') || undefined;
    const cacheStatus = res.headers.get('x-eluvix-cache') || undefined;
    const ttftHeader = res.headers.get('x-eluvix-ttft-ms');
    const itlHeader = res.headers.get('x-eluvix-itl-ms');
    const kvCacheKb = res.headers.get('x-eluvix-kv-cache-kb') || undefined;
    const teePosture = res.headers.get('x-eluvix-tee-posture') || undefined;
    const quantizationFormat = res.headers.get('x-eluvix-quantization') || undefined;
    const attentionKernel = res.headers.get('x-eluvix-attention-kernel') || undefined;
    const harness = res.headers.get('x-eluvix-harness') || harnessOverride?.kind || undefined;
    const harnessMode = res.headers.get('x-eluvix-harness-mode') || undefined;
    const harnessFork = res.headers.get('x-eluvix-harness-fork') || undefined;
    const harnessSession = res.headers.get('x-eluvix-session') || undefined;
    const prefixHash =
      res.headers.get('x-eluvix-prefix-hash') ||
      res.headers.get('x-eluvix-kv-prefix-hash') ||
      undefined;
    const switchyardTier = res.headers.get('x-eluvix-switchyard-tier') || undefined;
    const guardRedactions = Number(res.headers.get('x-eluvix-guard-redactions') || '0');
    const guardInjections = Number(res.headers.get('x-eluvix-guard-injections') || '0');

    const trace = {
      upstream,
      model: resolvedModel,
      complexity,
      tokens,
      memory,
      memoryTokens,
      cache: cacheStatus,
      ttftMs: ttftHeader ? Number(ttftHeader) : undefined,
      itlMs: itlHeader ? Number(itlHeader) : undefined,
      kvCacheKb,
      teePosture,
      quantizationFormat,
      attentionKernel,
      harness,
      harnessMode,
      harnessFork,
      harnessSession,
      prefixHash,
      switchyardTier,
      guardRedactions,
      guardInjections,
      status: res.status,
    };

    if (!res.ok) {
      let errData: any;
      try {
        errData = await res.json();
      } catch {
        const text = await res.text().catch(() => '');
        errData = { error: { message: text || 'Request failed' } };
      }
      return NextResponse.json(
        {
          success: false,
          error: errData?.error?.message || 'Request failed',
          data: errData,
          trace,
        },
        { status: res.status }
      );
    }

    // Track 5: Real-Time SSE Token Streaming Path (when caller sets stream: true)
    if (wantStream) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const contentType = (res.headers.get('content-type') || '').toLowerCase();

      const sseStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // 1. Emit initial trace headers immediately so the Playground Trace Drawer lights up
          controller.enqueue(
            encoder.encode(`event: eluvix_trace\ndata: ${JSON.stringify(trace)}\n\n`)
          );

          if (contentType.includes('text/event-stream') && res.body) {
            const reader = res.body.getReader();
            let firstChunkAt: number | null = null;
            let chunkCount = 0;
            let accumulatedContent = '';
            let accumulatedReasoning = '';
            let sseBuffer = '';

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) {
                  controller.enqueue(value);
                  sseBuffer += decoder.decode(value, { stream: true });
                  const lines = sseBuffer.split('\n');
                  sseBuffer = lines.pop() ?? '';

                  for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;
                    try {
                      const parsed = JSON.parse(payload);
                      const delta = parsed?.choices?.[0]?.delta;
                      if (delta) {
                        const textPiece =
                          typeof delta.content === 'string' ? delta.content : '';
                        const reasoningPiece =
                          typeof delta.reasoning_content === 'string'
                            ? delta.reasoning_content
                            : typeof delta.reasoning === 'string'
                            ? delta.reasoning
                            : '';
                        if (textPiece || reasoningPiece) {
                          if (firstChunkAt === null) {
                            firstChunkAt = Date.now();
                          }
                          chunkCount++;
                          accumulatedContent += textPiece;
                          accumulatedReasoning += reasoningPiece;
                        }
                      }
                    } catch {
                      // Non-JSON SSE frame; passthrough already forwarded
                    }
                  }
                }
              }
            } finally {
              reader.releaseLock();
            }

            const fullAssistantText = accumulatedReasoning
              ? `<think>\n${accumulatedReasoning}\n</think>\n\n${accumulatedContent}`
              : accumulatedContent;

            persistConversationTurn({
              sessionId: typeof session_id === 'string' ? session_id : undefined,
              sessionTitle: session_title,
              userId,
              messages: forwardBody.messages,
              assistantRole: 'assistant',
              assistantContent: fullAssistantText,
              trace,
              harness,
              harnessOverride,
              prefixHash,
              switchyardTier,
              guardRedactions,
              guardInjections,
            });

            const totalMs = Date.now() - reqStartedAt;
            const ttftMs =
              firstChunkAt !== null
                ? firstChunkAt - reqStartedAt
                : trace.ttftMs ?? totalMs;
            const completionTokens = Math.max(
              chunkCount,
              Math.ceil(fullAssistantText.length / 4)
            );
            const genWindowMs = Math.max(1, totalMs - Math.min(ttftMs, totalMs - 1));
            const tokPerSec =
              completionTokens > 0
                ? Number(((completionTokens / genWindowMs) * 1000).toFixed(1))
                : 0;

            controller.enqueue(
              encoder.encode(
                `event: eluvix_done\ndata: ${JSON.stringify({
                  ...trace,
                  ttftMs,
                  totalMs,
                  completionTokens,
                  tokPerSec,
                })}\n\n`
              )
            );
            controller.close();
            return;
          }

          // Fallback for synchronous JSON upstreams (CLI agents, Semantic Cache hits, ComfyUI, Consensus)
          let syncData: any = {};
          try {
            syncData = await res.json();
          } catch {
            const text = await res.text().catch(() => '');
            syncData = {
              choices: [{ message: { role: 'assistant', content: text } }],
            };
          }

          const assistantMsg = syncData.choices?.[0]?.message;
          const assistantText = normalizeContent(assistantMsg?.content || '');

          persistConversationTurn({
            sessionId: typeof session_id === 'string' ? session_id : undefined,
            sessionTitle: session_title,
            userId,
            messages: forwardBody.messages,
            assistantRole: assistantMsg?.role || 'assistant',
            assistantContent: assistantText,
            toolCalls: assistantMsg?.tool_calls,
            trace,
            harness,
            harnessOverride,
            prefixHash,
            switchyardTier,
            guardRedactions,
            guardInjections,
          });

          const syntheticChunk = {
            id: syncData.id || `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: syncData.created || Math.floor(Date.now() / 1000),
            model: syncData.model || resolvedModel,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: assistantText },
                finish_reason: 'stop',
              },
            ],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(syntheticChunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));

          const totalMs = Date.now() - reqStartedAt;
          const ttftMs = trace.ttftMs ?? totalMs;
          const completionTokens =
            syncData.usage?.completion_tokens ||
            Math.max(1, Math.ceil(assistantText.length / 4));
          const tokPerSec =
            totalMs > 0
              ? Number(((completionTokens / Math.max(1, totalMs)) * 1000).toFixed(1))
              : 0;

          controller.enqueue(
            encoder.encode(
              `event: eluvix_done\ndata: ${JSON.stringify({
                ...trace,
                ttftMs,
                totalMs,
                completionTokens,
                tokPerSec,
              })}\n\n`
            )
          );
          controller.close();
        },
      });

      return new Response(sseStream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // Standard Non-Streaming JSON Path (100% backward compatible)
    let data: any;
    try {
      data = await res.json();
    } catch {
      const text = await res.text().catch(() => '');
      data = { error: { message: text || 'Request failed' } };
    }

    const assistantMsg = data.choices?.[0]?.message;
    persistConversationTurn({
      sessionId: typeof session_id === 'string' ? session_id : undefined,
      sessionTitle: session_title,
      userId,
      messages: forwardBody.messages,
      assistantRole: assistantMsg?.role || 'assistant',
      assistantContent: assistantMsg ? normalizeContent(assistantMsg.content) : '',
      toolCalls: assistantMsg?.tool_calls,
      trace,
      harness,
      harnessOverride,
      prefixHash,
      switchyardTier,
      guardRedactions,
      guardInjections,
    });

    const totalMs = Date.now() - reqStartedAt;
    return NextResponse.json({
      success: true,
      data,
      trace: {
        ...trace,
        totalMs,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
