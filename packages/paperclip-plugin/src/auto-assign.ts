import crypto from 'node:crypto';

export type AutoAssignMode = 'off' | 'advisory' | 'shadow' | 'auto';

export interface AutoAssignConfig {
  mode: AutoAssignMode;
  companies?: string[];
  statuses: string[];
  minConfidence: number;
  maxPerHour: number;
  maxTreeDepth: number;
  requireUnassigned: boolean;
  excludeLabels: string[];
  costGuardUsd?: number;
}

export const DEFAULT_AUTO_ASSIGN_CONFIG: AutoAssignConfig = {
  mode: 'advisory',
  companies: [],
  statuses: ['backlog', 'todo'],
  minConfidence: 0.7,
  maxPerHour: 30,
  maxTreeDepth: 4,
  requireUnassigned: true,
  excludeLabels: ['no-auto-assign'],
};

export interface PluginConfig {
  eluvixBaseUrl: string;
  eluvixApiKeyRef?: string;
  autoAssign: AutoAssignConfig;
  weights?: Record<string, number>;
}

export interface PaperclipIssueLike {
  id: string;
  companyId: string;
  identifier?: string;
  title: string;
  description?: string | null;
  status: string;
  priority?: string;
  parentId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  checkoutRunId?: string | null;
  labels?: Array<string | { name?: string }>;
}

export interface PaperclipAgentLike {
  id: string;
  companyId: string;
  name: string;
  role?: string;
  title?: string;
  capabilities?: string | null;
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  status?: string;
  budgetMonthlyCents?: number;
  spentMonthlyCents?: number;
}

export interface PluginHostContext {
  config: PluginConfig;
  fetch?: typeof globalThis.fetch;
  issues: {
    get(issueId: string, companyId: string): Promise<PaperclipIssueLike | null>;
    list(input: { companyId: string; assigneeAgentId?: string; status?: string }): Promise<PaperclipIssueLike[]>;
    update(
      issueId: string,
      companyId: string,
      patch: Record<string, unknown>
    ): Promise<PaperclipIssueLike>;
    addComment(issueId: string, companyId: string, body: string): Promise<void>;
  };
  agents: {
    list(input: { companyId: string }): Promise<PaperclipAgentLike[]>;
  };
  state: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  activity?: {
    log(entry: Record<string, unknown>): Promise<void>;
  };
  secrets?: {
    resolve(ref: string): Promise<string | null>;
  };
}

export function extractIssueLabels(issue: PaperclipIssueLike): string[] {
  if (!Array.isArray(issue.labels)) return [];
  return issue.labels
    .map((l) => (typeof l === 'string' ? l : String(l?.name || '')))
    .filter(Boolean);
}

export function hashAdvisoryContent(issueId: string, topAgentId: string, rationale: string): string {
  return crypto
    .createHash('sha256')
    .update(`${issueId}:${topAgentId}:${rationale}`)
    .digest('hex')
    .slice(0, 16);
}

export async function computeIssueTreeDepth(
  issue: PaperclipIssueLike,
  ctx: PluginHostContext,
  maxCheck = 10
): Promise<number> {
  let depth = 0;
  let currentParent = issue.parentId;
  const seen = new Set<string>([issue.id]);
  while (currentParent && depth < maxCheck) {
    if (seen.has(currentParent)) break;
    seen.add(currentParent);
    depth += 1;
    const parent = await ctx.issues.get(currentParent, issue.companyId).catch(() => null);
    currentParent = parent?.parentId;
  }
  return depth;
}

export function isRateLimited(timestamps: number[], maxPerHour: number, now = Date.now()): boolean {
  const cutoff = now - 3_600_000;
  const recent = timestamps.filter((t) => t >= cutoff);
  return recent.length >= maxPerHour;
}

export function pruneOldTimestamps(timestamps: number[], now = Date.now()): number[] {
  const cutoff = now - 3_600_000;
  return timestamps.filter((t) => t >= cutoff);
}

export interface AutoAssignDecision {
  action: 'skipped' | 'advisory' | 'shadow' | 'auto_assigned';
  reason: string;
  topAgentId?: string;
  confidence?: number;
}

