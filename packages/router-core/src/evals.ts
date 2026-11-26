import {
  Eluvix,
  isLocalUpstream,
  type RouterConfig,
  type ChatMessage,
  type PaperclipRequestContext,
} from './index.js';
import { applyPrivacyGuard, validateChatPrompt } from './guard.js';
import { evaluateDraftQuality } from './cascade.js';
import type { RequestScope } from './context/types.js';
import type {
  EvalAssertionOutcome,
  EvalCase,
  EvalCaseResult,
  EvalRunMode,
  EvalSuite,
  EvalSuiteResult,
} from './eval-types.js';

export * from './eval-types.js';

function buildEvalMessages(evalCase: EvalCase): ChatMessage[] {
  if (Array.isArray(evalCase.messages) && evalCase.messages.length > 0) {
    return evalCase.messages as ChatMessage[];
  }
  const messages: ChatMessage[] = [];
  if (evalCase.system) {
    messages.push({ role: 'system', content: evalCase.system });
  }
  messages.push({ role: 'user', content: evalCase.prompt });
  return messages;
}

function buildEvalPaperclipContext(evalCase: EvalCase): PaperclipRequestContext | undefined {
  const pc = evalCase.paperclip;
  if (!pc) return undefined;
  return {
    trusted: true,
    droppedHeaders: [],
    ...(pc.priority ? { priority: pc.priority } : {}),
    ...(pc.budgetRemainingPct !== undefined ? { budgetRemainingPct: pc.budgetRemainingPct } : {}),
    ...(pc.sensitivity ? { sensitivity: pc.sensitivity } : {}),
    ...(pc.companyId ? { companyId: pc.companyId } : {}),
    ...(pc.issueId ? { issueId: pc.issueId } : {}),
    ...(pc.hop !== undefined ? { hop: pc.hop } : {}),
    ...(pc.keyPolicy ? { keyPolicy: pc.keyPolicy } : {}),
  };
}

export interface RunEvalSuiteOptions {
  mode?: EvalRunMode;
  scope?: RequestScope;
  signal?: AbortSignal;
}

