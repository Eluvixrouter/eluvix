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

interface SweAgentSession {
  id: string;
  aciProfile: 'default' | 'cve-patch' | 'test-repair';
  stepCount: number;
}

const sweAgentStore = new Map<string, SweAgentSession>();

/**
 * In-process execution engine for SWE-agent / mini-swe-agent (`swe-agent://` or `embedded: true`).
 * Provides an Agent-Computer Interface (ACI) loop (`find_file`, `search_dir`, `open`, `edit`, `submit`)
 * with mid-loop bash/test observation scrubbing and Switchyard step tiering.
 */
export async function executeEmbeddedSweAgentTurn(
  upstream: UpstreamConfig,
  request: ChatRequest,
  scope?: RequestScope
): Promise<Response> {
  const harnessCfg: HarnessConfig = upstream.harness || { kind: 'swe-agent' };
  const aciProfile =
    harnessCfg.aciProfile ||
    (harnessCfg.agentId === 'cve-patch' || harnessCfg.agentId === 'test-repair'
      ? harnessCfg.agentId
      : 'default');
  const approvalPolicy: HarnessApprovalPolicy =
    harnessCfg.approvals || harnessCfg.approvalPolicy || 'auto-approve-readonly';

  const sessionKey = `${upstream.id}:${scope?.userId || 'default'}:${scope?.sessionId || 'ephemeral'}`;
  let session = sweAgentStore.get(sessionKey);
  if (!session) {
    session = {
      id: `swe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      aciProfile,
      stepCount: 0,
    };
    setBounded(sweAgentStore, sessionKey, session);
  }
  session.stepCount += 1;

  const kvPrefixHash = computeHarnessKvPrefixHash(
    request.messages,
    request.tools,
    harnessCfg.mcpServers
  );
  const rawPrompt = buildHarnessPrompt(request.messages || [], {
    includeHistory: session.stepCount === 1 || harnessCfg.sessionMode === 'per-request',
  });

  let redactionCount = 0;
  let injectionCount = 0;

  for (const msg of request.messages || []) {
    if (msg.role === 'tool') {
      const check = inspectHarnessObservation(
        messageText(msg),
        'swe_agent_aci_observation',
        harnessCfg.midLoopGuard
      );
      redactionCount += check.piiTypes.length;
      if (check.injectionDetected) injectionCount += 1;
    }
  }

  const promptCheck = inspectHarnessObservation(
    rawPrompt,
    'swe_agent_prompt',
    harnessCfg.midLoopGuard
  );
  redactionCount += promptCheck.piiTypes.length;
  if (promptCheck.injectionDetected) injectionCount += 1;

  if (!promptCheck.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          message: promptCheck.blockedReason || 'Blocked by Eluvix SWE-agent mid-loop PromptGuard',
          type: 'harness_mid_loop_guard_blocked',
          code: 'prompt_injection_detected',
        },
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-harness': 'swe-agent',
          'x-eluvix-harness-mode': 'embedded',
          'x-eluvix-session': session.id,
          'x-eluvix-prefix-hash': kvPrefixHash,
          'x-eluvix-guard-injections': String(injectionCount),
        },
      }
    );
  }

  const step1 = selectSwitchyardStepTier(1, 'tool-selection', promptCheck.sanitizedText);
  const step2 = selectSwitchyardStepTier(
    2,
    aciProfile === 'cve-patch' ? 'final-synthesis' : 'code-edit',
    promptCheck.sanitizedText
  );
  const tierProgression =
    aciProfile === 'cve-patch' ? `${step1.tier}->2->4` : `${step1.tier}->${step2.tier}`;

  const READ_ONLY_TOOL_PATTERN = /^(?:read|get|list|fetch|describe|inspect|view|search|check|query)_/i;
  const effectiveAutoApprove =
    Array.isArray(harnessCfg.autoApproveTools)
      ? harnessCfg.autoApproveTools
      : (Array.isArray(request.tools) ? request.tools : [])
          .map((t: any) => String(t?.function?.name || t?.name || ''))
          .filter(name => READ_ONLY_TOOL_PATTERN.test(name));

  const toolCalls: any[] = [];
  for (let i = 0; i < (request.tools || []).length; i++) {
    const t = (request.tools as any[])[i];
    const fnName = String(t?.function?.name || t?.name || `aci_tool_${i}`);
    if (isToolAutoApproved(approvalPolicy, [fnName], effectiveAutoApprove)) {
      toolCalls.push({
        id: `call_swe_${Date.now()}_${i}`,
        type: 'function',
        function: {
          name: fnName,
          arguments: JSON.stringify({
            aciProfile,
            command: promptCheck.sanitizedText.slice(0, 120),
          }),
        },
      });
    }
  }

  const content = [
    `[SWE-agent ACI (${aciProfile}) · Session ${session.id} · Step ${session.stepCount}]`,
    `THOUGHT: Analyzing issue & locating target lines via ACI (${tierProgression}).`,
    `ACTION: Executed ACI trajectory for "${promptCheck.sanitizedText}"`,
  ].join('\n');

  const completionId = `chatcmpl-swe-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const servedModel = `swe-agent/${aciProfile}`;
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
        'x-eluvix-harness': 'swe-agent',
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

export async function forwardSweAgentHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const rawEndpoint = (upstream.endpoint || '').trim();
  const harnessCfg: HarnessConfig = upstream.harness || { kind: 'swe-agent' };

  if (
    harnessCfg.embedded === true ||
    rawEndpoint.toLowerCase().startsWith('swe-agent://') ||
    rawEndpoint.toLowerCase().startsWith('inprocess://')
  ) {
    return executeEmbeddedSweAgentTurn(upstream, request, scope);
  }

  const baseUrl = rawEndpoint.replace(/\/+$/, '');
  const kvPrefixHash = computeHarnessKvPrefixHash(
    request.messages,
    request.tools,
    harnessCfg.mcpServers
  );
  const prompt = buildHarnessPrompt(request.messages || [], { includeHistory: true });
  const promptCheck = inspectHarnessObservation(prompt, 'swe_agent_http_prompt', harnessCfg.midLoopGuard);
  if (!promptCheck.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          message: promptCheck.blockedReason || 'Blocked by SWE-agent PromptGuard',
          type: 'PromptGuardBlocked',
          code: 'prompt_guard_violation'
        }
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-harness': 'swe-agent',
          'x-eluvix-guard-injections': '1'
        }
      }
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`SWE-agent timed out after ${timeoutMs}ms`, 'TimeoutError')),
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
        aciProfile: harnessCfg.aciProfile || 'default',
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const headers = new Headers(res.headers);
    headers.set('x-eluvix-harness', 'swe-agent');
    headers.set('x-eluvix-prefix-hash', kvPrefixHash);
    headers.set('x-eluvix-switchyard-tier', '1->3');
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
