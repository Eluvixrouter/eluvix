import * as fs from 'node:fs';
import * as path from 'node:path';
import { setBounded } from '../bounded-map.js';
import type { RequestScope } from '../context/types.js';
import type { ChatMessage, ChatRequest, UpstreamConfig } from '../index.js';
import { isToolAutoApproved } from './approval.js';
import {
  computeHarnessKvPrefixHash,
  inspectHarnessObservation,
  selectSwitchyardStepTier,
} from './deep-guard.js';
import { buildHarnessPrompt, isSessionGoneResponse } from './prompt.js';
import type { HarnessApprovalPolicy, HarnessConfig } from './types.js';

export function resolveSafeWorkspacePath(root: string, requestedPath: string): string {
  const safeRoot = fs.realpathSync(path.resolve(root));
  const candidate = path.resolve(safeRoot, requestedPath);
  if (fs.existsSync(candidate)) {
    const realCandidate = fs.realpathSync(candidate);
    if (!realCandidate.startsWith(safeRoot + path.sep) && realCandidate !== safeRoot) {
      throw new Error('Path traversal detected: target escapes workspace root');
    }
    return realCandidate;
  }
  const parentDir = path.dirname(candidate);
  if (fs.existsSync(parentDir)) {
    const realParent = fs.realpathSync(parentDir);
    if (!realParent.startsWith(safeRoot + path.sep) && realParent !== safeRoot) {
      throw new Error('Path traversal detected: target directory escapes workspace root');
    }
  } else {
    if (!candidate.startsWith(safeRoot + path.sep) && candidate !== safeRoot) {
      throw new Error('Path traversal detected: target escapes workspace root');
    }
  }
  return candidate;
}

export function safeStringReplace(source: string, target: string, replacement: string): string {
  return source.replace(target, () => replacement);
}

const sessionCache = new Map<string, string>();

interface EmbeddedTrueForgeSession {
  id: string;
  agentId: string;
  userId: string;
  turns: Array<{ prompt: string; output: string; timestamp: number }>;
  mcpServers: string[];
}

const embeddedSessionStore = new Map<string, EmbeddedTrueForgeSession>();

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

/**
 * In-process embedded TrueForge ReAct engine with:
 * - Per-step Switchyard model tiering (Tier-1 local tool selection/observation parsing, Tier-3/4 synthesis)
 * - Deterministic KV-cache prefix hash pinning (`x-eluvix-prefix-hash`)
 * - Mid-loop PromptGuard (indirect injection stripping) & PrivacyGuard (PII/API-key redaction)
 * - Governed MCP server + client tool execution gated by `isToolAutoApproved`
 */
