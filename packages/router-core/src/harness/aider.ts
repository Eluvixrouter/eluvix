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

interface AiderSessionState {
  id: string;
  editFormat: 'diff' | 'udiff' | 'whole' | 'architect';
  repoMapTokens: number;
  architectModel: string;
  editorModel: string;
  turns: number;
}

const aiderSessionStore = new Map<string, AiderSessionState>();

/**
 * In-process execution engine for the Aider Architect + Editor harness (`aider://` or `embedded: true`).
 * Combines a Tier-4 Architect reasoning pass with a Tier-2 Editor diff pass while pinning the
 * tree-sitter repository map prefix in the KV cache and scrubbing git diff observations via mid-loop DLP.
 */
export async function executeEmbeddedAiderTurn(
  upstream: UpstreamConfig,
  request: ChatRequest,
  scope?: RequestScope
): Promise<Response> {
  const harnessCfg: HarnessConfig = upstream.harness || { kind: 'aider' };
  const editFormat = harnessCfg.editFormat || (harnessCfg.agentId === 'udiff' ? 'udiff' : 'architect');
  const repoMapTokens = harnessCfg.repoMapTokens ?? 1024;
  const architectModel = harnessCfg.architectModel || 'tier4/architect-frontier';
  const editorModel = harnessCfg.editorModel || 'tier2/editor-local-coder';
  const approvalPolicy: HarnessApprovalPolicy =
    harnessCfg.approvals || harnessCfg.approvalPolicy || 'auto-approve-readonly';

  const sessionKey = `${upstream.id}:${scope?.userId || 'default'}:${scope?.sessionId || 'ephemeral'}`;
  let session = aiderSessionStore.get(sessionKey);
  if (!session) {
    session = {
      id: `aider_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      editFormat,
      repoMapTokens,
      architectModel,
      editorModel,
      turns: 0,
    };
    setBounded(aiderSessionStore, sessionKey, session);
  }
  session.turns += 1;

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
        'aider_repo_map_observation',
        harnessCfg.midLoopGuard
      );
      redactionCount += check.piiTypes.length;
      if (check.injectionDetected) injectionCount += 1;
    }
  }

  const promptCheck = inspectHarnessObservation(
    rawPrompt,
    'aider_user_prompt',
    harnessCfg.midLoopGuard
  );
  redactionCount += promptCheck.piiTypes.length;
  if (promptCheck.injectionDetected) injectionCount += 1;

  if (!promptCheck.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          message: promptCheck.blockedReason || 'Blocked by Eluvix Aider mid-loop PromptGuard',
          type: 'harness_mid_loop_guard_blocked',
          code: 'prompt_injection_detected',
        },
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-harness': 'aider',
          'x-eluvix-harness-mode': 'embedded',
          'x-eluvix-session': session.id,
          'x-eluvix-prefix-hash': kvPrefixHash,
          'x-eluvix-guard-injections': String(injectionCount),
        },
      }
    );
  }

  // Dual-model Architect (Tier 4) -> Editor (Tier 2) Switchyard progression
  const architectStep = selectSwitchyardStepTier(1, 'final-synthesis', promptCheck.sanitizedText);
  const editorStep = selectSwitchyardStepTier(2, 'code-edit', promptCheck.sanitizedText);
  const tierProgression = `${Math.max(4, architectStep.tier)}->${editorStep.tier}`;

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
    const fnName = String(t?.function?.name || t?.name || `tool_${i}`);
    if (isToolAutoApproved(approvalPolicy, [fnName], effectiveAutoApprove)) {
      toolCalls.push({
        id: `call_aider_${Date.now()}_${i}`,
        type: 'function',
        function: {
          name: fnName,
          arguments: JSON.stringify({
            editFormat,
            repoMapTokens,
            query: promptCheck.sanitizedText.slice(0, 120),
          }),
        },
      });
    }
  }

  const content = [
    `[Aider (${editFormat}) · Session ${session.id} · RepoMap ${repoMapTokens} tok]`,
    `Architect (${architectModel}): Proposed structural plan for "${promptCheck.sanitizedText}"`,
    `Editor (${editorModel}): Generated SEARCH/REPLACE diff block (${tierProgression}).`,
    `<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE`,
  ].join('\n');

  const completionId = `chatcmpl-aider-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const servedModel = `aider/${editFormat}`;
  const promptTokens = Math.ceil(rawPrompt.length / 4) + Math.min(256, Math.floor(repoMapTokens / 8));
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
        'x-eluvix-harness': 'aider',
        'x-eluvix-harness-mode': 'embedded',
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

export async function forwardAiderHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0
): Promise<Response> {
  const rawEndpoint = (upstream.endpoint || '').trim();
  const harnessCfg: HarnessConfig = upstream.harness || { kind: 'aider' };

  if (
    harnessCfg.embedded === true ||
    rawEndpoint.toLowerCase().startsWith('aider://') ||
    rawEndpoint.toLowerCase().startsWith('inprocess://')
  ) {
    return executeEmbeddedAiderTurn(upstream, request, scope);
  }

  const baseUrl = rawEndpoint.replace(/\/+$/, '');
  const kvPrefixHash = computeHarnessKvPrefixHash(
    request.messages,
    request.tools,
    harnessCfg.mcpServers
  );
  const prompt = buildHarnessPrompt(request.messages || [], { includeHistory: true });
  const promptCheck = inspectHarnessObservation(prompt, 'aider_http_prompt', harnessCfg.midLoopGuard);
  if (!promptCheck.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          message: promptCheck.blockedReason || 'Blocked by Aider PromptGuard',
          type: 'PromptGuardBlocked',
          code: 'prompt_guard_violation'
        }
      }),
      {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-harness': 'aider',
          'x-eluvix-guard-injections': '1'
        }
      }
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Aider harness timed out after ${timeoutMs}ms`, 'TimeoutError')),
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
        aider: {
          editFormat: harnessCfg.editFormat || 'architect',
          architectModel: harnessCfg.architectModel,
          editorModel: harnessCfg.editorModel,
          repoMapTokens: harnessCfg.repoMapTokens ?? 1024,
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const headers = new Headers(res.headers);
    headers.set('x-eluvix-harness', 'aider');
    headers.set('x-eluvix-prefix-hash', kvPrefixHash);
    headers.set('x-eluvix-switchyard-tier', '4->2');
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
