/**
 * Browser-safe Paperclip context parsing, priority routing policy types,
 * and virtual Switchyard tier alias definitions.
 *
 * IMPORTANT: Do NOT import any `node:*` modules here (imported by Next.js client components).
 */

export type PaperclipIssuePriority = 'critical' | 'high' | 'medium' | 'low';
export type PaperclipSensitivity = 'public' | 'internal' | 'confidential';
export type PaperclipStepTier =
  | 'fast-local'
  | 'code-specialist'
  | 'heavy-reasoning'
  | 'frontier-verified';

export const PAPERCLIP_STEP_TIER_RANK: Record<PaperclipStepTier, number> = {
  'fast-local': 1,
  'code-specialist': 2,
  'heavy-reasoning': 3,
  'frontier-verified': 4,
};

export interface PaperclipPriorityRule {
  minTier?: PaperclipStepTier;
  maxTier?: PaperclipStepTier;
  preferLocal?: boolean;
  maxCostPer1kUsd?: number;
  allowCloud?: boolean;
}

export interface PaperclipBudgetPressureConfig {
  thresholdPct: number;
  action: 'cascade-cheaper' | 'local-only' | 'none';
}

export interface PaperclipSensitivityFloorConfig {
  confidential: 'local-only';
  internal?: 'local-preferred';
}

export interface PaperclipIntegrationConfig {
  enabled: boolean;
  paperclipBaseUrl?: string;
  priorityPolicy?: Partial<Record<PaperclipIssuePriority, PaperclipPriorityRule>>;
  budgetPressure?: PaperclipBudgetPressureConfig;
  sensitivityFloor?: PaperclipSensitivityFloorConfig;
  trustHeadersFrom?: 'loopback' | 'scoped-key';
}

export const DEFAULT_PAPERCLIP_PRIORITY_POLICY: Record<
  PaperclipIssuePriority,
  PaperclipPriorityRule
> = {
  critical: { minTier: 'heavy-reasoning', allowCloud: true },
  high: { minTier: 'code-specialist' },
  medium: {},
  low: { preferLocal: true, maxTier: 'code-specialist' },
};

export const DEFAULT_PAPERCLIP_INTEGRATION_CONFIG: PaperclipIntegrationConfig = {
  enabled: false,
  paperclipBaseUrl: 'http://127.0.0.1:3100',
  priorityPolicy: DEFAULT_PAPERCLIP_PRIORITY_POLICY,
  budgetPressure: { thresholdPct: 15, action: 'cascade-cheaper' },
  sensitivityFloor: { confidential: 'local-only', internal: 'local-preferred' },
  trustHeadersFrom: 'scoped-key',
};

export const PAPERCLIP_VIRTUAL_MODELS: ReadonlyArray<{
  id: string;
  label: string;
  tier?: PaperclipStepTier;
}> = [
  { id: 'eluvix/auto', label: 'Eluvix Auto (Switchyard)' },
  { id: 'eluvix/fast-local', label: 'Eluvix Fast Local (Tier 1)', tier: 'fast-local' },
  {
    id: 'eluvix/code-specialist',
    label: 'Eluvix Code Specialist (Tier 2)',
    tier: 'code-specialist',
  },
  {
    id: 'eluvix/heavy-reasoning',
    label: 'Eluvix Heavy Reasoning (Tier 3)',
    tier: 'heavy-reasoning',
  },
  {
    id: 'eluvix/frontier-verified',
    label: 'Eluvix Frontier Verified (Tier 4)',
    tier: 'frontier-verified',
  },
];

export function resolveVirtualTierAlias(model?: string | null): PaperclipStepTier | undefined {
  if (!model) return undefined;
  const norm = model.trim().toLowerCase();
  const found = PAPERCLIP_VIRTUAL_MODELS.find((m) => m.id === norm);
  return found?.tier;
}

export interface PaperclipRequestContext {
  trusted: boolean;
  runId?: string;
  issueId?: string;
  agentId?: string;
  companyId?: string;
  priority?: PaperclipIssuePriority;
  budgetRemainingPct?: number;
  sensitivity?: PaperclipSensitivity;
  droppedHeaders: string[];
}

