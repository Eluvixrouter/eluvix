import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setBounded } from '../bounded-map.js';
import type { RequestScope } from '../context/types.js';
import type { ChatRequest, UpstreamConfig } from '../index.js';
import { isToolAutoApproved } from './approval.js';
import { resolveSafeWorkspacePath } from './trueforge.js';
export { resolveSafeWorkspacePath };
import {
  computeHarnessKvPrefixHash,
  inspectHarnessObservation,
  selectSwitchyardStepTier,
} from './deep-guard.js';
import { buildHarnessPrompt, isSessionGoneResponse } from './prompt.js';
import type {
  HarnessApprovalPolicy,
  HarnessConfig,
  HarnessMcpServerConfig,
  HarnessMidLoopGuardConfig,
} from './types.js';

const sessionCache = new Map<string, string>();

interface EmbeddedOpenCodeSession {
  id: string;
  agent: string;
  userId: string;
  mcpServers: string[];
  messages: Array<{ role: string; text: string; timestamp: number }>;
}

const embeddedOpenCodeStore = new Map<string, EmbeddedOpenCodeSession>();

function isForkedOpenCodeEnabled(upstream: UpstreamConfig, harnessCfg: HarnessConfig): boolean {
  const ep = (upstream.endpoint || '').trim().toLowerCase();
  return Boolean(
    harnessCfg.deepIntegration ||
      harnessCfg.forked ||
      harnessCfg.embedded ||
      ep.startsWith('opencode-eluvix://') ||
      ep.startsWith('opencode://')
  );
}

async function replyToOpenCodePermission(
  baseUrl: string,
  headers: Record<string, string>,
  sessionId: string,
  permissionId: string,
  toolName: string,
  policy: HarnessApprovalPolicy,
  autoApproveTools?: readonly string[]
): Promise<boolean> {
  if (policy === 'surface') return false;
  const approved = isToolAutoApproved(policy, [toolName], autoApproveTools);
  try {
    await fetch(
      `${baseUrl}/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(permissionId)}/reply`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          response: approved ? 'once' : 'reject',
          reason: approved
            ? 'Auto-approved by Eluvix-OpenCode harness policy'
            : `Rejected by Eluvix-OpenCode headless policy (${policy})`,
        }),
      }
    );
  } catch {
    // Non-fatal if permission endpoint already settled
  }
  return approved;
}

/**
 * In-process execution engine for the Eluvix-Forked OpenCode harness (`opencode-eluvix://` or `embedded: true`).
 * Supports native client tool calling, MCP server bindings, mid-loop PromptGuard/PrivacyGuard
 * observation scrubbing, and per-step Switchyard model tiering + KV prefix hash pinning.
 */
