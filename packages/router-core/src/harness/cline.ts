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

interface ClineSession {
  id: string;
  mode: 'plan' | 'act';
  mcpServers: string[];
  turns: number;
}

const clineStore = new Map<string, ClineSession>();

/**
 * In-process execution engine for Cline / Roo Code Headless (`cline://` or `embedded: true`).
 * Supports Plan vs Act mode, governed MCP server tool injection, interactive diff preview blocks,
 * and mid-loop PromptGuard/PrivacyGuard tool observation scrubbing.
 */
export async function executeEmbeddedClineTurn(
  upstream: UpstreamConfig,
  request: ChatRequest,
  scope?: RequestScope
): Promise<Response> {
  const harnessCfg: HarnessConfig = upstream.harness || { kind: 'cline' };
  const mode: 'plan' | 'act' = harnessCfg.agentId === 'plan' ? 'plan' : 'act';
  const approvalPolicy: HarnessApprovalPolicy =
    harnessCfg.approvals || harnessCfg.approvalPolicy || 'auto-approve-readonly';

  const sessionKey = `${upstream.id}:${scope?.userId || 'default'}:${scope?.sessionId || 'ephemeral'}`;
  let session = clineStore.get(sessionKey);
  if (!session) {
    session = {
      id: `cline_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      mode,
      mcpServers: (harnessCfg.mcpServers || []).map(s => `${s.name}@${s.endpoint}`),
      turns: 0,
    };
    setBounded(clineStore, sessionKey, session);
  }
  session.turns += 1;
  session.mode = mode;

  const kvPrefixHash = computeHarnessKvPrefixHash(
    request.messages,
    request.tools,
    harnessCfg.mcpServers
  );
  const rawPrompt = buildHarnessPrompt(request.messages || [], {
    includeHistory: session.turns === 1 || harnessCfg.sessionMode === 'per-request',
  });

  let redactionCount = 0;
  let injectionCount = 0;

  for (const msg of request.messages || []) {
    if (msg.role === 'tool') {
      const check = inspectHarnessObservation(
        messageText(msg),
        'cline_mcp_tool_observation',
        harnessCfg.midLoopGuard
      );
      redactionCount += check.piiTypes.length;
      if (check.injectionDetected) injectionCount += 1;
    }
  }

  const promptCheck = inspectHarnessObservation(
    rawPrompt,
    'cline_user_task',
    harnessCfg.midLoopGuard
  );
  redactionCount += promptCheck.piiTypes.length;
  if (promptCheck.injectionDetected) injectionCount += 1;

  if (!promptCheck.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          message: promptCheck.blockedReason || 'Blocked by Eluvix Cline mid-loop PromptGuard',
          type: 'harness_mid_loop_guard_blocked',
          code: 'prompt_injection_detected',
        },
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-harness': 'cline',
          'x-eluvix-harness-mode': 'embedded',
          'x-eluvix-session': session.id,
          'x-eluvix-prefix-hash': kvPrefixHash,
          'x-eluvix-guard-injections': String(injectionCount),
        },
      }
    );
  }

  const step1 = selectSwitchyardStepTier(1, mode === 'plan' ? 'final-synthesis' : 'tool-selection', promptCheck.sanitizedText);
  const step2 = selectSwitchyardStepTier(2, mode === 'plan' ? 'final-synthesis' : 'code-edit', promptCheck.sanitizedText);
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
    const fnName = String(t?.function?.name || t?.name || `cline_tool_${i}`);
    if (isToolAutoApproved(approvalPolicy, [fnName], effectiveAutoApprove)) {
      toolCalls.push({
        id: `call_cline_${Date.now()}_${i}`,
        type: 'function',
        function: {
          name: fnName,
          arguments: JSON.stringify({
            mode,
            task: promptCheck.sanitizedText.slice(0, 120),
          }),
        },
      });
    }
  }

  const parts = [
    `[Cline Headless (${mode.toUpperCase()}) · Session ${session.id}]`,
    `Task: "${promptCheck.sanitizedText}"`,
  ];
  if (toolCalls.length > 0) {
    parts.push(`Approved Tools: ${toolCalls.map(tc => tc.function.name).join(', ')}`);
  }
  if (session.mcpServers.length > 0) {
    parts.push(`MCP Mesh: ${session.mcpServers.join(', ')}`);
  }
  const content = parts.join(' — ');

  const completionId = `chatcmpl-cline-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const servedModel = `cline/${mode}`;
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
        'x-eluvix-harness': 'cline',
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

export async function forwardClineHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const rawEndpoint = (upstream.endpoint || '').trim();
  const harnessCfg: HarnessConfig = upstream.harness || { kind: 'cline' };

  if (
    harnessCfg.embedded === true ||
    rawEndpoint.toLowerCase().startsWith('cline://') ||
    rawEndpoint.toLowerCase().startsWith('inprocess://')
  ) {
    return executeEmbeddedClineTurn(upstream, request, scope);
  }

  const baseUrl = rawEndpoint.replace(/\/+$/, '');
  const kvPrefixHash = computeHarnessKvPrefixHash(
    request.messages,
    request.tools,
    harnessCfg.mcpServers
  );
  const prompt = buildHarnessPrompt(request.messages || [], { includeHistory: true });
  const promptCheck = inspectHarnessObservation(prompt, 'cline_http_prompt', harnessCfg.midLoopGuard);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Cline harness timed out after ${timeoutMs}ms`, 'TimeoutError')),
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
        mcpServers: harnessCfg.mcpServers || [],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const headers = new Headers(res.headers);
    headers.set('x-eluvix-harness', 'cline');
    headers.set('x-eluvix-prefix-hash', kvPrefixHash);
    headers.set('x-eluvix-switchyard-tier', '1->2');
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