export interface ResolvedPaperclipBias {
  active: boolean;
  minTier?: PaperclipStepTier;
  maxTier?: PaperclipStepTier;
  preferLocal: boolean;
  maxCostPer1kUsd?: number;
  allowCloud: boolean;
  budgetPressureTriggered: boolean;
  sensitivityForcedLocal: boolean;
  biasTags: string[];
  relaxed?: boolean;
}

const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function readHeader(
  headers: Record<string, string | string[] | undefined> | Headers | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    const val = (headers as Headers).get(name);
    return val === null ? undefined : val;
  }
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() === target) {
      if (Array.isArray(v)) return v[0];
      return v;
    }
  }
  return undefined;
}

function sanitizeIdHeader(
  raw: string | undefined,
  headerName: string,
  dropped: string[]
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!SAFE_ID_RE.test(trimmed)) {
    dropped.push(headerName);
    return undefined;
  }
  return trimmed;
}

export function parsePaperclipHeaders(
  headers: Record<string, string | string[] | undefined> | Headers | undefined,
  opts?: { trusted?: boolean }
): PaperclipRequestContext {
  const droppedHeaders: string[] = [];
  const trusted = opts?.trusted ?? false;

  const runId = sanitizeIdHeader(
    readHeader(headers, 'x-paperclip-run-id'),
    'x-paperclip-run-id',
    droppedHeaders
  );
  const issueId = sanitizeIdHeader(
    readHeader(headers, 'x-paperclip-issue-id'),
    'x-paperclip-issue-id',
    droppedHeaders
  );
  const agentId = sanitizeIdHeader(
    readHeader(headers, 'x-paperclip-agent-id'),
    'x-paperclip-agent-id',
    droppedHeaders
  );
  const companyId = sanitizeIdHeader(
    readHeader(headers, 'x-paperclip-company-id'),
    'x-paperclip-company-id',
    droppedHeaders
  );

  let priority: PaperclipIssuePriority | undefined;
  const rawPriority = readHeader(headers, 'x-paperclip-issue-priority')?.trim().toLowerCase();
  if (rawPriority) {
    if (
      rawPriority === 'critical' ||
      rawPriority === 'high' ||
      rawPriority === 'medium' ||
      rawPriority === 'low'
    ) {
      priority = rawPriority;
    } else {
      droppedHeaders.push('x-paperclip-issue-priority');
    }
  }

  let budgetRemainingPct: number | undefined;
  const rawBudget = readHeader(headers, 'x-paperclip-budget-remaining-pct')?.trim();
  if (rawBudget !== undefined && rawBudget !== '') {
    const parsed = Number(rawBudget);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
      budgetRemainingPct = parsed;
    } else {
      droppedHeaders.push('x-paperclip-budget-remaining-pct');
    }
  }

  let sensitivity: PaperclipSensitivity | undefined;
  const rawSensitivity = readHeader(headers, 'x-paperclip-sensitivity')?.trim().toLowerCase();
  if (rawSensitivity) {
    if (
      rawSensitivity === 'public' ||
      rawSensitivity === 'internal' ||
      rawSensitivity === 'confidential'
    ) {
      sensitivity = rawSensitivity;
    } else {
      droppedHeaders.push('x-paperclip-sensitivity');
    }
  }

  return {
    trusted,
    runId,
    issueId,
    agentId,
    companyId,
    priority,
    budgetRemainingPct,
    sensitivity,
    droppedHeaders,
  };
}

function tighterMinTier(
  a?: PaperclipStepTier,
  b?: PaperclipStepTier
): PaperclipStepTier | undefined {
  if (!a) return b;
  if (!b) return a;
  return PAPERCLIP_STEP_TIER_RANK[a] >= PAPERCLIP_STEP_TIER_RANK[b] ? a : b;
}

function tighterMaxTier(
  a?: PaperclipStepTier,
  b?: PaperclipStepTier
): PaperclipStepTier | undefined {
  if (!a) return b;
  if (!b) return a;
  return PAPERCLIP_STEP_TIER_RANK[a] <= PAPERCLIP_STEP_TIER_RANK[b] ? a : b;
}