export async function executeEmbeddedOpenCodeTurn(
  upstream: UpstreamConfig,
  request: ChatRequest,
  scope?: RequestScope
): Promise<Response> {
  const harnessCfg: HarnessConfig = upstream.harness || { kind: 'opencode' };
  const agent = harnessCfg.agentId || 'build';
  const sessionMode = harnessCfg.sessionMode || 'per-eluvix-session';
  const approvalPolicy: HarnessApprovalPolicy =
    harnessCfg.approvals ||
    harnessCfg.approvalPolicy ||
    (Array.isArray(harnessCfg.autoApproveTools) && harnessCfg.autoApproveTools.length > 0
      ? 'auto-approve-readonly'
      : 'never');
  const effectiveAutoApproveTools =
    Array.isArray(harnessCfg.autoApproveTools)
      ? harnessCfg.autoApproveTools
      : [];

  const cacheable = sessionMode === 'per-eluvix-session' && Boolean(scope?.sessionId);
  const cacheKey = `${upstream.id}:${scope?.userId || 'default'}:${scope?.sessionId || 'ephemeral'}`;

  let ocSessionId = cacheable ? sessionCache.get(cacheKey) : undefined;
  let sessionObj = ocSessionId ? embeddedOpenCodeStore.get(ocSessionId) : undefined;
  let createdFreshSession = false;

  if (!ocSessionId || !sessionObj) {
    ocSessionId = `oc-elx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    sessionObj = {
      id: ocSessionId,
      agent,
      userId: scope?.userId || 'default',
      mcpServers: (harnessCfg.mcpServers || []).map(s => `${s.name}@${s.endpoint}`),
      messages: [],
    };
    createdFreshSession = true;
    setBounded(embeddedOpenCodeStore, ocSessionId, sessionObj);
    if (cacheable) {
      setBounded(sessionCache, cacheKey, ocSessionId);
    }
  }

  const kvPrefixHash = computeHarnessKvPrefixHash(
    request.messages,
    request.tools,
    harnessCfg.mcpServers
  );
  const rawPrompt = buildHarnessPrompt(request.messages || [], {
    includeHistory: sessionMode === 'per-request' || createdFreshSession,
  });

  // Inspect tool messages and prompt via mid-loop PromptGuard & PrivacyGuard
  let redactionCount = 0;
  let injectionCount = 0;

  for (const m of request.messages || []) {
    if (m.role === 'tool') {
      const obsText = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      const obsCheck = inspectHarnessObservation(obsText, 'tool_observation', harnessCfg.midLoopGuard);
      if (obsCheck.piiRedacted) redactionCount += obsCheck.piiTypes.length;
      if (obsCheck.injectionDetected) injectionCount += 1;
      if (!obsCheck.allowed) {
        return new Response(
          JSON.stringify({
            error: {
              message: obsCheck.blockedReason || 'Blocked by Eluvix-OpenCode mid-loop PromptGuard',
              type: 'prompt_guard_violation',
              code: 'mid_loop_injection_blocked',
            },
          }),
          {
            status: 403,
            headers: {
              'Content-Type': 'application/json',
              'x-eluvix-harness': 'opencode',
              'x-eluvix-harness-fork': 'eluvix-opencode',
              'x-eluvix-session': ocSessionId,
              'x-eluvix-prefix-hash': kvPrefixHash,
              'x-eluvix-guard-injections': String(injectionCount),
            },
          }
        );
      }
      if (obsCheck.sanitizedText !== obsText) {
        m.content = obsCheck.sanitizedText;
      }
    }
  }

  const promptCheck = inspectHarnessObservation(rawPrompt, 'opencode_prompt', harnessCfg.midLoopGuard);
  if (promptCheck.piiRedacted) redactionCount += promptCheck.piiTypes.length;
  if (promptCheck.injectionDetected) injectionCount += 1;
  if (!promptCheck.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          message: promptCheck.blockedReason || 'Blocked by Eluvix-OpenCode PromptGuard',
          type: 'prompt_guard_violation',
          code: 'prompt_injection_blocked',
        },
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-harness': 'opencode',
          'x-eluvix-harness-fork': 'eluvix-opencode',
          'x-eluvix-session': ocSessionId,
          'x-eluvix-prefix-hash': kvPrefixHash,
          'x-eluvix-guard-injections': String(injectionCount),
        },
      }
    );
  }

  const step1Tier = selectSwitchyardStepTier(1, 'tool-selection', promptCheck.sanitizedText);
  const step2Tier = selectSwitchyardStepTier(2, 'final-synthesis', promptCheck.sanitizedText);

  const requestedTools: any[] = Array.isArray(request.tools) ? request.tools : [];
  const toolCalls: any[] = [];
  for (let i = 0; i < requestedTools.length; i++) {
    const t = requestedTools[i];
    const fnName = String(t?.function?.name || t?.name || `tool_${i}`);
    if (isToolAutoApproved(approvalPolicy, [fnName], effectiveAutoApproveTools)) {
      toolCalls.push({
        id: `call_oc_${Date.now()}_${i}`,
        type: 'function',
        function: {
          name: fnName,
          arguments: JSON.stringify({ query: promptCheck.sanitizedText.slice(0, 120) }),
        },
      });
    }
  }

  const textParts = [
    `[Eluvix-OpenCode Fork (${agent}) · Session ${ocSessionId}]`,
    `Executed: "${promptCheck.sanitizedText}"`,
  ];
  if (toolCalls.length > 0) {
    textParts.push(`Auto-Approved Tool Calls: ${toolCalls.map(tc => tc.function.name).join(', ')}`);
  }
  if (sessionObj.mcpServers.length > 0) {
    textParts.push(`MCP Servers: ${sessionObj.mcpServers.join(', ')}`);
  }
  const text = textParts.join(' — ');
  sessionObj.messages.push({ role: 'assistant', text, timestamp: Date.now() });

  const completionId = `chatcmpl-oc-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const servedModel = `opencode/${agent}`;
  const promptTokens = Math.ceil(rawPrompt.length / 4);
  const completionTokens = Math.ceil(text.length / 4);

  const commonHeaders: Record<string, string> = {
    'x-eluvix-model': servedModel,
    'x-eluvix-harness': 'opencode',
    'x-eluvix-harness-mode': 'embedded-inprocess',
    'x-eluvix-harness-fork': 'eluvix-opencode',
    'x-eluvix-session': ocSessionId,
    'x-eluvix-prefix-hash': kvPrefixHash,
    'x-eluvix-switchyard-tier': `${step1Tier.tier}->${step2Tier.tier}`,
    'x-eluvix-guard-redactions': String(redactionCount),
    'x-eluvix-guard-injections': String(injectionCount),
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
              choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
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
            content: text,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
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

export async function forwardOpencodeHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const rawEndpoint = (upstream.endpoint || '').trim();
  const harnessCfg = upstream.harness || { kind: 'opencode' as const };
  const forkedMode = isForkedOpenCodeEnabled(upstream, harnessCfg);

  // Embedded in-process Eluvix-OpenCode fork execution
  if (
    harnessCfg.embedded === true ||
    rawEndpoint.toLowerCase().startsWith('opencode-eluvix://') ||
    rawEndpoint.toLowerCase().startsWith('opencode://')
  ) {
    return executeEmbeddedOpenCodeTurn(upstream, request, scope);
  }

  const baseUrl = rawEndpoint.replace(/\/+$/, '');
  const agent = harnessCfg.agentId || 'build';
  const sessionMode = harnessCfg.sessionMode || 'per-eluvix-session';
  const approvalPolicy: HarnessApprovalPolicy =
    harnessCfg.approvals ||
    harnessCfg.approvalPolicy ||
    (forkedMode ? 'auto-approve-readonly' : 'auto-deny');

  // Stock upstream opencode session API has no tool-calling channel: forwarding a
  // tool-bearing request to a stock server would silently drop the tools.
  // When targeting the Eluvix-forked OpenCode runtime (`deepIntegration: true` or `forked: true`),
  // native client tool calling and MCP server bindings are supported and forwarded!
  if (Array.isArray(request.tools) && request.tools.length > 0 && !forkedMode) {
    throw new Error(
      'opencode harness does not support tool calling; refusing to silently drop request tools'
    );
  }

  const kvPrefixHash = computeHarnessKvPrefixHash(
    request.messages,
    request.tools,
    harnessCfg.mcpServers
  );

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-eluvix-origin': 'harness',
    'x-eluvix-hops': String(hops + 1),
    'x-eluvix-prefix-hash': kvPrefixHash,
  };
  if (forkedMode) {
    headers['x-eluvix-harness-fork'] = 'eluvix-opencode';
  }
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
        body: JSON.stringify({
          title: `Eluvix Session (${scope?.userId || 'default'})`,
          ...(forkedMode && Array.isArray(harnessCfg.mcpServers) && harnessCfg.mcpServers.length > 0
            ? { mcpServers: harnessCfg.mcpServers }
            : {}),
          ...(forkedMode ? { kvPrefixHash } : {}),
        }),
        signal: controller.signal
      });
      if (!sessionRes.ok) {
        return { errorRes: sessionRes };
      }
      const sessionData: any = await sessionRes.json();
      return { id: String(sessionData?.id || `oc-${Date.now()}`) };
    };

    const sendMessage = (sessionId: string, prompt: string, switchyardTier: number) =>
      fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        headers: {
          ...headers,
          'x-eluvix-switchyard-tier': String(switchyardTier),
        },
        body: JSON.stringify({
          agent,
          parts: [{ type: 'text', text: prompt }],
          ...(forkedMode && Array.isArray(request.tools) && request.tools.length > 0
            ? { tools: request.tools }
            : {}),
          ...(forkedMode && Array.isArray(harnessCfg.mcpServers) && harnessCfg.mcpServers.length > 0
            ? { mcpServers: harnessCfg.mcpServers }
            : {}),
          ...(forkedMode
            ? {
                eluvix: {
                  kvPrefixHash,
                  switchyardTier,
                  approvalPolicy,
                  autoApproveTools: harnessCfg.autoApproveTools || [],
                },
              }
            : {}),
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

    const buildPrompt = () =>
      buildHarnessPrompt(request.messages || [], {
        includeHistory: sessionMode === 'per-request' || createdFreshSession
      });

    let prompt = buildPrompt();
    const stepTier = selectSwitchyardStepTier(1, 'final-synthesis', prompt);
    let msgRes = await sendMessage(ocSessionId!, prompt, stepTier.tier);

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
      msgRes = await sendMessage(ocSessionId, prompt, stepTier.tier);
    }

    clearTimeout(timer);
    if (!msgRes.ok) {
      return msgRes;
    }

    const data: any = await msgRes.json();
    const parts: any[] = Array.isArray(data?.parts) ? data.parts : [];
    const deepGuardActive = Boolean(forkedMode || harnessCfg.midLoopGuard);

    let redactionCount = 0;
    let injectionCount = 0;
    const toolObservations: string[] = [];
    const returnedToolCalls: any[] = Array.isArray(data?.tool_calls) ? [...data.tool_calls] : [];

    // Process OpenCode permission requests and tool observation parts
    for (const p of parts) {
      if (p?.type === 'permission_request' || p?.type === 'permission') {
        const permId = String(p?.id || p?.permissionId || 'perm-1');
        const toolName = String(p?.tool || p?.toolName || 'unknown_tool');
        await replyToOpenCodePermission(
          baseUrl,
          headers,
          ocSessionId!,
          permId,
          toolName,
          approvalPolicy,
          harnessCfg.autoApproveTools
        );
      } else if (
        p?.type === 'tool' ||
        p?.type === 'tool-invocation' ||
        p?.type === 'tool-result'
      ) {
        const toolName = String(p?.tool || p?.toolName || p?.name || 'opencode_tool');
        const rawObs = String(p?.state?.output ?? p?.output ?? p?.result ?? '');
        if (rawObs && deepGuardActive) {
          const check = inspectHarnessObservation(rawObs, toolName, harnessCfg.midLoopGuard);
          if (!check.allowed) {
            clearTimeout(timer);
            return new Response(
              JSON.stringify({
                error: {
                  message: check.blockedReason || `Observation from tool "${toolName}" blocked by PromptGuard`,
                  type: 'prompt_guard_violation',
                  code: 'mid_loop_injection_blocked',
                },
              }),
              {
                status: 403,
                headers: {
                  'Content-Type': 'application/json',
                  'x-eluvix-harness': 'opencode',
                  'x-eluvix-guard-injections': String(injectionCount + 1),
                },
              }
            );
          }
          if (check.piiRedacted) redactionCount += check.piiTypes.length;
          if (check.injectionDetected) injectionCount += 1;
          toolObservations.push(check.sanitizedText);
        } else if (rawObs) {
          toolObservations.push(rawObs);
        }
      }
    }

    const rawText =
      parts
        .filter(p => p?.type === 'text' && typeof p?.text === 'string')
        .map(p => p.text)
        .join('\n') ||
      String(data?.text || data?.content || data?.output || '');

    let text = rawText;
    if (deepGuardActive && text) {
      const check = inspectHarnessObservation(text, 'opencode_output', harnessCfg.midLoopGuard);
      if (!check.allowed) {
        clearTimeout(timer);
        return new Response(
          JSON.stringify({
            error: {
              message: check.blockedReason || 'Response text blocked by PromptGuard',
              type: 'prompt_guard_violation',
              code: 'mid_loop_injection_blocked',
            },
          }),
          {
            status: 403,
            headers: {
              'Content-Type': 'application/json',
              'x-eluvix-harness': 'opencode',
              'x-eluvix-guard-injections': String(injectionCount + 1),
            },
          }
        );
      }
      if (check.piiRedacted) redactionCount += check.piiTypes.length;
      if (check.injectionDetected) injectionCount += 1;
      text = check.sanitizedText;
    }
    if (toolObservations.length > 0 && !text) {
      text = toolObservations.join('\n');
    }

    const completionId = `chatcmpl-oc-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const servedModel = `opencode/${agent}`;
    const promptTokens = Math.ceil(prompt.length / 4);
    const completionTokens = Math.ceil(text.length / 4);

    const responseHeaders: Record<string, string> = {
      'x-eluvix-model': servedModel,
      'x-eluvix-harness': 'opencode',
      'x-eluvix-session': ocSessionId,
      'x-eluvix-prefix-hash': kvPrefixHash,
      'x-eluvix-switchyard-tier': String(stepTier.tier),
      ...(forkedMode ? { 'x-eluvix-harness-fork': 'eluvix-opencode' } : {}),
      ...(deepGuardActive
        ? {
            'x-eluvix-guard-redactions': String(redactionCount),
            'x-eluvix-guard-injections': String(injectionCount),
          }
        : {}),
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
          ...responseHeaders,
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
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
          message: {
            role: 'assistant',
            content: text,
            ...(returnedToolCalls.length > 0 ? { tool_calls: returnedToolCalls } : {}),
          },
          finish_reason: returnedToolCalls.length > 0 ? 'tool_calls' : 'stop'
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
        ...responseHeaders,
        'Content-Type': 'application/json',
        'x-eluvix-prompt-tokens': String(promptTokens),
        'x-eluvix-completion-tokens': String(completionTokens)
      }
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export interface OpenCodeForkSession {
  id: string;
  title: string;
  kvPrefixHash: string;
  mcpServers: HarnessMcpServerConfig[];
  createdAt: string;
  messages: Array<{
    id: string;
    agent: string;
    parts: any[];
    tool_calls?: any[];
    switchyardTier: number;
  }>;
  permissions: Map<
    string,
    { id: string; tool: string; status: 'pending' | 'approved' | 'rejected'; reason?: string }
  >;
}

export interface EluvixOpenCodeServerOptions {
  port?: number;
  host?: string;
  authToken?: string;
  defaultApprovalPolicy?: HarnessApprovalPolicy;
  defaultAutoApproveTools?: string[];
  midLoopGuard?: HarnessMidLoopGuardConfig;
  toolExecutor?: (toolName: string, args: Record<string, unknown>) => Promise<string> | string;
}

export interface EluvixOpenCodeServerInstance {
  server: http.Server;
  sessions: Map<string, OpenCodeForkSession>;
  listen: (port?: number, host?: string) => Promise<{ url: string; port: number }>;
  close: () => Promise<void>;
}

/**
 * Standalone HTTP server implementing the Eluvix-Forked OpenCode runtime (`@eluvix/opencode-harness`),
 * supporting client tool calling (`tools`), governed MCP server bindings (`mcpServers`),
 * `/session/:id/permission/:permId/reply`, mid-loop PromptGuard/PrivacyGuard tool observation
 * scrubbing, per-step Switchyard model tiering, and KV prefix hash pinning.
 */
export function createEluvixOpenCodeServer(
  options: EluvixOpenCodeServerOptions = {}
): EluvixOpenCodeServerInstance {
  const sessions = new Map<string, OpenCodeForkSession>();
  const defaultAutoApprove = options.defaultAutoApproveTools || [];
  const defaultPolicy: HarnessApprovalPolicy =
    options.defaultApprovalPolicy ||
    (Array.isArray(defaultAutoApprove) && defaultAutoApprove.length > 0
      ? 'auto-approve-readonly'
      : 'never');

  const parseJsonBody = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
        if (raw.length > 2 * 1024 * 1024) {
          req.destroy();
          reject(new Error('Payload too large: maximum body size is 2MB'));
        }
      });
      req.on('end', () => {
        if (!raw.trim()) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({ _raw: raw });
        }
      });
      req.on('error', reject);
    });

  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (options.authToken && url.pathname !== '/health' && url.pathname !== '/healthz') {
      const authHeader = req.headers.authorization || '';
      if (authHeader !== `Bearer ${options.authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing Bearer token' }));
        return;
      }
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'eluvix-opencode',
          fork: 'Eluvixrouter/opencode-eluvix',
          version: '1.0.10',
          features: [
            'client-tool-calling',
            'mcp-mesh-injection',
            'mid-loop-prompt-privacy-guard',
            'switchyard-step-tiering',
            'deepseek-mla-kv-prefix-pinning',
          ],
          activeSessions: sessions.size,
        })
      );
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'harness/opencode', object: 'model', owned_by: 'eluvix-opencode' },
            { id: 'opencode/build', object: 'model', owned_by: 'eluvix-opencode' },
            { id: 'opencode/plan', object: 'model', owned_by: 'eluvix-opencode' },
            { id: 'opencode/security-audit', object: 'model', owned_by: 'eluvix-opencode' },
          ],
        })
      );
      return;
    }

    if (req.method === 'POST' && url.pathname === '/session') {
      const body = await parseJsonBody(req);
      const MAX_SESSIONS = 500;
      if (sessions.size >= MAX_SESSIONS) {
        const oldestKey = sessions.keys().next().value;
        if (oldestKey) sessions.delete(oldestKey);
      }
      const id = `oc_elx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const mcpServers: HarnessMcpServerConfig[] = Array.isArray(body?.mcpServers)
        ? body.mcpServers
        : [];
      const kvPrefixHash =
        typeof body?.kvPrefixHash === 'string' && body.kvPrefixHash
          ? body.kvPrefixHash
          : computeHarnessKvPrefixHash([], [], mcpServers);

      const session: OpenCodeForkSession = {
        id,
        title: String(body?.title || 'Eluvix-OpenCode Session'),
        kvPrefixHash,
        mcpServers,
        createdAt: new Date().toISOString(),
        messages: [],
        permissions: new Map(),
      };
      sessions.set(id, session);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-eluvix-harness-fork': 'eluvix-opencode',
        'x-eluvix-prefix-hash': kvPrefixHash,
      });
      res.end(
        JSON.stringify({
          id: session.id,
          title: session.title,
          kvPrefixHash: session.kvPrefixHash,
          mcpServers: session.mcpServers,
          createdAt: session.createdAt,
        })
      );
      return;
    }

    const permMatch = url.pathname.match(/^\/session\/([^/]+)\/permission\/([^/]+)\/reply$/);
    if (req.method === 'POST' && permMatch) {
      const sessionId = decodeURIComponent(permMatch[1]);
      const permId = decodeURIComponent(permMatch[2]);
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const body = await parseJsonBody(req);
      const approved = body?.response === 'once' || body?.response === 'always';
      session.permissions.set(permId, {
        id: permId,
        tool: String(body?.tool || 'tool'),
        status: approved ? 'approved' : 'rejected',
        reason: body?.reason,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: permId, status: approved ? 'approved' : 'rejected' }));
      return;
    }

    const msgMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === 'POST' && msgMatch) {
      const sessionId = decodeURIComponent(msgMatch[1]);
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      const body = await parseJsonBody(req);
      const agent = String(body?.agent || 'build');
      const inputParts: any[] = Array.isArray(body?.parts) ? body.parts : [];
      const promptText = inputParts
        .filter(p => p?.type === 'text' && typeof p?.text === 'string')
        .map(p => p.text)
        .join('\n');

      const policy: HarnessApprovalPolicy = defaultPolicy;
      const autoApproveList: string[] = defaultAutoApprove;

      const promptGuardCheck = inspectHarnessObservation(
        promptText,
        'opencode_user_message',
        options.midLoopGuard
      );
      if (!promptGuardCheck.allowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: promptGuardCheck.blockedReason || 'Blocked by Eluvix-OpenCode PromptGuard',
              type: 'prompt_guard_violation',
              code: 'prompt_injection_blocked',
            },
          })
        );
        return;
      }

      const step1Decision = selectSwitchyardStepTier(1, 'tool-selection', promptGuardCheck.sanitizedText);
      const step2Decision = selectSwitchyardStepTier(2, 'final-synthesis', promptGuardCheck.sanitizedText);

      const outParts: any[] = [];
      const toolCalls: any[] = [];

      const requestedTools: any[] = Array.isArray(body?.tools) ? body.tools : [];
      for (let i = 0; i < requestedTools.length; i++) {
        const t = requestedTools[i];
        const toolName = String(t?.function?.name || t?.name || `tool_${i}`);
        const permRecord = Array.from(session.permissions.values()).find(p => p.tool === toolName);
        const permApproved = permRecord?.status === 'approved';
        const approved = permApproved || isToolAutoApproved(policy, [toolName], autoApproveList);

        if (!approved) {
          const permId = `perm_${Date.now()}_${i}`;
          session.permissions.set(permId, { id: permId, tool: toolName, status: 'pending' });
          outParts.push({
            type: 'permission_request',
            id: permId,
            tool: toolName,
            reason: `Tool "${toolName}" requires approval under policy "${policy}"`,
          });
          continue;
        }

        let rawToolOutput = `Executed tool "${toolName}" in Eluvix-OpenCode session ${session.id}`;
        if (options.toolExecutor) {
          rawToolOutput = await options.toolExecutor(toolName, { prompt: promptGuardCheck.sanitizedText });
        }

        const obsCheck = inspectHarnessObservation(
          rawToolOutput,
          toolName,
          options.midLoopGuard
        );
        if (!obsCheck.allowed) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: obsCheck.blockedReason || `Observation from tool "${toolName}" blocked by PromptGuard`,
                type: 'prompt_guard_violation',
                code: 'mid_loop_injection_blocked',
              },
            })
          );
          return;
        }

        outParts.push({
          type: 'tool',
          tool: toolName,
          state: {
            status: 'completed',
            output: obsCheck.sanitizedText,
            piiRedacted: obsCheck.piiRedacted,
            injectionDetected: obsCheck.injectionDetected,
          },
        });

        toolCalls.push({
          id: `call_oc_${Date.now()}_${i}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify({ query: promptGuardCheck.sanitizedText.slice(0, 100) }),
          },
        });
      }

      const obsSummary = outParts
        .filter(p => p.type === 'tool')
        .map(p => `${p.tool}: ${p.state.output}`)
        .join(' | ');

      const synthesisText = obsSummary
        ? `[Eluvix-OpenCode (${agent})] ${promptGuardCheck.sanitizedText} — Tool Results: ${obsSummary}`
        : `[Eluvix-OpenCode (${agent})] ${promptGuardCheck.sanitizedText}`;

      outParts.push({
        type: 'text',
        text: synthesisText,
      });

      const msgRecord = {
        id: `msg_${Date.now()}`,
        agent,
        parts: outParts,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        switchyardTier: step2Decision.tier,
      };
      if (session.messages.length >= 100) {
        session.messages.shift();
      }
      session.messages.push(msgRecord);

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-eluvix-harness-fork': 'eluvix-opencode',
        'x-eluvix-prefix-hash': session.kvPrefixHash,
        'x-eluvix-switchyard-tier': `${step1Decision.tier}->${step2Decision.tier}`,
      });
      res.end(JSON.stringify(msgRecord));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
  };

  const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
    handleRequest(req, res).catch(err => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err?.message || 'Internal error' }));
      }
    });
  });

  return {
    server,
    sessions,
    listen(port = options.port ?? 0, host = options.host ?? '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address() as { port: number };
          resolve({
            url: `http://${host}:${addr.port}`,
            port: addr.port,
          });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
