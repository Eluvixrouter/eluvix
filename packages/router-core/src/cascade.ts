/**
 * Browser-safe Buffer-Verify Speculative Cascade & Online Contextual Thompson Bandit helpers.
 *
 * IMPORTANT: Keep this module 100% free of `node:*` imports so it can be imported directly
 * by client-rendered React Flow components (`SpeculativeCascadeNode.tsx`), `compiler.ts`,
 * `decompiler.ts`, and `diagnostics.ts` without breaking Next.js client bundles.
 */

export interface SpeculativeCascadeConfig {
  id?: string;
  enabled?: boolean;
  /** `$0.00` fast local draft upstream ID (`#draft` emerald handle). */
  draftUpstreamId?: string;
  /** Frontier / heavy verifier upstream ID (`#verifier` sky/indigo handle). */
  verifierUpstreamId?: string;
  /** Optional `$0.00` local student upstream ID (`#shadow-student` amber handle) for async SFT/DPO shadow distillation. */
  shadowStudentUpstreamId?: string;
  /** Minimum deterministic + logprob confidence score (`0.0` - `1.0`) required to accept the draft. Default: `0.78`. */
  confidenceThreshold?: number;
  /** Maximum wall-clock budget in milliseconds allowed for the buffered draft pass before escalating. Default: `2500`. */
  maxDraftLatencyMs?: number;
  /** Enforce valid JSON & required schema keys when `response_format` requests JSON. Default: `true`. */
  validateJsonSchema?: boolean;
  /** Enforce balanced Markdown triple-backtick code fences when code blocks are requested or emitted. Default: `true`. */
  validateCodeFences?: boolean;
  /** Async shadow distillation sampling rate (`0.0` - `1.0`) on frontier completions. Default: `0.05`. */
  shadowSampleRate?: number;
}

export interface DraftVerificationOptions {
  confidenceThreshold?: number;
  validateJsonSchema?: boolean;
  validateCodeFences?: boolean;
  expectJson?: boolean;
  jsonSchema?: Record<string, any> | null;
  expectCode?: boolean;
  tokenLogprobs?: number[];
  finishReason?: string | null;
}

export interface DraftVerificationResult {
  passed: boolean;
  confidence: number;
  reasons: string[];
  primaryReason?: string;
}

