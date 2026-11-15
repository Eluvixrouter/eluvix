/**
 * Browser-safe task classification and candidate-employee scoring for Paperclip
 * delegation and opt-in auto-assignment.
 *
 * IMPORTANT: Do NOT import any `node:*` modules here.
 */

import { sampleBetaPosterior } from './cascade.js';
import { scanAndMaskPii } from './guard.js';
import { classifyRequestModality } from './modality.js';
import type {
  PaperclipIssuePriority,
  PaperclipSensitivity,
  PaperclipStepTier,
} from './paperclip-context.js';
import { PAPERCLIP_STEP_TIER_RANK } from './paperclip-context.js';

export interface PaperclipTaskInput {
  issueId?: string;
  title: string;
  description?: string | null;
  priority?: PaperclipIssuePriority;
  labels?: string[];
  sensitivity?: PaperclipSensitivity;
  parentAssigneeAgentId?: string | null;
}

export interface PaperclipTaskClassification {
  modalities: string[];
  complexity: number; // 1..5
  complexityLabel: 'simple' | 'moderate' | 'complex' | 'frontier';
  sensitivity: PaperclipSensitivity;
  suggestedTier: PaperclipStepTier;
  estimatedTokens: number;
  taskClass: string;
  piiDetected: boolean;
  features: string[];
}

export interface PaperclipCandidateAgent {
  id: string;
  name: string;
  role?: string;
  title?: string;
  capabilities?: string | null;
  adapterType?: string;
  model?: string | null;
  status?: string;
  budgetMonthlyCents?: number;
  spentMonthlyCents?: number;
  openIssueCount?: number;
  egressPolicy?: 'local-only' | 'cloud-ok' | 'hybrid';
  supportedModalities?: string[];
  maxTier?: PaperclipStepTier;
  isEluvixAuto?: boolean;
  semanticFit?: number;
  burnRateCentsPerDay?: number;
  reportsTo?: string | null;
  parentAssigneeAgentId?: string | null;
}

export interface PaperclipFleetUpstreamSummary {
  id: string;
  name: string;
  type: string;
  isLocal: boolean;
  healthy: boolean;
  models: string[];
  costPer1kTokens: number;
  estimatedLatencyMs?: number;
  modalities?: string[];
}

export interface PaperclipAssignmentWeights {
  fit: number;
  cost: number;
  latency: number;
  load: number;
  budget: number;
  history: number;
}

export const DEFAULT_ASSIGNMENT_WEIGHTS: PaperclipAssignmentWeights = {
  fit: 0.4,
  cost: 0.2,
  latency: 0.1,
  load: 0.1,
  budget: 0.1,
  history: 0.1,
};

export interface PaperclipOutcomePrior {
  wins: number;
  total: number;
  alpha?: number;
  beta?: number;
  avgCostUsd?: number;
}

export interface PaperclipBudgetForecast {
  burnRateUsdPerDay: number;
  remainingBudgetUsd: number | null;
  projectedDaysRemaining: number | null;
  exhaustsWithinDays: number | null;
}

export interface PaperclipRecommendOptions {
  semanticFitByAgent?: Record<string, number>;
  burnRatesCentsPerDay?: Record<string, number>;
  thompsonSample?: boolean;
  thompsonSeed?: number;
  nowMs?: number;
}

export interface PaperclipExcludedCandidate {
  agentId: string;
  name: string;
  reasonCode:
    | 'inactive_status'
    | 'budget_exhausted'
    | 'modality_unsupported'
    | 'sensitivity_cloud_blocked';
  reason: string;
}

export interface PaperclipAssigneeRecommendation {
  agentId: string;
  name: string;
  role?: string;
  adapterType?: string;
  model?: string | null;
  score: number;
  confidence: number;
  estimatedCostUsd: number;
  estimatedLatencyMs: number;
  breakdown: {
    fit: number;
    cost: number;
    latency: number;
    load: number;
    budget: number;
    history: number;
  };
  rationale: string;
  budgetForecast?: PaperclipBudgetForecast;
  posterior?: {
    alpha: number;
    beta: number;
    mean: number;
  };
}