function evaluateCaseDryRun(
  evalCase: EvalCase,
  router: Eluvix,
  config: RouterConfig
): EvalCaseResult {
  const start = Date.now();
  const messages = buildEvalMessages(evalCase);
  const paperclipCtx = buildEvalPaperclipContext(evalCase);

  // 1. Evaluate PromptGuard (defaulting to enabled check if expectBlockedByGuard is asserted or config enables it)
  const effectivePromptGuard = config.promptGuard?.enabled
    ? config.promptGuard
    : evalCase.assertions.expectBlockedByGuard !== undefined
      ? { enabled: true, action: 'block' as const }
      : undefined;

  let blockedByGuard = false;
  if (effectivePromptGuard?.enabled && (effectivePromptGuard.action || effectivePromptGuard.enforcementAction || 'block') === 'block') {
    const validation = validateChatPrompt(messages as any[], effectivePromptGuard);
    if (!validation.passed) {
      blockedByGuard = true;
    }
  }

  // 2. Evaluate PrivacyGuard PII scrubbing
  const effectivePrivacyGuard = config.privacyGuard?.enabled
    ? config.privacyGuard
    : evalCase.assertions.expectPiiRedacted !== undefined
      ? { enabled: true, action: 'anonymize' as const, redactionStyle: 'token' as const }
      : undefined;

  let piiRedacted = false;
  let postPrivacyMessages = messages;
  if (effectivePrivacyGuard?.enabled) {
    const beforeStr = JSON.stringify(messages);
    const res = applyPrivacyGuard(messages as any[], effectivePrivacyGuard);
    const afterStr = JSON.stringify(res.modifiedMessages);
    if (beforeStr !== afterStr) {
      piiRedacted = true;
    }
    if (!res.passed) {
      blockedByGuard = true;
    }
    postPrivacyMessages = res.modifiedMessages as ChatMessage[];
  }

  // 3. Deterministic topology trace via explainRoute()
  const explanation = router.explainRoute(
    {
      model: evalCase.model || 'auto',
      messages: postPrivacyMessages,
    },
    {
      ...(paperclipCtx ? { paperclip: paperclipCtx } : {}),
      ...(evalCase.paperclip?.hop !== undefined ? { hops: evalCase.paperclip.hop } : {}),
    }
  );

  const routeOk = !explanation.error && Boolean(explanation.chosenUpstreamId);
  // Hunt-3 L-A8: an unroutable case is NOT a guard block. blockedByGuard
  // is set only by the prompt/privacy guard checks above; conflating a
  // failed route resolution with a block made expectBlockedByGuard pass
  // when the upstream was just down or the route failed to resolve.

  const primaryId = explanation.chosenUpstreamId ?? null;
  const primaryUpstream = primaryId
    ? (config.upstreams || []).find((u) => u.id === primaryId) || null
    : null;
  const selectedUpstreamType = primaryUpstream?.type ?? null;
  const complexityTier = explanation.complexity?.label || 'simple';
  const durationMs = Math.max(0, Date.now() - start);

  const outcomes: EvalAssertionOutcome[] = [];
  const a = evalCase.assertions || {};

  if (a.expectedUpstream !== undefined) {
    outcomes.push({
      check: 'expectedUpstream',
      passed: primaryId === a.expectedUpstream,
      expected: a.expectedUpstream,
      actual: String(primaryId),
    });
  }

  if (a.expectedUpstreamType !== undefined) {
    outcomes.push({
      check: 'expectedUpstreamType',
      passed: selectedUpstreamType === a.expectedUpstreamType,
      expected: a.expectedUpstreamType,
      actual: String(selectedUpstreamType),
    });
  }

  if (a.expectedTier !== undefined) {
    outcomes.push({
      check: 'expectedTier',
      passed: complexityTier === a.expectedTier,
      expected: a.expectedTier,
      actual: complexityTier,
    });
  }

  if (a.expectPiiRedacted !== undefined) {
    outcomes.push({
      check: 'expectPiiRedacted',
      passed: piiRedacted === a.expectPiiRedacted,
      expected: String(a.expectPiiRedacted),
      actual: String(piiRedacted),
    });
  }

  if (a.expectBlockedByGuard !== undefined) {
    outcomes.push({
      check: 'expectBlockedByGuard',
      passed: blockedByGuard === a.expectBlockedByGuard,
      expected: String(a.expectBlockedByGuard),
      actual: String(blockedByGuard),
    });
  } else if (outcomes.length === 0 && !a.expectedPaperclipBiasContains && a.forbidCloudUpstream === undefined && a.expectedStepTier === undefined) {
    // Default sanity check if no explicit assertion fields were set: route must resolve cleanly
    outcomes.push({
      check: 'routeResolved',
      passed: routeOk && Boolean(primaryId),
      expected: 'ok=true with >=1 candidate upstream',
      actual: routeOk ? `selected=${primaryId}` : `error=${explanation.error || 'unroutable'}`,
    });
  }

  if (a.expectedPaperclipBiasContains && a.expectedPaperclipBiasContains.length > 0) {
    const biasJoined = (explanation.paperclipBias?.biasTags || []).join(',');
    const matchedAll = a.expectedPaperclipBiasContains.every((sub) => biasJoined.includes(sub));
    outcomes.push({
      check: 'expectedPaperclipBiasContains',
      passed: matchedAll,
      expected: a.expectedPaperclipBiasContains.join(', '),
      actual: biasJoined || '(none)',
    });
  }

  if (a.forbidCloudUpstream !== undefined) {
    const isLocal = primaryUpstream ? isLocalUpstream(primaryUpstream) : false;
    outcomes.push({
      check: 'forbidCloudUpstream',
      passed: a.forbidCloudUpstream ? Boolean(primaryUpstream && isLocal) : true,
      expected: a.forbidCloudUpstream ? 'local-only upstream' : 'any',
      actual: primaryUpstream
        ? `${primaryUpstream.id} (${isLocal ? 'local' : 'cloud'})`
        : 'none',
    });
  }

  if (a.expectedStepTier !== undefined) {
    outcomes.push({
      check: 'expectedStepTier',
      passed: explanation.agentStepTier === a.expectedStepTier,
      expected: a.expectedStepTier,
      actual: String(explanation.agentStepTier || 'none'),
    });
  }

  if (a.maxLatencyMs !== undefined) {
    outcomes.push({
      check: 'maxLatencyMs',
      passed: durationMs <= a.maxLatencyMs,
      expected: `<=${a.maxLatencyMs}ms`,
      actual: `${durationMs}ms`,
    });
  }

  const passed = outcomes.every((o) => o.passed);

  return {
    id: evalCase.id,
    name: evalCase.name,
    passed,
    durationMs,
    selectedUpstreamId: primaryId,
    selectedUpstreamType,
    complexityTier,
    blockedByGuard,
    piiRedacted,
    assertions: outcomes,
    ...(explanation.error ? { error: explanation.error } : {}),
  };
}