export function resolvePaperclipRoutingBias(
  ctx: PaperclipRequestContext | undefined,
  config?: PaperclipIntegrationConfig
): ResolvedPaperclipBias {
  if (!ctx || !ctx.trusted || !config?.enabled) {
    return {
      active: false,
      preferLocal: false,
      allowCloud: true,
      budgetPressureTriggered: false,
      sensitivityForcedLocal: false,
      biasTags: [],
    };
  }

  const biasTags: string[] = [];
  let minTier: PaperclipStepTier | undefined;
  let maxTier: PaperclipStepTier | undefined;
  let preferLocal = false;
  let maxCostPer1kUsd: number | undefined;
  let allowCloud = true;
  let sensitivityForcedLocal = false;
  let budgetPressureTriggered = false;

  // 1. Priority policy
  const priorityRules = {
    ...DEFAULT_PAPERCLIP_PRIORITY_POLICY,
    ...(config.priorityPolicy || {}),
  };
  if (ctx.priority) {
    const rule = priorityRules[ctx.priority];
    if (rule) {
      if (rule.minTier) {
        minTier = tighterMinTier(minTier, rule.minTier);
        biasTags.push('tier-floor');
      }
      if (rule.maxTier) {
        maxTier = tighterMaxTier(maxTier, rule.maxTier);
        biasTags.push('tier-ceiling');
      }
      if (rule.preferLocal) {
        preferLocal = true;
        biasTags.push('prefer-local');
      }
      if (typeof rule.maxCostPer1kUsd === 'number' && rule.maxCostPer1kUsd >= 0) {
        maxCostPer1kUsd = rule.maxCostPer1kUsd;
        biasTags.push('cost-ceiling');
      }
      if (rule.allowCloud === false) {
        allowCloud = false;
        biasTags.push('local-only');
      }
    }
  }

  // 2. Budget pressure (overrides upward tier floor with cheaper/local when remaining budget is low)
  const bp = config.budgetPressure ?? DEFAULT_PAPERCLIP_INTEGRATION_CONFIG.budgetPressure!;
  if (
    typeof ctx.budgetRemainingPct === 'number' &&
    bp.action !== 'none' &&
    ctx.budgetRemainingPct <= bp.thresholdPct
  ) {
    budgetPressureTriggered = true;
    preferLocal = true;
    if (bp.action === 'local-only') {
      allowCloud = false;
      biasTags.push('local-only');
    } else if (bp.action === 'cascade-cheaper') {
      maxTier = tighterMaxTier(maxTier, 'code-specialist');
      biasTags.push('cost-ceiling');
    }
  }

  // 3. Sensitivity floor (highest precedence for egress)
  const sensCfg = config.sensitivityFloor ?? DEFAULT_PAPERCLIP_INTEGRATION_CONFIG.sensitivityFloor!;
  if (ctx.sensitivity === 'confidential' && sensCfg.confidential === 'local-only') {
    allowCloud = false;
    preferLocal = true;
    sensitivityForcedLocal = true;
    if (!biasTags.includes('local-only')) biasTags.push('local-only');
  } else if (ctx.sensitivity === 'internal' && sensCfg.internal === 'local-preferred') {
    preferLocal = true;
    if (!biasTags.includes('prefer-local')) biasTags.push('prefer-local');
  }

  // Ensure minTier never exceeds maxTier if both set
  if (minTier && maxTier && PAPERCLIP_STEP_TIER_RANK[minTier] > PAPERCLIP_STEP_TIER_RANK[maxTier]) {
    minTier = maxTier;
  }

  const active =
    biasTags.length > 0 ||
    ctx.priority !== undefined ||
    ctx.sensitivity !== undefined ||
    budgetPressureTriggered;

  return {
    active,
    minTier,
    maxTier,
    preferLocal,
    maxCostPer1kUsd,
    allowCloud,
    budgetPressureTriggered,
    sensitivityForcedLocal,
    biasTags: Array.from(new Set(biasTags)),
  };
}