export async function handleUnassignedIssueEvent(
  issue: PaperclipIssueLike,
  ctx: PluginHostContext,
  eluvixApiKey: string
): Promise<AutoAssignDecision> {
  const cfg = ctx.config.autoAssign || DEFAULT_AUTO_ASSIGN_CONFIG;
  if (cfg.mode === 'off') {
    return { action: 'skipped', reason: 'mode=off' };
  }

  // S4 guard: never touch checked-out or already-assigned issues
  if (issue.checkoutRunId) {
    return { action: 'skipped', reason: 'issue_checked_out' };
  }
  if (cfg.requireUnassigned && (issue.assigneeAgentId || issue.assigneeUserId)) {
    return { action: 'skipped', reason: 'already_assigned' };
  }
  if (!cfg.statuses.includes(issue.status)) {
    return { action: 'skipped', reason: `status_${issue.status}_excluded` };
  }

  const labels = extractIssueLabels(issue);
  if (labels.some((l) => cfg.excludeLabels.includes(l))) {
    return { action: 'skipped', reason: 'excluded_label' };
  }

  const fetchFn = ctx.fetch || globalThis.fetch;
  const agents = await ctx.agents.list({ companyId: issue.companyId });
  const candidates = agents.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    title: a.title,
    capabilities: a.capabilities,
    adapterType: a.adapterType,
    model: typeof a.adapterConfig?.model === 'string' ? a.adapterConfig.model : undefined,
    status: a.status,
    budgetMonthlyCents: a.budgetMonthlyCents,
    spentMonthlyCents: a.spentMonthlyCents,
    isEluvixAuto: a.adapterConfig?.model === 'eluvix/auto',
  }));

  const baseUrl = ctx.config.eluvixBaseUrl.replace(/\/$/, '');
  const recRes = await fetchFn(`${baseUrl}/api/v1/paperclip/recommend-assignee`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(eluvixApiKey ? { Authorization: `Bearer ${eluvixApiKey}` } : {}),
    },
    body: JSON.stringify({
      task: {
        issueId: issue.id,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        labels,
      },
      candidates,
      weights: ctx.config.weights,
      topN: 3,
    }),
  });

  if (!recRes.ok) {
    return { action: 'skipped', reason: `eluvix_http_${recRes.status}` };
  }

  const recJson: any = await recRes.json();
  const top = recJson?.recommendations?.[0];
  if (!top) {
    return { action: 'skipped', reason: 'no_eligible_candidate' };
  }

  const confidence = Number(top.confidence || 0);
  const estCost = Number(top.estimatedCostUsd || 0);

  if (cfg.mode === 'shadow') {
    await ctx.state.set(`shadow:${issue.id}`, {
      issueId: issue.id,
      recommendedAgentId: top.agentId,
      confidence,
      estimatedCostUsd: estCost,
      at: new Date().toISOString(),
    });
    return {
      action: 'shadow',
      reason: 'shadow_recorded',
      topAgentId: top.agentId,
      confidence,
    };
  }

  const canAuto =
    cfg.mode === 'auto' &&
    Array.isArray(cfg.companies) &&
    cfg.companies.includes(issue.companyId) &&
    confidence >= cfg.minConfidence &&
    (cfg.costGuardUsd === undefined || estCost <= cfg.costGuardUsd);

  if (canAuto) {
    const depth = await computeIssueTreeDepth(issue, ctx, cfg.maxTreeDepth + 1);
    if (depth > cfg.maxTreeDepth) {
      return await postAdvisory(issue, top, ctx, `tree_depth_${depth}_exceeds_${cfg.maxTreeDepth}`);
    }

    const rateKey = `rate:${issue.companyId}`;
    const rawTimestamps = ((await ctx.state.get(rateKey)) as number[] | null) || [];
    if (isRateLimited(rawTimestamps, cfg.maxPerHour)) {
      return await postAdvisory(issue, top, ctx, 'hourly_rate_limit_reached');
    }

    await ctx.issues.update(issue.id, issue.companyId, {
      assigneeAgentId: top.agentId,
    });

    const nextTimestamps = [...pruneOldTimestamps(rawTimestamps), Date.now()];
    await ctx.state.set(rateKey, nextTimestamps);

    await ctx.issues.addComment(
      issue.id,
      issue.companyId,
      `[Eluvix Switchyard Auto-Assign] Assigned to **${top.name}** (confidence ${(confidence * 100).toFixed(0)}%, est. $${estCost.toFixed(4)}). Rationale: ${top.rationale}`
    );

    if (ctx.activity) {
      await ctx.activity.log({
        companyId: issue.companyId,
        action: 'eluvix.auto_assign',
        entityType: 'issue',
        entityId: issue.id,
        details: {
          assigneeAgentId: top.agentId,
          confidence,
          estimatedCostUsd: estCost,
        },
      });
    }

    return {
      action: 'auto_assigned',
      reason: 'auto_assigned',
      topAgentId: top.agentId,
      confidence,
    };
  }

  return await postAdvisory(issue, top, ctx, cfg.mode === 'auto' ? 'auto_threshold_fallback' : 'advisory');
}

async function postAdvisory(
  issue: PaperclipIssueLike,
  top: any,
  ctx: PluginHostContext,
  reason: string
): Promise<AutoAssignDecision> {
  const hash = hashAdvisoryContent(issue.id, top.agentId, String(top.rationale || ''));
  const dedupeKey = `advised:${issue.id}`;
  const prevHash = await ctx.state.get(dedupeKey);
  if (prevHash !== hash) {
    await ctx.issues.addComment(
      issue.id,
      issue.companyId,
      `[Eluvix Switchyard Advisory] Recommended assignee: **${top.name}** (confidence ${(Number(top.confidence || 0) * 100).toFixed(0)}%, est. $${Number(top.estimatedCostUsd || 0).toFixed(4)}). Rationale: ${top.rationale}`
    );
    await ctx.state.set(dedupeKey, hash);
  }
  return {
    action: 'advisory',
    reason,
    topAgentId: top.agentId,
    confidence: Number(top.confidence || 0),
  };
}
