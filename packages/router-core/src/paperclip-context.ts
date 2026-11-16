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

export interface PaperclipKeyPolicy {
  maxTier?: PaperclipStepTier;
  maxCostPer1kUsd?: number;
  companyIds?: string[];
  hmacSecret?: string;
  allowUnsignedContext?: boolean;
}

export interface PaperclipIntegrationConfig {
  enabled: boolean;
  paperclipBaseUrl?: string;
  priorityPolicy?: Partial<Record<PaperclipIssuePriority, PaperclipPriorityRule>>;
  budgetPressure?: PaperclipBudgetPressureConfig;
  sensitivityFloor?: PaperclipSensitivityFloorConfig;
  trustHeadersFrom?: 'loopback' | 'scoped-key';
  hmacSecret?: string;
  requireSignedContext?: boolean;
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

export type PaperclipSignatureStatus = 'valid' | 'unsigned' | 'invalid' | 'expired';

export interface PaperclipRequestContext {
  trusted: boolean;
  runId?: string;
  issueId?: string;
  agentId?: string;
  companyId?: string;
  priority?: PaperclipIssuePriority;
  budgetRemainingPct?: number;
  sensitivity?: PaperclipSensitivity;
  hop?: number;
  signatureStatus?: PaperclipSignatureStatus;
  keyPolicy?: PaperclipKeyPolicy;
  droppedHeaders: string[];
}

export function mergeEffectiveHops(
  eluvixHops: number,
  paperclip?: PaperclipRequestContext
): number {
  const base = Number.isFinite(eluvixHops) && eluvixHops > 0 ? Math.floor(eluvixHops) : 0;
  const pcHop =
    typeof paperclip?.hop === 'number' && Number.isFinite(paperclip.hop) && paperclip.hop > 0
      ? Math.floor(paperclip.hop)
      : 0;
  return Math.max(base, pcHop);
}

/**
 * Merges Paperclip context from HTTP headers and optional structured JSON body
 * (e.g., `/v1/route-explain`), running all values through header sanitization.
 */
export function parsePaperclipContextFromHeadersAndBody(
  headers: Record<string, string | string[] | undefined> | Headers | undefined,
  bodyPaperclip: Record<string, any> | undefined,
  opts?: { trusted?: boolean }
): PaperclipRequestContext {
  const headerCtx = parsePaperclipHeaders(headers, opts);
  if (!bodyPaperclip || typeof bodyPaperclip !== 'object') {
    return headerCtx;
  }
  const mergedHeaders: Record<string, string | undefined> = {
    'x-paperclip-run-id':
      bodyPaperclip.runId !== undefined ? String(bodyPaperclip.runId) : headerCtx.runId,
    'x-paperclip-issue-id':
      bodyPaperclip.issueId !== undefined ? String(bodyPaperclip.issueId) : headerCtx.issueId,
    'x-paperclip-agent-id':
      bodyPaperclip.agentId !== undefined ? String(bodyPaperclip.agentId) : headerCtx.agentId,
    'x-paperclip-company-id':
      bodyPaperclip.companyId !== undefined ? String(bodyPaperclip.companyId) : headerCtx.companyId,
    'x-paperclip-issue-priority':
      bodyPaperclip.priority !== undefined ? String(bodyPaperclip.priority) : headerCtx.priority,
    'x-paperclip-budget-remaining-pct':
      bodyPaperclip.budgetRemainingPct !== undefined
        ? String(bodyPaperclip.budgetRemainingPct)
        : headerCtx.budgetRemainingPct !== undefined
        ? String(headerCtx.budgetRemainingPct)
        : undefined,
    'x-paperclip-sensitivity':
      bodyPaperclip.sensitivity !== undefined
        ? String(bodyPaperclip.sensitivity)
        : headerCtx.sensitivity,
    'x-paperclip-hop':
      bodyPaperclip.hop !== undefined
        ? String(bodyPaperclip.hop)
        : headerCtx.hop !== undefined
        ? String(headerCtx.hop)
        : undefined,
  };
  const bodyParsed = parsePaperclipHeaders(mergedHeaders, opts);
  return {
    ...bodyParsed,
    droppedHeaders: Array.from(
      new Set([...headerCtx.droppedHeaders, ...bodyParsed.droppedHeaders])
    ),
  };
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

  let hop: number | undefined;
  const rawHop = readHeader(headers, 'x-paperclip-hop')?.trim();
  if (rawHop !== undefined && rawHop !== '') {
    const parsed = Number(rawHop);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 100) {
      hop = parsed;
    } else {
      droppedHeaders.push('x-paperclip-hop');
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
    hop,
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
  config?: PaperclipIntegrationConfig,
  explicitKeyPolicy?: PaperclipKeyPolicy
): ResolvedPaperclipBias {
  const keyPolicy = explicitKeyPolicy ?? ctx?.keyPolicy;
  const keyHasCeilings = Boolean(
    keyPolicy &&
      (keyPolicy.maxTier !== undefined ||
        (typeof keyPolicy.maxCostPer1kUsd === 'number' &&
          Number.isFinite(keyPolicy.maxCostPer1kUsd) &&
          keyPolicy.maxCostPer1kUsd >= 0))
  );

  if (!ctx || !ctx.trusted || !config?.enabled) {
    if (keyHasCeilings && keyPolicy) {
      const biasTags: string[] = [];
      if (keyPolicy.maxTier) biasTags.push('key-tier-ceiling');
      const keyCostCap =
        typeof keyPolicy.maxCostPer1kUsd === 'number' &&
        Number.isFinite(keyPolicy.maxCostPer1kUsd) &&
        keyPolicy.maxCostPer1kUsd >= 0
          ? keyPolicy.maxCostPer1kUsd
          : undefined;
      if (keyCostCap !== undefined) biasTags.push('key-cost-ceiling');
      return {
        active: true,
        maxTier: keyPolicy.maxTier,
        preferLocal: false,
        maxCostPer1kUsd: keyCostCap,
        allowCloud: true,
        budgetPressureTriggered: false,
        sensitivityForcedLocal: false,
        biasTags,
      };
    }
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

  // 4. Per-key ceiling clamping (S2: cannot be bypassed by priority headers or virtual tiers)
  if (keyPolicy?.maxTier) {
    maxTier = tighterMaxTier(maxTier, keyPolicy.maxTier);
    if (!biasTags.includes('key-tier-ceiling')) biasTags.push('key-tier-ceiling');
  }
  if (
    typeof keyPolicy?.maxCostPer1kUsd === 'number' &&
    Number.isFinite(keyPolicy.maxCostPer1kUsd) &&
    keyPolicy.maxCostPer1kUsd >= 0
  ) {
    maxCostPer1kUsd =
      maxCostPer1kUsd === undefined
        ? keyPolicy.maxCostPer1kUsd
        : Math.min(maxCostPer1kUsd, keyPolicy.maxCostPer1kUsd);
    if (!biasTags.includes('key-cost-ceiling')) biasTags.push('key-cost-ceiling');
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

export interface AgentTrajectoryStepClassification {
  isAgentLoop: boolean;
  stepTier?: PaperclipStepTier;
  reason?: string;
  toolTurnCount: number;
  lastRole?: string;
}

const TRAJECTORY_ERROR_RE =
  /\b(Traceback|SyntaxError|TypeError|ReferenceError|RangeError|AssertionError|Segmentation fault|segfault|panic:|fatal error|error\[E\d+\]|UnhandledPromiseRejection|ERR_[A-Z0-9_]+|FAIL\s+\S+|exit code [1-9]\d*|non-zero exit)\b/i;

const TRAJECTORY_READ_TOOL_RE =
  /\b(read_file|view_file|list_dir|find_by_name|grep|rg|search|glob|ls|cat|head|tail|stat|pwd|git_status|git_diff|git_log|inspect_repo)\b/i;

const TRAJECTORY_WRITE_TOOL_RE =
  /\b(write_file|edit_file|replace_file|apply_patch|patch|bash|sh|exec|run_command|terminal|npm|vitest|pytest|cargo|tsc|build|test)\b/i;

function extractTrajectoryMessageText(msg: Record<string, any>): string {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('\n');
  }
  return '';
}

function extractTrajectoryToolNames(msg: Record<string, any>): string[] {
  const names: string[] = [];
  if (typeof msg?.name === 'string' && msg.name.trim()) names.push(msg.name.trim());
  if (Array.isArray(msg?.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const fn = tc?.function?.name || tc?.name;
      if (typeof fn === 'string' && fn.trim()) names.push(fn.trim());
    }
  }
  return names;
}

/**
 * Classifies an ongoing multi-turn agent tool-loop trajectory into a virtual
 * Switchyard tier (`fast-general`, `code-specialist`, `heavy-reasoning`).
 * Only activates when `messages.length >= 3` and tool-use signals are present
 * so single-turn human chat requests remain unaffected.
 */
export function classifyAgentTrajectoryStep(
  messages: Array<Record<string, any>> | undefined | null
): AgentTrajectoryStepClassification {
  if (!Array.isArray(messages) || messages.length < 3) {
    return { isAgentLoop: false, toolTurnCount: 0 };
  }

  let toolTurnCount = 0;
  let hasToolSignal = false;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'tool') {
      toolTurnCount += 1;
      hasToolSignal = true;
    } else if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      hasToolSignal = true;
    }
  }

  if (!hasToolSignal) {
    return { isAgentLoop: false, toolTurnCount: 0 };
  }

  const lastMsg = messages[messages.length - 1] || {};
  const lastRole = typeof lastMsg.role === 'string' ? lastMsg.role : undefined;

  const tail = messages.slice(-4);
  let tailErrorDetected = false;
  let maxToolOutputLen = 0;
  const recentToolNames: string[] = [];

  for (const m of tail) {
    if (!m || typeof m !== 'object') continue;
    recentToolNames.push(...extractTrajectoryToolNames(m));
    if (m.role === 'tool') {
      const txt = extractTrajectoryMessageText(m);
      maxToolOutputLen = Math.max(maxToolOutputLen, txt.length);
      if (TRAJECTORY_ERROR_RE.test(txt)) {
        tailErrorDetected = true;
      }
    }
  }

  if (tailErrorDetected) {
    return {
      isAgentLoop: true,
      stepTier: 'heavy-reasoning',
      reason: 'error-recovery',
      toolTurnCount,
      lastRole,
    };
  }

  const allRecentToolsReadOnly =
    recentToolNames.length > 0 && recentToolNames.every((n) => TRAJECTORY_READ_TOOL_RE.test(n));
  const hasWriteOrExecTool = recentToolNames.some((n) => TRAJECTORY_WRITE_TOOL_RE.test(n));

  if ((allRecentToolsReadOnly || (!hasWriteOrExecTool && toolTurnCount >= 1)) && maxToolOutputLen <= 1200) {
    return {
      isAgentLoop: true,
      stepTier: 'fast-local',
      reason: 'lightweight-inspection-followup',
      toolTurnCount,
      lastRole,
    };
  }

  return {
    isAgentLoop: true,
    stepTier: 'code-specialist',
    reason: hasWriteOrExecTool ? 'code-patch-or-exec' : 'agent-synthesis',
    toolTurnCount,
    lastRole,
  };
}