export interface PaperclipRecommendResult {
  classification: PaperclipTaskClassification;
  recommendations: PaperclipAssigneeRecommendation[];
  excluded: PaperclipExcludedCandidate[];
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'for',
  'to',
  'of',
  'in',
  'on',
  'with',
  'by',
  'is',
  'are',
  'be',
  'this',
  'that',
  'we',
  'need',
  'should',
  'can',
  'task',
  'issue',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_+#.-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function detectCodeSignals(text: string): boolean {
  return /\b(typescript|javascript|python|rust|golang|sql|dockerfile|refactor|bug|stacktrace|vitest|pytest|eslint|api|endpoint|schema|migration|react|nextjs|tsx)\b/i.test(
    text
  ) || /```/.test(text);
}

function detectReasoningSignals(text: string): boolean {
  return /\b(architecture|design|rfc|security|audit|threat|distributed|consensus|root cause|tradeoff|benchmark|plan|spec)\b/i.test(
    text
  );
}

export function classifyPaperclipTask(task: PaperclipTaskInput): PaperclipTaskClassification {
  const combined = `${task.title || ''}\n${task.description || ''}`.trim();
  const labelsLower = (task.labels || []).map((l) => l.toLowerCase());

  // 1. Modality classification
  const modalityProfile = classifyRequestModality({
    messages: [{ role: 'user', content: combined || task.title || '' }],
  });
  const modalities = new Set<string>(['text']);
  if (modalityProfile.synthesisIntent === 'image-gen') modalities.add('image-gen');
  if (modalityProfile.synthesisIntent === 'video-gen') modalities.add('video-gen');
  if (modalityProfile.synthesisIntent === '3d-gen') modalities.add('3d-gen');
  if (/\b(screenshot|diagram|image|vision|ocr|ui mockup|png|jpg)\b/i.test(combined)) {
    modalities.add('vision');
  }
  if (/\b(audio|transcribe|speech|tts|stt|wav|mp3|voice)\b/i.test(combined)) {
    modalities.add('audio');
  }
  const hasCode = detectCodeSignals(combined);
  if (hasCode) modalities.add('code');

  // 2. PII & sensitivity classification
  const piiScan = scanAndMaskPii(combined);
  const piiDetected = piiScan.detected;
  let sensitivity: PaperclipSensitivity = task.sensitivity ?? 'public';
  if (labelsLower.includes('sensitivity:confidential') || labelsLower.includes('confidential')) {
    sensitivity = 'confidential';
  } else if (labelsLower.includes('sensitivity:internal') || labelsLower.includes('internal')) {
    if (sensitivity === 'public') sensitivity = 'internal';
  }
  if (piiDetected) {
    sensitivity = 'confidential';
  }

  // 3. Complexity & suggested tier
  const wordCount = combined.split(/\s+/).filter(Boolean).length;
  const estimatedTokens = Math.max(128, Math.round(wordCount * 1.4) + 512);
  const hasReasoning = detectReasoningSignals(combined);
  const features: string[] = [];
  let complexity = 1;

  if (wordCount > 40) complexity += 1;
  if (hasCode) {
    complexity += 1;
    features.push('code');
  }
  if (hasReasoning) {
    complexity += 1;
    features.push('architecture/reasoning');
  }
  if (task.priority === 'critical') {
    complexity = Math.max(complexity, 4);
    features.push('critical-priority');
  } else if (task.priority === 'high') {
    complexity = Math.max(complexity, 3);
  }
  if (modalities.has('vision') || modalities.has('image-gen')) {
    features.push('multimodal');
  }
  complexity = Math.max(1, Math.min(5, complexity));

  const complexityLabel: PaperclipTaskClassification['complexityLabel'] =
    complexity >= 5
      ? 'frontier'
      : complexity >= 4
        ? 'complex'
        : complexity >= 2
          ? 'moderate'
          : 'simple';

  let suggestedTier: PaperclipStepTier = 'fast-local';
  if (complexity >= 5 || task.priority === 'critical') {
    suggestedTier = 'frontier-verified';
  } else if (hasReasoning || complexity >= 4) {
    suggestedTier = 'heavy-reasoning';
  } else if (hasCode || complexity >= 2) {
    suggestedTier = 'code-specialist';
  }

  const taskClass = `${Array.from(modalities).sort().join('+')}:${complexityLabel}`;

  return {
    modalities: Array.from(modalities),
    complexity,
    complexityLabel,
    sensitivity,
    suggestedTier,
    estimatedTokens,
    taskClass,
    piiDetected,
    features,
  };
}

function inferCandidateEgress(
  candidate: PaperclipCandidateAgent,
  fleet: PaperclipFleetUpstreamSummary[]
): 'local-only' | 'cloud-ok' {
  if (candidate.egressPolicy === 'local-only') return 'local-only';
  if (candidate.egressPolicy === 'cloud-ok') return 'cloud-ok';
  const model = (candidate.model || '').toLowerCase();
  if (model.startsWith('eluvix/')) {
    // eluvix/auto can reach cloud unless explicitly restricted; eluvix/fast-local is local
    return model === 'eluvix/fast-local' ? 'local-only' : 'cloud-ok';
  }
  const adapter = (candidate.adapterType || '').toLowerCase();
  if (adapter === 'claude_local' || adapter === 'codex_local') {
    return 'cloud-ok';
  }
  if (model) {
    const matched = fleet.find((u) =>
      u.models.some((m) => m.toLowerCase() === model || m === '*')
    );
    if (matched && matched.isLocal) return 'local-only';
  }
  return 'cloud-ok';
}

function estimateCandidateCostAndLatency(
  candidate: PaperclipCandidateAgent,
  classification: PaperclipTaskClassification,
  fleet: PaperclipFleetUpstreamSummary[]
): { costUsd: number; latencyMs: number } {
  const model = (candidate.model || '').toLowerCase();
  const tokensK = Math.max(0.5, (classification.estimatedTokens * 2) / 1000);

  if (candidate.isEluvixAuto || model === 'eluvix/auto') {
    // Pick best matching upstream cost from fleet
    const wantLocal = classification.sensitivity === 'confidential';
    const pool = fleet.filter((u) => u.healthy && (!wantLocal || u.isLocal));
    const effectivePool = pool.length > 0 ? pool : fleet;
    if (effectivePool.length === 0) {
      return { costUsd: 0.002 * tokensK, latencyMs: 1200 };
    }
    const sorted = [...effectivePool].sort((a, b) => a.costPer1kTokens - b.costPer1kTokens);
    const picked =
      classification.suggestedTier === 'frontier-verified' ||
      classification.suggestedTier === 'heavy-reasoning'
        ? sorted[sorted.length - 1]
        : sorted[0];
    return {
      costUsd: Number((picked.costPer1kTokens * tokensK).toFixed(6)),
      latencyMs: picked.estimatedLatencyMs ?? (picked.isLocal ? 750 : 1400),
    };
  }

  const matched = fleet.find((u) =>
    u.models.some((m) => m.toLowerCase() === model)
  );
  if (matched) {
    return {
      costUsd: Number((matched.costPer1kTokens * tokensK).toFixed(6)),
      latencyMs: matched.estimatedLatencyMs ?? (matched.isLocal ? 750 : 1400),
    };
  }

  if (model === 'eluvix/fast-local') {
    return { costUsd: 0, latencyMs: 550 };
  }
  if (candidate.adapterType === 'claude_local' || model.includes('opus') || model.includes('sonnet')) {
    return { costUsd: Number((0.015 * tokensK).toFixed(6)), latencyMs: 1800 };
  }
  if (candidate.adapterType === 'codex_local' || model.includes('gpt') || model.includes('o4')) {
    return { costUsd: Number((0.01 * tokensK).toFixed(6)), latencyMs: 1500 };
  }
  return { costUsd: Number((0.003 * tokensK).toFixed(6)), latencyMs: 1100 };
}

/**
 * Normalized cosine similarity clamped to [0, 1].
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA <= 0 || normB <= 0) return 0;
  const raw = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(0, Math.min(1, raw));
}

export function createSeededRng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function computeBudgetForecastForCandidate(
  candidate: PaperclipCandidateAgent,
  options?: PaperclipRecommendOptions
): PaperclipBudgetForecast | undefined {
  const budgetCents = candidate.budgetMonthlyCents;
  const spentCents = candidate.spentMonthlyCents ?? 0;
  const now = new Date(options?.nowMs ?? Date.now());
  const dayOfMonth = Math.max(1, now.getUTCDate());
  const explicitBurn =
    candidate.burnRateCentsPerDay ?? options?.burnRatesCentsPerDay?.[candidate.id];
  const burnRateCents =
    typeof explicitBurn === 'number' && Number.isFinite(explicitBurn) && explicitBurn >= 0
      ? explicitBurn
      : spentCents > 0 && dayOfMonth >= 2
        ? spentCents / dayOfMonth
        : 0;

  const hasBudget = typeof budgetCents === 'number' && budgetCents > 0;
  if (!hasBudget && burnRateCents <= 0) {
    return undefined;
  }

  const remainingCents = hasBudget ? Math.max(0, budgetCents! - spentCents) : null;
  const burnRateUsdPerDay = Number((burnRateCents / 100).toFixed(4));
  const projectedDaysRemaining =
    remainingCents !== null && burnRateCents > 0
      ? Number((remainingCents / burnRateCents).toFixed(1))
      : null;

  return {
    burnRateUsdPerDay,
    remainingBudgetUsd: remainingCents !== null ? Number((remainingCents / 100).toFixed(4)) : null,
    projectedDaysRemaining,
    exhaustsWithinDays: projectedDaysRemaining,
  };
}

function computeFitScore(
  taskTokens: string[],
  classification: PaperclipTaskClassification,
  candidate: PaperclipCandidateAgent,
  task: PaperclipTaskInput,
  options?: PaperclipRecommendOptions
): number {
  const profileText = [
    candidate.name,
    candidate.role || '',
    candidate.title || '',
    candidate.capabilities || '',
    candidate.adapterType || '',
    candidate.model || '',
  ].join(' ');
  const candTokens = new Set(tokenize(profileText));

  let overlap = 0;
  if (taskTokens.length > 0) {
    for (const tok of taskTokens) {
      if (candTokens.has(tok)) overlap += 1;
    }
  }
  const lexicalFit = taskTokens.length > 0 ? Math.min(1, overlap / Math.min(6, taskTokens.length)) : 0.4;

  // Tier adequacy bonus: eluvix/auto & eluvix_local adapt dynamically
  let tierFit = 0.7;
  if (candidate.isEluvixAuto || (candidate.model || '').toLowerCase() === 'eluvix/auto') {
    tierFit = 0.95;
  } else if (candidate.maxTier) {
    const diff =
      PAPERCLIP_STEP_TIER_RANK[candidate.maxTier] -
      PAPERCLIP_STEP_TIER_RANK[classification.suggestedTier];
    tierFit = diff >= 0 ? 0.9 : Math.max(0.2, 0.9 + diff * 0.25);
  }

  // Role affinity bonus
  const roleLower = (candidate.role || candidate.title || '').toLowerCase();
  let roleBonus = 0;
  if (classification.modalities.includes('code') && /(eng|dev|code|swe|architect|qa)/.test(roleLower)) {
    roleBonus = 0.2;
  } else if (classification.modalities.includes('vision') && /(design|ui|ux|frontend)/.test(roleLower)) {
    roleBonus = 0.2;
  }

  // Optional semantic embedding cosine fit (blended with lexical & tier fit)
  const rawSemantic = candidate.semanticFit ?? options?.semanticFitByAgent?.[candidate.id];
  const baseFit =
    typeof rawSemantic === 'number' && Number.isFinite(rawSemantic)
      ? 0.35 * lexicalFit + 0.30 * Math.max(0, Math.min(1, rawSemantic)) + 0.25 * tierFit + roleBonus
      : 0.5 * lexicalFit + 0.35 * tierFit + roleBonus;

  // Org-chart hierarchy affinity: sub-issues favor parent assignee or direct reports
  const parentAssigneeId = task.parentAssigneeAgentId ?? candidate.parentAssigneeAgentId;
  let hierarchyBonus = 0;
  if (parentAssigneeId) {
    if (candidate.id === parentAssigneeId) {
      hierarchyBonus = 0.12;
    } else if (candidate.reportsTo && candidate.reportsTo === parentAssigneeId) {
      hierarchyBonus = 0.1;
    }
  }

  return Math.max(0, Math.min(1, baseFit + hierarchyBonus));
}

export function recommendPaperclipAssignees(
  task: PaperclipTaskInput,
  candidates: PaperclipCandidateAgent[],
  fleet: PaperclipFleetUpstreamSummary[] = [],
  weightsInput?: Partial<PaperclipAssignmentWeights>,
  outcomeHistory?: Record<string, PaperclipOutcomePrior>,
  options?: PaperclipRecommendOptions
): PaperclipRecommendResult {
  const classification = classifyPaperclipTask(task);
  const taskTokens = tokenize(`${task.title} ${task.description || ''} ${(task.labels || []).join(' ')}`);
  const rng =
    options?.thompsonSeed !== undefined ? createSeededRng(options.thompsonSeed) : Math.random;

  // Shift weights based on issue priority
  const weights: PaperclipAssignmentWeights = {
    ...DEFAULT_ASSIGNMENT_WEIGHTS,
    ...(weightsInput || {}),
  };
  if (task.priority === 'critical') {
    weights.fit += 0.15;
    weights.cost = Math.max(0.02, weights.cost - 0.12);
  } else if (task.priority === 'low') {
    weights.cost += 0.15;
    weights.fit = Math.max(0.2, weights.fit - 0.1);
  }
  const weightSum =
    weights.fit + weights.cost + weights.latency + weights.load + weights.budget + weights.history;

  const excluded: PaperclipExcludedCandidate[] = [];
  const eligible: Array<{
    candidate: PaperclipCandidateAgent;
    fit: number;
    costUsd: number;
    latencyMs: number;
    load: number;
    budget: number;
    history: number;
    budgetForecast?: PaperclipBudgetForecast;
    posterior: { alpha: number; beta: number; mean: number };
  }> = [];

  for (const c of candidates) {
    const status = (c.status || 'idle').toLowerCase();
    if (status !== 'idle' && status !== 'active' && status !== 'running') {
      excluded.push({
        agentId: c.id,
        name: c.name,
        reasonCode: 'inactive_status',
        reason: `Agent status is "${c.status}"`,
      });
      continue;
    }

    if (
      typeof c.budgetMonthlyCents === 'number' &&
      c.budgetMonthlyCents > 0 &&
      typeof c.spentMonthlyCents === 'number' &&
      c.spentMonthlyCents >= c.budgetMonthlyCents
    ) {
      excluded.push({
        agentId: c.id,
        name: c.name,
        reasonCode: 'budget_exhausted',
        reason: `Monthly budget exhausted (${c.spentMonthlyCents}/${c.budgetMonthlyCents} cents)`,
      });
      continue;
    }

    if (c.supportedModalities && c.supportedModalities.length > 0) {
      const missing = classification.modalities.filter(
        (m) => m !== 'code' && !c.supportedModalities!.includes(m)
      );
      if (missing.length > 0) {
        excluded.push({
          agentId: c.id,
          name: c.name,
          reasonCode: 'modality_unsupported',
          reason: `Unsupported modality: ${missing.join(', ')}`,
        });
        continue;
      }
    }

    const egress = inferCandidateEgress(c, fleet);
    if (classification.sensitivity === 'confidential' && egress === 'cloud-ok') {
      excluded.push({
        agentId: c.id,
        name: c.name,
        reasonCode: 'sensitivity_cloud_blocked',
        reason: 'Confidential task requires local-only egress',
      });
      continue;
    }

    const fit = computeFitScore(taskTokens, classification, c, task, options);
    const { costUsd, latencyMs } = estimateCandidateCostAndLatency(c, classification, fleet);
    const load = Math.min(1, (c.openIssueCount ?? 0) / 5);
    let budget = 1;
    if (typeof c.budgetMonthlyCents === 'number' && c.budgetMonthlyCents > 0) {
      const remaining = Math.max(0, c.budgetMonthlyCents - (c.spentMonthlyCents ?? 0));
      budget = Math.min(1, remaining / c.budgetMonthlyCents);
    }
    const budgetForecast = computeBudgetForecastForCandidate(c, options);
    if (budgetForecast?.projectedDaysRemaining != null) {
      if (budgetForecast.projectedDaysRemaining < 1.5) {
        budget *= 0.35;
      } else if (budgetForecast.projectedDaysRemaining < 4) {
        budget *= 0.6;
      } else if (budgetForecast.projectedDaysRemaining < 7) {
        budget *= 0.8;
      }
    }

    const prior = outcomeHistory?.[c.id];
    const alpha =
      typeof prior?.alpha === 'number' && Number.isFinite(prior.alpha)
        ? Math.max(0.1, prior.alpha)
        : (prior?.wins ?? 0) + 1;
    const beta =
      typeof prior?.beta === 'number' && Number.isFinite(prior.beta)
        ? Math.max(0.1, prior.beta)
        : Math.max(0, (prior?.total ?? 0) - (prior?.wins ?? 0)) + 1;
    const posteriorMean = alpha / (alpha + beta);
    const history = options?.thompsonSample
      ? 0.65 * sampleBetaPosterior(alpha, beta, rng) + 0.35 * posteriorMean
      : posteriorMean;

    eligible.push({
      candidate: c,
      fit,
      costUsd,
      latencyMs,
      load,
      budget,
      history,
      budgetForecast,
      posterior: {
        alpha: Number(alpha.toFixed(2)),
        beta: Number(beta.toFixed(2)),
        mean: Number(posteriorMean.toFixed(3)),
      },
    });
  }

  const maxCost = Math.max(0.0001, ...eligible.map((e) => e.costUsd));
  const maxLatency = Math.max(100, ...eligible.map((e) => e.latencyMs));

  const scored = eligible.map((e) => {
    const normCost = e.costUsd / maxCost;
    const normLat = e.latencyMs / maxLatency;
    const rawScore =
      (weights.fit * e.fit +
        weights.cost * (1 - normCost) +
        weights.latency * (1 - normLat) +
        weights.load * (1 - e.load) +
        weights.budget * e.budget +
        weights.history * e.history) /
      (weightSum || 1);

    return {
      ...e,
      score: Number(rawScore.toFixed(4)),
    };
  });

  scored.sort((a, b) => b.score - a.score || a.costUsd - b.costUsd || a.candidate.id.localeCompare(b.candidate.id));

  const topScore = scored[0]?.score ?? 0;
  const secondScore = scored[1]?.score ?? 0;
  const margin = topScore - secondScore;

  const recommendations: PaperclipAssigneeRecommendation[] = scored.map((entry, idx) => {
    const confidence =
      idx === 0
        ? Number(((1 / (1 + Math.exp(-8 * margin))) * Math.max(0.35, entry.fit)).toFixed(3))
        : Number((entry.score * entry.fit).toFixed(3));
    const rationaleParts = [
      `fit=${(entry.fit * 100).toFixed(0)}%`,
      `est=$${entry.costUsd.toFixed(4)}`,
      `lat=${entry.latencyMs}ms`,
      `tier=${classification.suggestedTier}`,
    ];
    if (entry.candidate.isEluvixAuto || entry.candidate.model === 'eluvix/auto') {
      rationaleParts.push('switchyard=eluvix/auto');
    }
    if (classification.sensitivity === 'confidential') {
      rationaleParts.push('egress=local-only');
    }
    if (entry.budgetForecast?.projectedDaysRemaining != null && entry.budgetForecast.projectedDaysRemaining < 7) {
      rationaleParts.push(`runway=${entry.budgetForecast.projectedDaysRemaining}d`);
    }
    return {
      agentId: entry.candidate.id,
      name: entry.candidate.name,
      role: entry.candidate.role,
      adapterType: entry.candidate.adapterType,
      model: entry.candidate.model,
      score: entry.score,
      confidence,
      estimatedCostUsd: entry.costUsd,
      estimatedLatencyMs: entry.latencyMs,
      breakdown: {
        fit: Number(entry.fit.toFixed(3)),
        cost: Number((1 - entry.costUsd / maxCost).toFixed(3)),
        latency: Number((1 - entry.latencyMs / maxLatency).toFixed(3)),
        load: Number((1 - entry.load).toFixed(3)),
        budget: Number(entry.budget.toFixed(3)),
        history: Number(entry.history.toFixed(3)),
      },
      rationale: rationaleParts.join(', '),
      ...(entry.budgetForecast ? { budgetForecast: entry.budgetForecast } : {}),
      posterior: entry.posterior,
    };
  });

  return {
    classification,
    recommendations,
    excluded,
  };
}