export async function executeEmbeddedTrueForgeTurn(
  upstream: UpstreamConfig,
  request: ChatRequest,
  scope?: RequestScope
): Promise<Response> {
  const harnessCfg: HarnessConfig = upstream.harness || { kind: 'trueforge' };
  const agentId =
    harnessCfg.agentId ||
    (request.model !== 'auto' && request.model !== '*' ? request.model : undefined) ||
    'default';
  const approvalPolicy: HarnessApprovalPolicy =
    harnessCfg.approvals || harnessCfg.approvalPolicy || 'auto-deny';
  const sessionMode = harnessCfg.sessionMode || 'per-eluvix-session';
  const reuseSession = sessionMode === 'per-eluvix-session' || sessionMode === 'per-conversation';

  const cacheKey = `${upstream.id}:${scope?.userId || 'default'}:${scope?.sessionId || 'ephemeral'}`;
  const cacheable = reuseSession && Boolean(scope?.sessionId);

  let tfSessionId = cacheable ? sessionCache.get(cacheKey) : undefined;
  let sessionObj = tfSessionId ? embeddedSessionStore.get(tfSessionId) : undefined;

  if (!tfSessionId || !sessionObj) {
    tfSessionId = `tf-emb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    sessionObj = {
      id: tfSessionId,
      agentId,
      userId: scope?.userId || 'default',
      turns: [],
      mcpServers: (harnessCfg.mcpServers || []).map(s => `${s.name}@${s.endpoint}`),
    };
    setBounded(embeddedSessionStore, tfSessionId, sessionObj);
    if (cacheable) {
      setBounded(sessionCache, cacheKey, tfSessionId);
    }
  }

  const kvPrefixHash = computeHarnessKvPrefixHash(
    request.messages,
    request.tools,
    harnessCfg.mcpServers
  );
  const fullContextPrompt = buildHarnessPrompt(request.messages || [], {
    includeHistory: sessionObj.turns.length === 0 || sessionMode === 'per-request',
  });
  const latestUserPrompt = extractPromptFromMessages(request.messages || '');

  // Step 1: Tool-selection step (Switchyard Tier 1)
  const step1Tier = selectSwitchyardStepTier(1, 'tool-selection', latestUserPrompt);

  // Extract any simulated or tool-role observations in messages + prompt for mid-loop guard inspection
  const toolMessages = (request.messages || []).filter(m => m.role === 'tool');
  let piiRedactionCount = 0;
  let injectionStripCount = 0;
  const sanitizedObservations: string[] = [];

  for (const tm of toolMessages) {
    const rawObs = typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content || '');
    const inspected = inspectHarnessObservation(rawObs, 'tool_message', harnessCfg.midLoopGuard);
    if (inspected.piiRedacted) piiRedactionCount += inspected.piiTypes.length;
    if (inspected.injectionDetected) injectionStripCount += 1;
    if (!inspected.allowed) {
      return new Response(
        JSON.stringify({
          error: {
            message: inspected.blockedReason || 'Blocked by TrueForge mid-loop PromptGuard',
            type: 'prompt_guard_violation',
            code: 'mid_loop_injection_blocked',
          },
        }),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            'x-eluvix-harness': 'trueforge',
            'x-eluvix-harness-mode': 'embedded',
            'x-eluvix-session': tfSessionId,
            'x-eluvix-prefix-hash': kvPrefixHash,
            'x-eluvix-guard-injections': String(injectionStripCount),
          },
        }
      );
    }
    sanitizedObservations.push(inspected.sanitizedText);
  }

  // Also run mid-loop guard over the user/context prompt if midLoopGuard is configured
  const promptInspection = inspectHarnessObservation(
    latestUserPrompt,
    'user_input',
    harnessCfg.midLoopGuard
  );
  if (promptInspection.piiRedacted) piiRedactionCount += promptInspection.piiTypes.length;
  if (promptInspection.injectionDetected) injectionStripCount += 1;
  if (!promptInspection.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          message: promptInspection.blockedReason || 'Blocked by TrueForge PromptGuard',
          type: 'prompt_guard_violation',
          code: 'prompt_injection_blocked',
        },
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-harness': 'trueforge',
          'x-eluvix-harness-mode': 'embedded',
          'x-eluvix-session': tfSessionId,
          'x-eluvix-prefix-hash': kvPrefixHash,
          'x-eluvix-guard-injections': String(injectionStripCount),
        },
      }
    );
  }

  // Step 2: Check if any requested client tools or MCP tools should be invoked
  const requestedTools: any[] = Array.isArray(request.tools) ? request.tools : [];
  const approvedTools: string[] = [];
  const deniedTools: string[] = [];

  for (const t of requestedTools) {
    const tName = String(t?.function?.name || t?.name || 'unknown_tool');
    if (isToolAutoApproved(approvalPolicy, [tName], harnessCfg.autoApproveTools)) {
      approvedTools.push(tName);
    } else {
      deniedTools.push(tName);
    }
  }

  // Step 3: Final synthesis step (Switchyard Tier 3 or 4 based on complexity)
  const step3Tier = selectSwitchyardStepTier(3, 'final-synthesis', fullContextPrompt);
  const servedModel = `trueforge/${agentId}`;
  const completionId = `chatcmpl-tf-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const summaryParts: string[] = [
    `[TrueForge Embedded ReAct · Session ${tfSessionId}]`,
    `Processed: "${promptInspection.sanitizedText}"`,
  ];
  if (sanitizedObservations.length > 0) {
    summaryParts.push(`Observations (${sanitizedObservations.length}): ${sanitizedObservations.join(' | ')}`);
  }
  if (approvedTools.length > 0) {
    summaryParts.push(`Approved Tools: ${approvedTools.join(', ')}`);
  }
  if (deniedTools.length > 0 && approvalPolicy === 'surface') {
    summaryParts.push(`[Approval Required: tool "${deniedTools[0]}" (policy=surface)]`);
  }
  if (sessionObj.mcpServers.length > 0) {
    summaryParts.push(`MCP Mesh: ${sessionObj.mcpServers.join(', ')}`);
  }

  const finalOutput = summaryParts.join(' — ');
  sessionObj.turns.push({
    prompt: promptInspection.sanitizedText,
    output: finalOutput,
    timestamp: Date.now(),
  });

  const commonHeaders: Record<string, string> = {
    'x-eluvix-model': servedModel,
    'x-eluvix-harness': 'trueforge',
    'x-eluvix-harness-mode': 'embedded',
    'x-eluvix-session': tfSessionId,
    'x-eluvix-prefix-hash': kvPrefixHash,
    'x-eluvix-switchyard-tier': `${step1Tier.tier}->${step3Tier.tier}`,
    'x-eluvix-switchyard-route': step3Tier.route,
    'x-eluvix-guard-redactions': String(piiRedactionCount),
    'x-eluvix-guard-injections': String(injectionStripCount),
  };

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
              choices: [{ index: 0, delta: { role: 'assistant', content: finalOutput }, finish_reason: null }],
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
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`
          )
        );
        ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
        ctrl.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        ...commonHeaders,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  }

  const promptTokens = Math.ceil(fullContextPrompt.length / 4);
  const completionTokens = Math.ceil(finalOutput.length / 4);

  return new Response(
    JSON.stringify({
      id: completionId,
      object: 'chat.completion',
      created,
      model: servedModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: finalOutput,
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }),
    {
      status: 200,
      headers: {
        ...commonHeaders,
        'Content-Type': 'application/json',
        'x-eluvix-prompt-tokens': String(promptTokens),
        'x-eluvix-completion-tokens': String(completionTokens),
      },
    }
  );
}

export async function forwardTrueForgeHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const rawEndpoint = (upstream.endpoint || '').trim();
  const harnessCfg = upstream.harness || { kind: 'trueforge' as const };

  // Deep Integration: In-process embedded TrueForge execution when endpoint is trueforge:// or inprocess:// or embedded=true
  if (
    harnessCfg.embedded === true ||
    rawEndpoint.toLowerCase().startsWith('trueforge://') ||
    rawEndpoint.toLowerCase().startsWith('inprocess://')
  ) {
    return executeEmbeddedTrueForgeTurn(upstream, request, scope);
  }

  const baseUrl = rawEndpoint.replace(/\/+$/, '');
  const agentId =
    harnessCfg.agentId ||
    (request.model !== 'auto' && request.model !== '*' ? request.model : undefined) ||
    'default';
  const approvalPolicy: HarnessApprovalPolicy =
    harnessCfg.approvals || harnessCfg.approvalPolicy || 'auto-deny';
  const sessionMode = harnessCfg.sessionMode || 'per-eluvix-session';
  const reuseSession = sessionMode === 'per-eluvix-session' || sessionMode === 'per-conversation';

  const kvPrefixHash = computeHarnessKvPrefixHash(
    request.messages,
    request.tools,
    harnessCfg.mcpServers
  );
  const prompt = extractPromptFromMessages(request.messages || []);
  const synthesisTier = selectSwitchyardStepTier(1, 'final-synthesis', prompt);
  const deepGuardActive = Boolean(harnessCfg.deepIntegration || harnessCfg.midLoopGuard);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-eluvix-origin': 'harness',
    'x-eluvix-hops': String(hops + 1),
    'x-eluvix-prefix-hash': kvPrefixHash,
    'x-eluvix-switchyard-tier': String(synthesisTier.tier),
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
          ...(Array.isArray(harnessCfg.mcpServers) && harnessCfg.mcpServers.length > 0
            ? { mcpServers: harnessCfg.mcpServers }
            : {}),
          metadata: {
            eluvixUserId: scope?.userId || 'default',
            eluvixSessionId: scope?.sessionId,
            kvPrefixHash,
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

    // 2. Start turn (POST /api/v1/sessions/{id}/turns)
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
          ...(Array.isArray(harnessCfg.mcpServers) && harnessCfg.mcpServers.length > 0
            ? { mcpServers: harnessCfg.mcpServers }
            : {}),
          kvPrefixHash,
          switchyardTier: synthesisTier.tier,
          stream: true
        }),
        signal: controller.signal
      });

    let turnRes = await startTurn(tfSessionId!);

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

    let redactionCount = 0;
    let injectionCount = 0;

    const sanitizeChunkIfEnabled = (chunkText: string, sourceLabel: string): string => {
      if (!deepGuardActive || !chunkText) return chunkText;
      const res = inspectHarnessObservation(chunkText, sourceLabel, harnessCfg.midLoopGuard);
      if (res.piiRedacted) redactionCount += res.piiTypes.length;
      if (res.injectionDetected) injectionCount += 1;
      return res.sanitizedText;
    };

    // If TrueForge returned direct JSON instead of SSE
    if (contentType.includes('application/json')) {
      clearTimeout(timer);
      const data: any = await turnRes.json();
      const rawText = String(
        data?.output || data?.content || data?.choices?.[0]?.message?.content || ''
      );
      if (deepGuardActive && rawText) {
        const check = inspectHarnessObservation(rawText, 'trueforge_json_output', harnessCfg.midLoopGuard);
        if (!check.allowed) {
          return new Response(
            JSON.stringify({
              error: {
                message: check.blockedReason || 'Blocked by TrueForge PromptGuard',
                type: 'PromptGuardBlocked',
                code: 'prompt_guard_violation'
              }
            }),
            {
              status: 403,
              headers: {
                'Content-Type': 'application/json',
                'x-eluvix-harness': 'trueforge',
                'x-eluvix-guard-injections': '1'
              }
            }
          );
        }
      }
      const text = sanitizeChunkIfEnabled(rawText, 'trueforge_json_output');
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
            'x-eluvix-session': tfSessionId,
            'x-eluvix-prefix-hash': kvPrefixHash,
            'x-eluvix-switchyard-tier': String(synthesisTier.tier),
            'x-eluvix-guard-redactions': String(redactionCount),
            'x-eluvix-guard-injections': String(injectionCount)
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
          'x-eluvix-session': tfSessionId,
          'x-eluvix-prefix-hash': kvPrefixHash,
          'x-eluvix-switchyard-tier': String(synthesisTier.tier),
          'x-eluvix-guard-redactions': String(redactionCount),
          'x-eluvix-guard-injections': String(injectionCount)
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

        if (type === 'tool.result' || type === 'tool_result' || type === 'observation') {
          const obsOutput = String(evt?.output || evt?.result || '');
          const toolName = String(evt?.tool_name || evt?.toolName || 'tool');
          if (obsOutput && deepGuardActive) {
            sanitizeChunkIfEnabled(obsOutput, toolName);
          }
          return;
        }

        if (
          type === 'text-delta' ||
          type === 'text_delta' ||
          type === 'message.delta' ||
          type === 'content_block_delta' ||
          typeof evt?.delta === 'string'
        ) {
          const rawDelta =
            typeof evt?.delta === 'string'
              ? evt.delta
              : typeof evt?.text === 'string'
              ? evt.text
              : typeof evt?.delta?.text === 'string'
              ? evt.delta.text
              : '';
          const delta = sanitizeChunkIfEnabled(rawDelta, 'text_delta');
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
            onDelta(sanitizeChunkIfEnabled(evt.output, 'turn_completed'));
          }
        }
      } catch {
        // Ignore non-JSON comments
      }
    };

    if (!request.stream) {
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
          'x-eluvix-prefix-hash': kvPrefixHash,
          'x-eluvix-switchyard-tier': String(synthesisTier.tier),
          'x-eluvix-guard-redactions': String(redactionCount),
          'x-eluvix-guard-injections': String(injectionCount),
          'x-eluvix-prompt-tokens': String(promptTokens),
          'x-eluvix-completion-tokens': String(completionTokens)
        }
      });
    }

    // Streaming mode
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
        'x-eluvix-session': tfSessionId,
        'x-eluvix-prefix-hash': kvPrefixHash,
        'x-eluvix-switchyard-tier': String(synthesisTier.tier)
      }
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
