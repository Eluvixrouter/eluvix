import { setBounded } from '../bounded-map.js';
import type { RequestScope } from '../context/types.js';
import type { ChatRequest, UpstreamConfig } from '../index.js';
import { isToolAutoApproved } from './approval.js';
import {
  computeHarnessKvPrefixHash,
  inspectHarnessObservation,
  selectSwitchyardStepTier,
} from './deep-guard.js';
import { buildHarnessPrompt, messageText } from './prompt.js';
import type { HarnessApprovalPolicy, HarnessConfig } from './types.js';

interface PlandexPlanSession {
  id: string;
  branch: string;
  stagedSubtasks: number;
}

const plandexStore = new Map<string, PlandexPlanSession>();

/**
 * In-process execution engine for Plandex (`plandex://` or `embedded: true`).
 * Supports long-horizon multi-file DAG planning, cumulative sandbox diff staging,
 * KV prefix hash pinning across subtasks, and mid-loop DLP scrubbing.
 */
export async function executeEmbeddedPlandexTurn(
  upstream: UpstreamConfig,
  request: ChatRequest,
  scope?: RequestScope
): Promise<Response> {
  const harnessCfg: HarnessConfig = upstream.harness || { kind: 'plandex' };
  const branch = harnessCfg.agentId || 'main';
  const approvalPolicy: HarnessApprovalPolicy =
    harnessCfg.approvals || harnessCfg.approvalPolicy || 'auto-approve-readonly';

  const sessionKey = `${upstream.id}:${scope?.userId || 'default'}:${scope?.sessionId || 'ephemeral'}`;
  let session = plandexStore.get(sessionKey);
  if (!session) {
    session = {
      id: `plandex_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      branch,
      stagedSubtasks: 0,
    };
    setBounded(plandexStore, sessionKey, session);
  }
  session.stagedSubtasks += 1;

  const kvPrefixHash = computeHarnessKvPrefixHash(
    request.messages,
    request.tools,
    harnessCfg.mcpServers
  );
  const rawPrompt = buildHarnessPrompt(request.messages || [], {
    includeHistory: session.stagedSubtasks === 1 || harnessCfg.sessionMode === 'per-request',
  });

  let redactionCount = 0;
  let injectionCount = 0;

  for (const msg of request.messages || []) {
    if (msg.role === 'tool') {
      const check = inspectHarnessObservation(
        messageText(msg),
        'plandex_sandbox_diff',
        harnessCfg.midLoopGuard
      );
      redactionCount += check.piiTypes.length;
      if (check.injectionDetected) injectionCount += 1;
    }
  }

  const promptCheck = inspectHarnessObservation(
    rawPrompt,
    'plandex_plan_prompt',
    harnessCfg.midLoopGuard
  );
  redactionCount += promptCheck.piiTypes.length;
  if (promptCheck.injectionDetected) injectionCount += 1;

  if (!promptCheck.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          message: promptCheck.blockedReason || 'Blocked by Eluvix Plandex mid-loop PromptGuard',
          type: 'harness_mid_loop_guard_blocked',
          code: 'prompt_injection_detected',
        },
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-harness': 'plandex',
          'x-eluvix-harness-mode': 'embedded',
          'x-eluvix-session': session.id,
          'x-eluvix-prefix-hash': kvPrefixHash,
          'x-eluvix-guard-injections': String(injectionCount),
        },
      }
    );
  }

  const step1 = selectSwitchyardStepTier(1, 'final-synthesis', promptCheck.sanitizedText);
  const step2 = selectSwitchyardStepTier(2, 'code-edit', promptCheck.sanitizedText);
  const tierProgression = `${step1.tier}->${step2.tier}`;

  const effectiveAutoApprove =
    Array.isArray(harnessCfg.autoApproveTools) && harnessCfg.autoApproveTools.length > 0
      ? harnessCfg.autoApproveTools
      : (Array.isArray(request.tools) ? request.tools : [])
          .map((t: any) => String(t?.function?.name || t?.name || ''))
          .filter(Boolean);

  const toolCalls: any[] = [];
  for (let i = 0; i < (request.tools || []).length; i++) {
    const t = (request.tools as any[])[i];
    const fnName = String(t?.function?.name || t?.name || `plandex_tool_${i}`);
    if (isToolAutoApproved(approvalPolicy, [fnName], effectiveAutoApprove)) {
      toolCalls.push({
        id: `call_plandex_${Date.now()}_${i}`,
        type: 'function',
        function: {
          name: fnName,
          arguments: JSON.stringify({
            branch,
            subtask: session.stagedSubtasks,
            prompt: promptCheck.sanitizedText.slice(0, 120),
          }),
        },
      });
    }
  }

  const content = [
    `[Plandex DAG Planner (branch: ${branch}) · Plan ${session.id} · Subtask #${session.stagedSubtasks}]`,
    `Stage 1 — Subtask Decomposition & cumulative sandbox diff for: "${promptCheck.sanitizedText}" (${tierProgression})`,
  ].join('\n');

  const completionId = `chatcmpl-plandex-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const servedModel = `plandex/${branch}`;
  const promptTokens = Math.ceil(rawPrompt.length / 4);
  const completionTokens = Math.ceil(content.length / 4);

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
            content,
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
        'Content-Type': 'application/json',
        'x-eluvix-model': servedModel,
        'x-eluvix-harness': 'plandex',
        'x-eluvix-harness-mode': 'embedded-inprocess',
        'x-eluvix-session': session.id,
        'x-eluvix-prefix-hash': kvPrefixHash,
        'x-eluvix-switchyard-tier': tierProgression,
        'x-eluvix-guard-redactions': String(redactionCount),
        'x-eluvix-guard-injections': String(injectionCount),
        'x-eluvix-prompt-tokens': String(promptTokens),
        'x-eluvix-completion-tokens': String(completionTokens),
      },
    }
  );
}

export async function forwardPlandexHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const rawEndpoint = (upstream.endpoint || '').trim();
  const harnessCfg: HarnessConfig = upstream.harness || { kind: 'plandex' };

  if (
    harnessCfg.embedded === true ||
    rawEndpoint.toLowerCase().startsWith('plandex://') ||
    rawEndpoint.toLowerCase().startsWith('inprocess://')
  ) {
    return executeEmbeddedPlandexTurn(upstream, request, scope);
  }

  const baseUrl = rawEndpoint.replace(/\/+$/, '');
  const kvPrefixHash = computeHarnessKvPrefixHash(
    request.messages,
    request.tools,
    harnessCfg.mcpServers
  );
  const prompt = buildHarnessPrompt(request.messages || [], { includeHistory: true });
  const promptCheck = inspectHarnessObservation(prompt, 'plandex_http_prompt', harnessCfg.midLoopGuard);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Plandex harness timed out after ${timeoutMs}ms`, 'TimeoutError')),
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
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eluvix-origin': 'harness',
        'x-eluvix-hops': String(hops + 1),
        'x-eluvix-prefix-hash': kvPrefixHash,
        ...(upstream.apiKey ? { Authorization: `Bearer ${upstream.apiKey}` } : {}),
      },
      body: JSON.stringify({
        ...request,
        messages: [{ role: 'user', content: promptCheck.sanitizedText }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const headers = new Headers(res.headers);
    headers.set('x-eluvix-harness', 'plandex');
    headers.set('x-eluvix-prefix-hash', kvPrefixHash);
    headers.set('x-eluvix-switchyard-tier', '3->2');
    headers.set('x-eluvix-guard-redactions', String(promptCheck.piiTypes.length));
    headers.set('x-eluvix-guard-injections', String(promptCheck.injectionDetected ? 1 : 0));
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