async function evaluateCaseLive(
  evalCase: EvalCase,
  router: Eluvix,
  config: RouterConfig,
  options?: RunEvalSuiteOptions
): Promise<EvalCaseResult> {
  const start = Date.now();
  const messages = buildEvalMessages(evalCase);
  const paperclipCtx = buildEvalPaperclipContext(evalCase);

  let piiRedacted = false;
  if (config.privacyGuard?.enabled || evalCase.assertions.expectPiiRedacted !== undefined) {
    const pg = config.privacyGuard?.enabled
      ? config.privacyGuard
      : { enabled: true, action: 'anonymize' as const, redactionStyle: 'token' as const };
    const beforeStr = JSON.stringify(messages);
    const check = applyPrivacyGuard(messages as any[], pg);
    piiRedacted = JSON.stringify(check.modifiedMessages) !== beforeStr;
  }

  const dryExplanation = router.explainRoute(
    {
      model: evalCase.model || 'auto',
      messages,
    },
    {
      ...(paperclipCtx ? { paperclip: paperclipCtx } : {}),
      ...(evalCase.paperclip?.hop !== undefined ? { hops: evalCase.paperclip.hop } : {}),
    }
  );
  const complexityTier = dryExplanation.complexity?.label || 'simple';

  let res: Response;
  let thrownError: string | null = null;
  try {
    res = await router.routeChatCompletion(
      {
        model: evalCase.model || 'auto',
        messages,
        stream: false,
        ...(evalCase.assertions.jsonSchema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'eval_schema', schema: evalCase.assertions.jsonSchema },
              },
            }
          : {}),
      },
      {
        hops: evalCase.paperclip?.hop ?? 1,
        scope: options?.scope,
        signal: options?.signal,
        ...(paperclipCtx ? { paperclip: paperclipCtx } : {}),
        silent: true,
      }
    );
  } catch (err: any) {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 429;
    thrownError = err?.message || 'Blocked by router guard';
    res = new Response(JSON.stringify({ error: { message: thrownError } }), { status });
  }

  const durationMs = Math.max(0, Date.now() - start);
  const rawBody = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {}

  // Hunt-3 L-A8: only an actual guard block counts. Any non-2xx used to
  // count (upstream down, 429 loop-limit, 422 schema failure all passed
  // expectBlockedByGuard). A real block is: a diverted response
  // (x-eluvix-guard: diverted), a guard error code/type in the body
  // (prompt-injection 400, privacy-guard 400), or a thrown error whose
  // message names a guard. Warn-mode (x-eluvix-guard: response-warn)
  // is telemetry, not a block.
  const guardErrorCode = typeof parsed?.error?.code === 'string' ? parsed.error.code : '';
  const guardErrorType = typeof parsed?.error?.type === 'string' ? parsed.error.type : '';
  const blockedByGuard =
    res.headers.get('x-eluvix-guard') === 'diverted' ||
    guardErrorCode === 'content_policy_violation' ||
    guardErrorCode === 'privacy_guard_violation' ||
    guardErrorType === 'prompt_injection_violation' ||
    guardErrorType === 'privacy_guard_violation' ||
    (thrownError !== null &&
      /prompt injection|content_policy|privacy guard|semantic guard/i.test(thrownError));
  const servedUpstreamHdr = res.headers.get('x-eluvix-upstream');
  const stepTierHdr = res.headers.get('x-eluvix-step-tier') || dryExplanation.agentStepTier;
  const matchedUpstream =
    (config.upstreams || []).find(
      (u) => u.id === servedUpstreamHdr || u.name === servedUpstreamHdr
    ) || null;
  const selectedUpstreamId = matchedUpstream?.id || servedUpstreamHdr || null;
  const selectedUpstreamType = matchedUpstream?.type || null;
  const completionText =
    typeof parsed?.choices?.[0]?.message?.content === 'string'
      ? parsed.choices[0].message.content
      : rawBody;

  const outcomes: EvalAssertionOutcome[] = [];
  const a = evalCase.assertions || {};

  if (a.expectBlockedByGuard !== undefined) {
    outcomes.push({
      check: 'expectBlockedByGuard',
      passed: blockedByGuard === a.expectBlockedByGuard,
      expected: String(a.expectBlockedByGuard),
      actual: `${blockedByGuard} (HTTP ${res.status})`,
    });
  } else {
    outcomes.push({
      check: 'httpStatus200',
      passed: res.ok,
      expected: 'HTTP 2xx',
      actual: `HTTP ${res.status}`,
    });
  }

  if (a.expectedUpstream !== undefined) {
    outcomes.push({
      check: 'expectedUpstream',
      passed: selectedUpstreamId === a.expectedUpstream || servedUpstreamHdr === a.expectedUpstream,
      expected: a.expectedUpstream,
      actual: String(selectedUpstreamId),
    });
  }

  if (a.expectedUpstreamType !== undefined) {
    outcomes.push({
      check: 'expectedUpstreamType',
      passed: selectedUpstreamType === a.expectedUpstreamType,
      expected: a.expectedUpstreamType,
      actual: String(selectedUpstreamType),
    });
  }

  if (a.expectedTier !== undefined) {
    outcomes.push({
      check: 'expectedTier',
      passed: complexityTier === a.expectedTier,
      expected: a.expectedTier,
      actual: complexityTier,
    });
  }

  if (a.expectPiiRedacted !== undefined) {
    outcomes.push({
      check: 'expectPiiRedacted',
      passed: piiRedacted === a.expectPiiRedacted,
      expected: String(a.expectPiiRedacted),
      actual: String(piiRedacted),
    });
  }

  if (a.maxLatencyMs !== undefined) {
    outcomes.push({
      check: 'maxLatencyMs',
      passed: durationMs <= a.maxLatencyMs,
      expected: `<=${a.maxLatencyMs}ms`,
      actual: `${durationMs}ms`,
    });
  }

  if (a.expectedPaperclipBiasContains && a.expectedPaperclipBiasContains.length > 0) {
    const biasJoined = (dryExplanation.paperclipBias?.biasTags || []).join(',');
    const matchedAll = a.expectedPaperclipBiasContains.every((sub) => biasJoined.includes(sub));
    outcomes.push({
      check: 'expectedPaperclipBiasContains',
      passed: matchedAll,
      expected: a.expectedPaperclipBiasContains.join(', '),
      actual: biasJoined || '(none)',
    });
  }

  if (a.forbidCloudUpstream !== undefined) {
    const isLocal = matchedUpstream ? isLocalUpstream(matchedUpstream) : false;
    outcomes.push({
      check: 'forbidCloudUpstream',
      passed: a.forbidCloudUpstream ? Boolean(matchedUpstream && isLocal) : true,
      expected: a.forbidCloudUpstream ? 'local-only upstream' : 'any',
      actual: matchedUpstream
        ? `${matchedUpstream.id} (${isLocal ? 'local' : 'cloud'})`
        : 'none',
    });
  }

  if (a.expectedStepTier !== undefined) {
    outcomes.push({
      check: 'expectedStepTier',
      passed: stepTierHdr === a.expectedStepTier,
      expected: a.expectedStepTier,
      actual: String(stepTierHdr || 'none'),
    });
  }

  if (a.regexMatch !== undefined && !a.expectBlockedByGuard) {
    let matched = false;
    try {
      matched = new RegExp(a.regexMatch, 'i').test(completionText);
    } catch {
      matched = completionText.includes(a.regexMatch);
    }
    outcomes.push({
      check: 'regexMatch',
      passed: matched,
      expected: `/${a.regexMatch}/i`,
      actual: completionText.slice(0, 120),
    });
  }

  if (a.jsonSchema !== undefined && !a.expectBlockedByGuard) {
    const quality = evaluateDraftQuality(completionText, {
      confidenceThreshold: 0.5,
      expectJson: true,
      validateJsonSchema: true,
      jsonSchema: { schema: a.jsonSchema },
    });
    outcomes.push({
      check: 'jsonSchema',
      passed: quality.passed,
      expected: `valid JSON matching required=[${(a.jsonSchema.required || []).join(',')}]`,
      actual: quality.passed ? 'valid JSON' : quality.reasons.join(', '),
    });
  }

  if (a.llmJudgeRubric !== undefined && !a.expectBlockedByGuard) {
    const rubric = a.llmJudgeRubric;
    const lower = completionText.toLowerCase();
    const includesOk =
      !rubric.mustIncludeAny ||
      rubric.mustIncludeAny.length === 0 ||
      rubric.mustIncludeAny.some((kw) => lower.includes(kw.toLowerCase()));
    const excludesOk =
      !rubric.mustNotInclude ||
      rubric.mustNotInclude.length === 0 ||
      rubric.mustNotInclude.every((kw) => !lower.includes(kw.toLowerCase()));
    const quality = evaluateDraftQuality(completionText, {
      confidenceThreshold: rubric.minConfidence ?? 0.7,
    });
    const rubricPassed = includesOk && excludesOk && quality.passed;
    outcomes.push({
      check: 'llmJudgeRubric',
      passed: rubricPassed,
      expected: `confidence>=${rubric.minConfidence ?? 0.7} & rubric terms satisfied`,
      actual: `confidence=${quality.confidence}, includes=${includesOk}, excludes=${excludesOk}`,
    });
  }

  return {
    id: evalCase.id,
    name: evalCase.name,
    passed: outcomes.every((o) => o.passed),
    durationMs,
    selectedUpstreamId,
    selectedUpstreamType,
    complexityTier,
    blockedByGuard,
    piiRedacted,
    assertions: outcomes,
    responsePreview: completionText.slice(0, 280),
  };
}

export async function runEvalSuite(
  suite: EvalSuite,
  config: RouterConfig,
  options?: RunEvalSuiteOptions
): Promise<EvalSuiteResult> {
  const mode: EvalRunMode = options?.mode || suite.mode || 'dry-run';
  const start = Date.now();
  const router = new Eluvix(config);
  const results: EvalCaseResult[] = [];

  for (const evalCase of suite.cases || []) {
    if (mode === 'live') {
      results.push(await evaluateCaseLive(evalCase, router, config, options));
    } else {
      results.push(evaluateCaseDryRun(evalCase, router, config));
    }
  }

  const passedCases = results.filter((r) => r.passed).length;
  const failedCases = results.length - passedCases;

  return {
    suiteName: suite.name || 'Golden Eval Suite',
    mode,
    passed: failedCases === 0,
    totalCases: results.length,
    passedCases,
    failedCases,
    totalDurationMs: Math.max(0, Date.now() - start),
    timestamp: new Date().toISOString(),
    results,
  };
}