const REFUSAL_OR_INABILITY_PATTERNS: RegExp[] = [
  /^\s*(?:i(?:'m| am) sorry|sorry,? but|apologies,? but)\s*,?\s*i (?:can(?:not|'t)|am unable to|don't have)/i,
  /\bas an ai(?: language model| assistant)?,? i (?:can(?:not|'t)|do not|don't|am unable)/i,
  /\bi (?:can(?:not|'t)|am unable to) (?:assist|help|fulfill|complete|answer|provide|solve)\b/i,
  /\bi do not have (?:enough information|the capability|access to real-time)\b/i,
];

const HEDGING_OR_STUB_PATTERNS: RegExp[] = [
  /\bi(?:'m| am) not (?:completely |entirely )?sure\b/i,
  /\b(?:placeholder|left as an exercise for the reader)\b/i,
  /\/\/\s*\.\.\.\s*(?:rest of (?:code|implementation)|implement here)/i,
  /#\s*\.\.\.\s*(?:rest of (?:code|implementation)|implement here)/i,
];

function extractJsonCandidate(rawText: string): string {
  const trimmed = rawText.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch && fencedMatch[1]) {
    return fencedMatch[1].trim();
  }
  return trimmed;
}

/**
 * Evaluates a buffered `$0.00` local `#draft` completion BEFORE flushing any SSE bytes to the caller.
 * Prevents half-stream corruption when escalating uncertain or malformed local drafts to `#verifier`.
 */
export function evaluateDraftQuality(
  draftText: string,
  options?: DraftVerificationOptions
): DraftVerificationResult {
  const threshold = Math.max(0, Math.min(1, options?.confidenceThreshold ?? 0.78));
  const validateJson = options?.validateJsonSchema !== false;
  const validateFences = options?.validateCodeFences !== false;
  const reasons: string[] = [];

  const trimmed = typeof draftText === 'string' ? draftText.trim() : '';
  if (!trimmed) {
    return {
      passed: false,
      confidence: 0,
      reasons: ['empty_draft'],
      primaryReason: 'empty_draft',
    };
  }

  if (options?.finishReason === 'length') {
    reasons.push('truncated_max_tokens');
  }

  // 1. Refusal / inability check
  for (const pattern of REFUSAL_OR_INABILITY_PATTERNS) {
    if (pattern.test(trimmed)) {
      reasons.push('refusal_or_inability');
      return {
        passed: false,
        confidence: 0.15,
        reasons,
        primaryReason: 'refusal_or_inability',
      };
    }
  }

  // 2. JSON & schema structural check
  if (validateJson && options?.expectJson) {
    const candidate = extractJsonCandidate(trimmed);
    let parsed: any;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      reasons.push('invalid_json');
      return {
        passed: false,
        confidence: 0.1,
        reasons,
        primaryReason: 'invalid_json',
      };
    }

    const schemaObj =
      options.jsonSchema && typeof options.jsonSchema === 'object'
        ? options.jsonSchema.schema && typeof options.jsonSchema.schema === 'object'
          ? options.jsonSchema.schema
          : options.jsonSchema
        : null;

    if (schemaObj) {
      if (schemaObj.type === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
        reasons.push('json_schema_type_mismatch');
        return {
          passed: false,
          confidence: 0.2,
          reasons,
          primaryReason: 'json_schema_type_mismatch',
        };
      }
      if (Array.isArray(schemaObj.required) && parsed && typeof parsed === 'object') {
        const missing = schemaObj.required.filter((k: string) => !(k in parsed));
        if (missing.length > 0) {
          reasons.push(`json_schema_missing_keys:${missing.join(',')}`);
          return {
            passed: false,
            confidence: 0.25,
            reasons,
            primaryReason: 'json_schema_missing_keys',
          };
        }
      }
    }
  }

  // 3. Markdown code fence balance & non-empty code block check
  if (validateFences) {
    const fenceMatches = trimmed.match(/```/g);
    const fenceCount = fenceMatches ? fenceMatches.length : 0;
    if (fenceCount % 2 !== 0) {
      reasons.push('unbalanced_code_fences');
      return {
        passed: false,
        confidence: 0.2,
        reasons,
        primaryReason: 'unbalanced_code_fences',
      };
    }
    if (options?.expectCode && fenceCount >= 2) {
      const blocks = [...trimmed.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
      if (blocks.length > 0 && blocks.every((b) => !b[1] || b[1].trim().length === 0)) {
        reasons.push('empty_code_block');
        return {
          passed: false,
          confidence: 0.2,
          reasons,
          primaryReason: 'empty_code_block',
        };
      }
    }
  }

  // 4. Confidence estimation (heuristic baseline + optional logprob geometric mean)
  let confidence = 0.88;

  if (options?.finishReason === 'length') {
    confidence -= 0.28;
  }

  let stubHits = 0;
  for (const pattern of HEDGING_OR_STUB_PATTERNS) {
    if (pattern.test(trimmed)) {
      stubHits++;
    }
  }
  if (stubHits > 0) {
    reasons.push('hedging_or_stub_detected');
    confidence -= Math.min(0.45, stubHits * 0.22);
  }

  if (Array.isArray(options?.tokenLogprobs) && options!.tokenLogprobs.length > 0) {
    const finite = options!.tokenLogprobs.filter((lp) => typeof lp === 'number' && Number.isFinite(lp));
    if (finite.length > 0) {
      const meanLogprob = finite.reduce((acc, v) => acc + v, 0) / finite.length;
      const geomProb = Math.max(0, Math.min(1, Math.exp(meanLogprob)));
      // Blend structural confidence (40%) with token probability confidence (60%)
      confidence = Number((0.4 * confidence + 0.6 * geomProb).toFixed(4));
      if (geomProb < threshold) {
        reasons.push(`low_logprob_confidence:${geomProb.toFixed(3)}`);
      }
    }
  }

  confidence = Number(Math.max(0, Math.min(1, confidence)).toFixed(4));
  const passed = confidence >= threshold;
  if (!passed && reasons.length === 0) {
    reasons.push('below_confidence_threshold');
  }

  return {
    passed,
    confidence,
    reasons,
    primaryReason: passed ? undefined : reasons[0] || 'below_confidence_threshold',
  };
}

/**
 * Extracts token logprobs from an OpenAI-compatible `chat.completion` JSON payload if present.
 */
export function extractChoiceLogprobs(payload: any): number[] {
  const contentArr = payload?.choices?.[0]?.logprobs?.content;
  if (Array.isArray(contentArr)) {
    return contentArr
      .map((item: any) => item?.logprob)
      .filter((v: any): v is number => typeof v === 'number' && Number.isFinite(v));
  }
  const legacyArr = payload?.choices?.[0]?.logprobs?.token_logprobs;
  if (Array.isArray(legacyArr)) {
    return legacyArr.filter((v: any): v is number => typeof v === 'number' && Number.isFinite(v));
  }
  return [];
}

/**
 * Synthesizes a clean, well-formed OpenAI `chat.completion.chunk` SSE `ReadableStream`
 * from a verified buffered completion so streaming clients receive standard SSE frames
 * with zero half-stream artifacts.
 */
export function synthesizeOpenAiSseFromText(params: {
  text: string;
  model: string;
  id?: string;
  finishReason?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const completionId = params.id || `chatcmpl-cascade-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const finishReason = params.finishReason || 'stop';
  const text = params.text ?? '';

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const roleFrame = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: params.model,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          },
        ],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleFrame)}\n\n`));

      // Emit content in ergonomic chunks (~120 chars) for smooth client rendering
      const chunkSize = 120;
      for (let i = 0; i < text.length; i += chunkSize) {
        const slice = text.slice(i, i + chunkSize);
        const contentFrame = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: params.model,
          choices: [
            {
              index: 0,
              delta: { content: slice },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentFrame)}\n\n`));
      }

      const stopFrame: Record<string, any> = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: params.model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
          },
        ],
      };
      if (params.usage) {
        stopFrame.usage = params.usage;
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(stopFrame)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

// ============================================================================
// Online Contextual Thompson-Sampling Bandit (`thompson-bandit`)
// ============================================================================

export interface BanditArmStats {
  armKey: string;
  upstreamId: string;
  complexityTier: string;
  alpha: number;
  beta: number;
  ewmaTtftMs?: number | null;
  ewmaItlMs?: number | null;
  totalPulls: number;
  updatedAt?: string;
}

function sampleStandardNormal(rng: () => number = Math.random): number {
  let u1 = 0;
  let u2 = 0;
  while (u1 <= 1e-12) u1 = rng();
  u2 = rng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Samples from Gamma(shape, 1) using Marsaglia & Tsang's squeeze method.
 */
export function sampleGamma(shape: number, rng: () => number = Math.random): number {
  const safeShape = Math.max(0.05, shape);
  if (safeShape < 1) {
    let u = rng();
    while (u <= 1e-12) u = rng();
    return sampleGamma(safeShape + 1, rng) * Math.pow(u, 1 / safeShape);
  }
  const d = safeShape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let iter = 0; iter < 64; iter++) {
    let x = 0;
    let v = 0;
    do {
      x = sampleStandardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    let u = rng();
    while (u <= 1e-12) u = rng();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) {
      return d * v;
    }
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
  return safeShape;
}

/**
 * Samples a reward expectation `theta ~ Beta(alpha, beta)` in `[0, 1]`.
 */
export function sampleBetaPosterior(
  alpha: number,
  beta: number,
  rng: () => number = Math.random
): number {
  const a = Math.max(0.1, Number.isFinite(alpha) ? alpha : 1);
  const b = Math.max(0.1, Number.isFinite(beta) ? beta : 1);
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  const denom = x + y;
  if (denom <= 0) return 0.5;
  return Math.max(0, Math.min(1, x / denom));
}

/**
 * Ranks candidate upstreams for a given prompt complexity tier using Contextual Thompson Sampling.
 * - Combines `Beta(alpha, beta)` posterior draws with capability-fit and `$0.00` sovereign cost bonuses.
 * - When `deterministicMean: true` (used in `explainRoute()` dry-runs), uses posterior mean `alpha / (alpha + beta)`
 *   so route previews remain 100% deterministic.
 */
export function rankUpstreamsWithThompsonBandit<
  T extends {
    id: string;
    priority: number;
    costPer1kTokens?: number;
    maxComplexityScore?: number;
    type?: string;
  }
>(
  upstreams: T[],
  arms: BanditArmStats[],
  options?: {
    complexityScore?: number;
    rng?: () => number;
    deterministicMean?: boolean;
    exactModelChecker?: (upstream: T) => boolean;
  }
): { ranked: T[]; sampledScores: Record<string, number> } {
  const armByUpstream = new Map<string, BanditArmStats>();
  for (const arm of arms) {
    armByUpstream.set(arm.upstreamId, arm);
  }

  const complexityScore = options?.complexityScore ?? 1;
  const rng = options?.rng || Math.random;
  const sampledScores: Record<string, number> = {};

  for (const u of upstreams) {
    const arm = armByUpstream.get(u.id);
    // Uninformative optimistic Beta(2, 1) prior encourages initial exploration
    const alpha = arm ? Math.max(0.25, arm.alpha) : 2.0;
    const beta = arm ? Math.max(0.25, arm.beta) : 1.0;

    const theta = options?.deterministicMean
      ? alpha / (alpha + beta)
      : sampleBetaPosterior(alpha, beta, rng);

    const cap =
      u.maxComplexityScore ??
      (u.type === 'openai-compatible' ||
      u.type === 'billama' ||
      u.type === 'anthropic' ||
      u.type === 'antigravity' ||
      u.type === 'harness'
        ? 4
        : 2);
    const capabilityBonus = cap >= complexityScore ? 0.12 : -0.18;

    const cost =
      u.costPer1kTokens ??
      (u.type === 'openai-compatible' || u.type === 'billama' || u.type === 'anthropic'
        ? 0.005
        : 0);
    const sovereignZeroCostBonus = cost === 0 ? 0.06 : Math.max(-0.08, -cost * 2);

    const latencyPenalty =
      arm?.ewmaTtftMs && arm.ewmaTtftMs > 0
        ? Math.min(0.15, arm.ewmaTtftMs / 40000)
        : 0;

    sampledScores[u.id] = Number(
      (theta + capabilityBonus + sovereignZeroCostBonus - latencyPenalty).toFixed(4)
    );
  }

  const ranked = [...upstreams].sort((a, b) => {
    if (options?.exactModelChecker) {
      const exactA = options.exactModelChecker(a) ? 1 : 0;
      const exactB = options.exactModelChecker(b) ? 1 : 0;
      if (exactA !== exactB) return exactB - exactA;
    }
    const scoreDiff = (sampledScores[b.id] ?? 0) - (sampledScores[a.id] ?? 0);
    if (Math.abs(scoreDiff) > 1e-6) return scoreDiff;
    return b.priority - a.priority;
  });

  return { ranked, sampledScores };
}
