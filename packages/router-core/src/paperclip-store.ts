import crypto from 'node:crypto';
import {
  getCachedPaperclipEmbedding,
  getDb,
  setCachedPaperclipEmbedding,
} from './db.js';
import { dispatchAlertWebhooks } from './webhooks.js';
import {
  classifyPaperclipTask,
  cosineSimilarity,
  recommendPaperclipAssignees,
  type PaperclipAssignmentWeights,
  type PaperclipCandidateAgent,
  type PaperclipFleetUpstreamSummary,
  type PaperclipOutcomePrior,
  type PaperclipRecommendResult,
  type PaperclipTaskInput,
} from './paperclip-assign.js';

const BUDGET_FORECAST_ALERTED = new Set<string>();

export interface PaperclipUsageByModel {
  model: string;
  upstreamId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  requests: number;
}

export interface PaperclipRunUsageSummary {
  runId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  requests: number;
  dominantModel?: string;
  byModel: PaperclipUsageByModel[];
  firstAt?: string;
  lastAt?: string;
}

export function getPaperclipUsageByCorrelation(
  runId: string,
  userId?: string,
  allowedCompanyIds?: string[]
): PaperclipRunUsageSummary {
  const db = getDb();
  const hasUserFilter = Boolean(userId && userId !== 'admin');
  const companies = Array.isArray(allowedCompanyIds)
    ? allowedCompanyIds.filter((c) => typeof c === 'string' && c.length > 0)
    : [];
  const clauses: string[] = ['correlation_id = ?'];
  const params: any[] = [runId];
  if (hasUserFilter) {
    clauses.push('user_id = ?');
    params.push(userId);
  }
  if (companies.length > 0) {
    clauses.push(`pc_company_id IN (${companies.map(() => '?').join(', ')})`);
    params.push(...companies);
  }
  const rows = db
    .prepare(
      `SELECT model, upstream_id,
              SUM(COALESCE(prompt_tokens, 0)) AS input_tokens,
              SUM(COALESCE(completion_tokens, 0)) AS output_tokens,
              SUM(COALESCE(cache_read_tokens, 0)) AS cached_input_tokens,
              SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens,
              SUM(COALESCE(cost_usd, 0)) AS cost_usd,
              COUNT(*) AS requests,
              MIN(timestamp) AS first_at,
              MAX(timestamp) AS last_at
       FROM request_logs
       WHERE ${clauses.join(' AND ')}
       GROUP BY model, upstream_id`
    )
    .all(...params) as any[];

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let requests = 0;
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  let dominantModel: string | undefined;
  let maxTokensForDominant = -1;

  const byModel: PaperclipUsageByModel[] = rows.map((r) => {
    const inp = Number(r.input_tokens || 0);
    const out = Number(r.output_tokens || 0);
    const cached = Number(r.cached_input_tokens || 0);
    const cacheWrite = Number(r.cache_write_tokens || 0);
    const cost = Number(r.cost_usd || 0);
    const reqs = Number(r.requests || 0);

    inputTokens += inp;
    outputTokens += out;
    cachedInputTokens += cached;
    cacheWriteTokens += cacheWrite;
    costUsd += cost;
    requests += reqs;

    if (r.first_at && (!firstAt || r.first_at < firstAt)) firstAt = String(r.first_at);
    if (r.last_at && (!lastAt || r.last_at > lastAt)) lastAt = String(r.last_at);

    const totalTok = inp + out;
    if (totalTok > maxTokensForDominant) {
      maxTokensForDominant = totalTok;
      dominantModel = String(r.model);
    }

    return {
      model: String(r.model),
      upstreamId: String(r.upstream_id),
      inputTokens: inp,
      outputTokens: out,
      cachedInputTokens: cached,
      cacheWriteTokens: cacheWrite,
      costUsd: Number(cost.toFixed(6)),
      requests: reqs,
    };
  });

  return {
    runId,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    costUsd: Number(costUsd.toFixed(6)),
    requests,
    dominantModel,
    byModel,
    firstAt,
    lastAt,
  };
}

export interface PaperclipIssueClassificationRecord {
  issueId: string;
  userId?: string;
  companyId?: string;
  taskClass: string;
  title?: string;
  priority?: string;
}

export function recordPaperclipIssueClassification(
  input: PaperclipIssueClassificationRecord
): void {
  if (!input.issueId || !input.taskClass) return;
  const db = getDb();
  db.prepare(
    `INSERT INTO paperclip_issue_classifications (issue_id, user_id, company_id, task_class, title, priority, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(issue_id) DO UPDATE SET
       user_id = excluded.user_id,
       company_id = COALESCE(excluded.company_id, paperclip_issue_classifications.company_id),
       task_class = excluded.task_class,
       title = COALESCE(excluded.title, paperclip_issue_classifications.title),
       priority = COALESCE(excluded.priority, paperclip_issue_classifications.priority),
       updated_at = CURRENT_TIMESTAMP`
  ).run(
    input.issueId,
    input.userId || 'default',
    input.companyId || null,
    input.taskClass,
    input.title ? input.title.slice(0, 500) : null,
    input.priority || null
  );
}

export function getPaperclipIssueClassification(
  issueId: string,
  userId?: string,
  allowedCompanyIds?: string[]
): { taskClass: string; companyId?: string; title?: string; priority?: string } | null {
  if (!issueId) return null;
  const db = getDb();
  const hasUser = Boolean(userId && userId !== 'admin');
  const companies = Array.isArray(allowedCompanyIds)
    ? allowedCompanyIds.filter((c) => typeof c === 'string' && c.length > 0)
    : [];
  const clauses: string[] = ['issue_id = ?'];
  const params: any[] = [issueId];
  if (hasUser) {
    clauses.push('user_id = ?');
    params.push(userId);
  }
  if (companies.length > 0) {
    clauses.push(`company_id IN (${companies.map(() => '?').join(', ')})`);
    params.push(...companies);
  }
  const row = db
    .prepare(
      `SELECT task_class, company_id, title, priority
       FROM paperclip_issue_classifications
       WHERE ${clauses.join(' AND ')}`
    )
    .get(...params) as any;
  if (!row || !row.task_class) return null;
  return {
    taskClass: String(row.task_class),
    companyId: row.company_id ? String(row.company_id) : undefined,
    title: row.title ? String(row.title) : undefined,
    priority: row.priority ? String(row.priority) : undefined,
  };
}

export interface PaperclipAssignmentOutcomeInput {
  userId?: string;
  companyId?: string;
  issueId: string;
  agentId: string;
  taskClass: string;
  success: boolean;
  reopened?: boolean;
  outcomeStatus?: string;
  costUsd?: number;
  durationMs?: number;
  allowedCompanyIds?: string[];
}

export function recordPaperclipAssignmentOutcome(input: PaperclipAssignmentOutcomeInput): void {
  const db = getDb();
  const effectiveUserId = input.userId || 'default';
  const cost = typeof input.costUsd === 'number' && Number.isFinite(input.costUsd) ? input.costUsd : 0;
  const dur =
    typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
      ? Math.round(input.durationMs)
      : 0;
  const successInt = input.success ? 1 : 0;
  const reopenedInt = input.reopened ? 1 : 0;

  // Deduplicate outcomes per (user_id, issue_id, agent_id) so repeated runs
  // update the canonical outcome rather than inflating prior weights.
  const existing = db
    .prepare(
      `SELECT id, cost_usd, duration_ms FROM paperclip_assignment_outcomes
       WHERE user_id = ? AND issue_id = ? AND agent_id = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(effectiveUserId, input.issueId, input.agentId) as
    | { id: number; cost_usd?: number; duration_ms?: number }
    | undefined;

  if (existing && typeof existing.id === 'number') {
    const nextCost = cost > 0 ? cost : Number(existing.cost_usd || 0);
    const nextDur = dur > 0 ? dur : Number(existing.duration_ms || 0);
    db.prepare(
      `UPDATE paperclip_assignment_outcomes
       SET timestamp = CURRENT_TIMESTAMP,
           company_id = COALESCE(?, company_id),
           task_class = ?,
           success = ?,
           reopened = ?,
           outcome_status = COALESCE(?, outcome_status),
           cost_usd = ?,
           duration_ms = ?
       WHERE id = ?`
    ).run(
      input.companyId || null,
      input.taskClass,
      successInt,
      reopenedInt,
      input.outcomeStatus || null,
      nextCost,
      nextDur,
      existing.id
    );
    return;
  }

  db.prepare(
    `INSERT INTO paperclip_assignment_outcomes (user_id, company_id, issue_id, agent_id, task_class, success, reopened, outcome_status, cost_usd, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    effectiveUserId,
    input.companyId || null,
    input.issueId,
    input.agentId,
    input.taskClass,
    successInt,
    reopenedInt,
    input.outcomeStatus || null,
    cost,
    dur
  );
}

export interface PaperclipFeedbackPayload {
  userId?: string;
  companyId?: string;
  issueId: string;
  agentId: string;
  runId?: string;
  task?: Partial<PaperclipTaskInput>;
  title?: string;
  description?: string;
  priority?: PaperclipTaskInput['priority'];
  labels?: string[];
  sensitivity?: PaperclipTaskInput['sensitivity'];
  taskClass?: string;
  success: boolean;
  reopened?: boolean;
  outcomeStatus?: string;
  costUsd?: number;
  durationMs?: number;
  allowedCompanyIds?: string[];
}

/**
 * Resolves `taskClass` server-side from issue metadata or prior stored classification
 * and deduplicates the outcome per `(userId, issueId, agentId)`.
 */
export function resolveAndRecordPaperclipFeedback(
  input: PaperclipFeedbackPayload
): { ok: true; taskClass: string } {
  const userId = input.userId || 'default';
  const taskCandidate = input.task && typeof input.task === 'object' ? input.task : null;
  const effectiveTitle =
    typeof taskCandidate?.title === 'string' && taskCandidate.title.trim()
      ? taskCandidate.title
      : typeof input.title === 'string' && input.title.trim()
      ? input.title
      : undefined;

  let derivedTaskClass: string | undefined;
  if (effectiveTitle) {
    const cls = classifyPaperclipTask({
      issueId: input.issueId,
      title: effectiveTitle,
      description:
        typeof taskCandidate?.description === 'string'
          ? taskCandidate.description
          : input.description,
      priority: taskCandidate?.priority ?? input.priority,
      labels: Array.isArray(taskCandidate?.labels)
        ? taskCandidate.labels.map(String)
        : Array.isArray(input.labels)
        ? input.labels.map(String)
        : undefined,
      sensitivity: taskCandidate?.sensitivity ?? input.sensitivity,
    });
    derivedTaskClass = cls.taskClass;
    recordPaperclipIssueClassification({
      issueId: input.issueId,
      userId,
      companyId: input.companyId,
      taskClass: derivedTaskClass,
      title: effectiveTitle,
      priority:
        typeof (taskCandidate?.priority ?? input.priority) === 'string'
          ? String(taskCandidate?.priority ?? input.priority)
          : undefined,
    });
  } else {
    const stored = getPaperclipIssueClassification(
      input.issueId,
      userId,
      input.allowedCompanyIds
    );
    if (stored?.taskClass) {
      derivedTaskClass = stored.taskClass;
    }
  }

  let resolvedCostUsd =
    typeof input.costUsd === 'number' && Number.isFinite(input.costUsd)
      ? input.costUsd
      : undefined;
  if (resolvedCostUsd === undefined && typeof input.runId === 'string' && input.runId.trim()) {
    const usage = getPaperclipUsageByCorrelation(
      input.runId.trim(),
      userId,
      input.allowedCompanyIds
    );
    if (usage.requests > 0) {
      resolvedCostUsd = usage.costUsd;
    }
  }

  const finalTaskClass =
    derivedTaskClass ||
    (typeof input.taskClass === 'string' && input.taskClass.trim()
      ? input.taskClass.trim()
      : 'text:moderate');

  recordPaperclipAssignmentOutcome({
    userId,
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.agentId,
    taskClass: finalTaskClass,
    success: Boolean(input.success),
    reopened: Boolean(input.reopened),
    outcomeStatus: input.outcomeStatus,
    costUsd: resolvedCostUsd ?? 0,
    durationMs: typeof input.durationMs === 'number' ? input.durationMs : 0,
  });

  return { ok: true, taskClass: finalTaskClass };
}

function parseSqliteTimestampMs(ts: unknown): number {
  if (typeof ts !== 'string' || !ts.trim()) return 0;
  const trimmed = ts.trim();
  const normalized = trimmed.includes('T')
    ? trimmed
    : `${trimmed.replace(' ', 'T')}${trimmed.endsWith('Z') ? '' : 'Z'}`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getPaperclipOutcomePriors(
  taskClass?: string,
  userId?: string,
  companyIds?: string[],
  options?: { decayHalfLifeDays?: number; nowMs?: number }
): Record<string, PaperclipOutcomePrior> {
  const db = getDb();
  const hasUser = Boolean(userId && userId !== 'admin');
  const companies = Array.isArray(companyIds)
    ? companyIds.filter((c) => typeof c === 'string' && c.length > 0)
    : [];
  let sql = `SELECT agent_id, success, reopened, cost_usd, timestamp FROM paperclip_assignment_outcomes WHERE 1=1`;
  const params: any[] = [];
  if (taskClass) {
    sql += ` AND task_class = ?`;
    params.push(taskClass);
  }
  if (hasUser) {
    sql += ` AND user_id = ?`;
    params.push(userId);
  }
  if (companies.length > 0) {
    sql += ` AND company_id IN (${companies.map(() => '?').join(', ')})`;
    params.push(...companies);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    agent_id: string;
    success: number;
    reopened: number;
    cost_usd: number | null;
    timestamp: string | null;
  }>;

  const halfLifeDays = Math.max(1, options?.decayHalfLifeDays ?? 30);
  const nowMs = options?.nowMs ?? Date.now();
  const nonZeroCosts = rows
    .map((r) => Number(r.cost_usd || 0))
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  const medianCost =
    nonZeroCosts.length > 0
      ? Math.max(0.005, nonZeroCosts[Math.floor(nonZeroCosts.length / 2)])
      : 0.01;

  const accum = new Map<
    string,
    {
      rawWins: number;
      rawTotal: number;
      alphaDelta: number;
      betaDelta: number;
      costSum: number;
    }
  >();

  for (const r of rows) {
    const agentId = String(r.agent_id);
    const entry = accum.get(agentId) || {
      rawWins: 0,
      rawTotal: 0,
      alphaDelta: 0,
      betaDelta: 0,
      costSum: 0,
    };
    const isWin = Number(r.success || 0) === 1 && Number(r.reopened || 0) === 0;
    const costUsd = Math.max(0, Number(r.cost_usd || 0));
    const tsMs = parseSqliteTimestampMs(r.timestamp);
    const ageDays = tsMs > 0 ? Math.max(0, (nowMs - tsMs) / 86_400_000) : 0;
    const decay = Math.exp((-Math.LN2 * ageDays) / halfLifeDays);

    entry.rawTotal += 1;
    entry.costSum += costUsd;
    if (isWin) {
      entry.rawWins += 1;
      const costFactor =
        costUsd === 0 || costUsd <= medianCost
          ? 1.05
          : costUsd > medianCost * 2
            ? 0.85
            : 1.0;
      entry.alphaDelta += decay * costFactor;
    } else {
      const penaltyFactor = Number(r.reopened || 0) === 1 ? 1.25 : 1.0;
      entry.betaDelta += decay * penaltyFactor;
    }
    accum.set(agentId, entry);
  }

  const out: Record<string, PaperclipOutcomePrior> = {};
  for (const [agentId, s] of accum.entries()) {
    out[agentId] = {
      wins: s.rawWins,
      total: s.rawTotal,
      alpha: Number((1 + s.alphaDelta).toFixed(4)),
      beta: Number((1 + s.betaDelta).toFixed(4)),
      avgCostUsd: s.rawTotal > 0 ? Number((s.costSum / s.rawTotal).toFixed(6)) : 0,
    };
  }
  return out;
}

export function getPaperclipAgentBurnRates(
  agentIds: string[],
  days = 7,
  companyIds?: string[]
): Record<string, number> {
  const uniqueIds = Array.from(new Set(agentIds.filter((id) => typeof id === 'string' && id.length > 0)));
  if (uniqueIds.length === 0) return {};

  const safeDays = Math.max(1, Math.min(90, Math.floor(days)));
  const db = getDb();
  const companies = Array.isArray(companyIds)
    ? companyIds.filter((c) => typeof c === 'string' && c.length > 0)
    : [];
  let sql = `
    SELECT pc_agent_id AS agent_id, COALESCE(SUM(cost_usd), 0) AS total_usd
    FROM request_logs
    WHERE pc_agent_id IN (${uniqueIds.map(() => '?').join(', ')})
      AND timestamp >= datetime('now', '-' || ? || ' days')
  `;
  const params: any[] = [...uniqueIds, safeDays];
  if (companies.length > 0) {
    sql += ` AND pc_company_id IN (${companies.map(() => '?').join(', ')})`;
    params.push(...companies);
  }
  sql += ` GROUP BY pc_agent_id`;

  const rows = db.prepare(sql).all(...params) as Array<{
    agent_id: string;
    total_usd: number;
  }>;

  const out: Record<string, number> = {};
  for (const r of rows) {
    const usdPerDay = Math.max(0, Number(r.total_usd || 0)) / safeDays;
    out[String(r.agent_id)] = Number((usdPerDay * 100).toFixed(4));
  }
  return out;
}

export interface PaperclipObservabilitySummary {
  totalRequests: number;
  distinctRuns: number;
  totalCostUsd: number;
  avgDurationMs: number;
  assignmentTotal: number;
  assignmentWins: number;
  assignmentSuccessRatePct: number;
  recentRuns: Array<{
    runId: string;
    issueId: string | null;
    agentId: string | null;
    companyId: string | null;
    priority: string | null;
    model: string | null;
    requests: number;
    costUsd: number;
    avgDurationMs: number;
    lastAt: string | null;
  }>;
}

export function getPaperclipObservabilitySummary(opts?: {
  userId?: string;
  companyIds?: string[];
  limit?: number;
}): PaperclipObservabilitySummary {
  const db = getDb();
  const hasUser = Boolean(opts?.userId && opts.userId !== 'admin');
  const companies = Array.isArray(opts?.companyIds)
    ? opts!.companyIds.filter((c) => typeof c === 'string' && c.length > 0)
    : [];
  const limit = Math.max(1, Math.min(50, Math.floor(opts?.limit ?? 15)));

  let aggSql = `
    SELECT
      COUNT(*) AS total_requests,
      COUNT(DISTINCT COALESCE(correlation_id, 'id:' || CAST(id AS TEXT))) AS distinct_runs,
      COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
      COALESCE(AVG(duration_ms), 0) AS avg_duration_ms
    FROM request_logs
    WHERE (correlation_id IS NOT NULL OR pc_issue_id IS NOT NULL OR pc_agent_id IS NOT NULL)
  `;
  const aggParams: any[] = [];
  if (hasUser) {
    aggSql += ` AND user_id = ?`;
    aggParams.push(opts!.userId);
  }
  if (companies.length > 0) {
    aggSql += ` AND pc_company_id IN (${companies.map(() => '?').join(', ')})`;
    aggParams.push(...companies);
  }
  const aggRow = (db.prepare(aggSql).get(...aggParams) as any) || {};

  let runsSql = `
    SELECT
      correlation_id AS run_id,
      MAX(pc_issue_id) AS issue_id,
      MAX(pc_agent_id) AS agent_id,
      MAX(pc_company_id) AS company_id,
      MAX(pc_priority) AS priority,
      MAX(model) AS model,
      COUNT(*) AS requests,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
      MAX(timestamp) AS last_at
    FROM request_logs
    WHERE correlation_id IS NOT NULL AND correlation_id != ''
  `;
  const runsParams: any[] = [];
  if (hasUser) {
    runsSql += ` AND user_id = ?`;
    runsParams.push(opts!.userId);
  }
  if (companies.length > 0) {
    runsSql += ` AND pc_company_id IN (${companies.map(() => '?').join(', ')})`;
    runsParams.push(...companies);
  }
  runsSql += ` GROUP BY correlation_id ORDER BY MAX(id) DESC LIMIT ?`;
  runsParams.push(limit);

  const runRows = db.prepare(runsSql).all(...runsParams) as any[];

  let outSql = `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN success = 1 AND COALESCE(reopened, 0) = 0 THEN 1 ELSE 0 END), 0) AS wins FROM paperclip_assignment_outcomes WHERE 1=1`;
  const outParams: any[] = [];
  if (hasUser) {
    outSql += ` AND user_id = ?`;
    outParams.push(opts!.userId);
  }
  if (companies.length > 0) {
    outSql += ` AND company_id IN (${companies.map(() => '?').join(', ')})`;
    outParams.push(...companies);
  }
  const outRow = (db.prepare(outSql).get(...outParams) as any) || {};
  const assignmentTotal = Number(outRow.total || 0);
  const assignmentWins = Number(outRow.wins || 0);

  return {
    totalRequests: Number(aggRow.total_requests || 0),
    distinctRuns: Number(aggRow.distinct_runs || 0),
    totalCostUsd: Number(Number(aggRow.total_cost_usd || 0).toFixed(6)),
    avgDurationMs: Math.round(Number(aggRow.avg_duration_ms || 0)),
    assignmentTotal,
    assignmentWins,
    assignmentSuccessRatePct:
      assignmentTotal > 0 ? Math.round((assignmentWins / assignmentTotal) * 100) : 100,
    recentRuns: runRows.map((r) => ({
      runId: String(r.run_id),
      issueId: r.issue_id ? String(r.issue_id) : null,
      agentId: r.agent_id ? String(r.agent_id) : null,
      companyId: r.company_id ? String(r.company_id) : null,
      priority: r.priority ? String(r.priority) : null,
      model: r.model ? String(r.model) : null,
      requests: Number(r.requests || 0),
      costUsd: Number(Number(r.cost_usd || 0).toFixed(6)),
      avgDurationMs: Math.round(Number(r.avg_duration_ms || 0)),
      lastAt: r.last_at ? String(r.last_at) : null,
    })),
  };
}

export async function computeSemanticCandidateFit(
  router: {
    getUpstreams(): Array<{ healthy?: boolean; modalities?: string[]; models?: string[] }>;
    routeEmbeddings?(
      req: { model?: string; input: string | string[] },
      opts?: { timeoutMs?: number }
    ): Promise<Response>;
  },
  task: PaperclipTaskInput,
  candidates: PaperclipCandidateAgent[],
  forceEmbeddings?: boolean
): Promise<Record<string, number> | undefined> {
  if (typeof router.routeEmbeddings !== 'function' || candidates.length === 0) {
    return undefined;
  }
  const embedUpstreams = router
    .getUpstreams()
    .filter(
      (u) =>
        u.healthy !== false &&
        (u.modalities?.includes('embedding') ||
          u.models?.some((m) => /embed|bge|nomic|minilm/i.test(m)))
    );
  if (!forceEmbeddings && embedUpstreams.length === 0) {
    return undefined;
  }

  const embedModelHint =
    embedUpstreams[0]?.models?.find((m) => /embed|bge|nomic|minilm/i.test(m)) ||
    embedUpstreams[0]?.models?.[0] ||
    'default';

  const taskText = `${task.title || ''}\n${task.description || ''}\n${(task.labels || []).join(' ')}`.trim();
  if (!taskText) return undefined;

  const candidateTexts = candidates.map((c) =>
    [c.name, c.role || '', c.title || '', c.capabilities || '', c.adapterType || ''].join(' ').trim() || c.id
  );
  const candidateCacheKeys = candidateTexts.map((text) =>
    crypto.createHash('sha256').update(`${embedModelHint}::${text}`).digest('hex')
  );

  const cachedVectors: Array<number[] | null> = candidateCacheKeys.map((key) => {
    try {
      return getCachedPaperclipEmbedding(key);
    } catch {
      return null;
    }
  });
  const missIndices: number[] = [];
  const missTexts: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (!cachedVectors[i]) {
      missIndices.push(i);
      missTexts.push(candidateTexts[i]);
    }
  }

  try {
    const res = await router.routeEmbeddings(
      { input: [taskText, ...missTexts] },
      { timeoutMs: 2500 }
    );
    if (!res.ok) return undefined;
    const json: any = await res.json();
    const vectors: number[][] = Array.isArray(json?.data)
      ? json.data.map((d: any) => (Array.isArray(d?.embedding) ? d.embedding : []))
      : [];
    if (vectors.length !== 1 + missIndices.length || vectors[0].length === 0) {
      return undefined;
    }

    for (let k = 0; k < missIndices.length; k++) {
      const origIdx = missIndices[k];
      const vec = vectors[k + 1];
      if (vec && vec.length > 0) {
        cachedVectors[origIdx] = vec;
        try {
          setCachedPaperclipEmbedding(candidateCacheKeys[origIdx], embedModelHint, vec);
        } catch {}
      }
    }

    const taskVec = vectors[0];
    const out: Record<string, number> = {};
    for (let i = 0; i < candidates.length; i++) {
      const vec = cachedVectors[i];
      if (vec && vec.length === taskVec.length) {
        out[candidates[i].id] = cosineSimilarity(taskVec, vec);
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

export async function evaluatePaperclipCandidateAssignments(input: {
  router: {
    getUpstreams(): Array<{ healthy?: boolean; modalities?: string[]; models?: string[] }>;
    routeEmbeddings?(
      req: { model?: string; input: string | string[] },
      opts?: { timeoutMs?: number }
    ): Promise<Response>;
  };
  task: PaperclipTaskInput;
  candidates: PaperclipCandidateAgent[];
  fleet: PaperclipFleetUpstreamSummary[];
  userId?: string;
  companyIds?: string[];
  weights?: Partial<PaperclipAssignmentWeights>;
  topN?: number;
  explore?: boolean;
  exploreSeed?: number;
  useEmbeddings?: boolean;
}): Promise<PaperclipRecommendResult & { semanticFitUsed: boolean }> {
  const classification = classifyPaperclipTask(input.task);
  const priors = getPaperclipOutcomePriors(
    classification.taskClass,
    input.userId,
    input.companyIds
  );
  const burnRates = getPaperclipAgentBurnRates(
    input.candidates.map((c) => c.id),
    7,
    input.companyIds
  );
  const semanticFitByAgent =
    input.useEmbeddings === false
      ? undefined
      : await computeSemanticCandidateFit(
          input.router,
          input.task,
          input.candidates,
          input.useEmbeddings === true
        );

  const result = recommendPaperclipAssignees(
    input.task,
    input.candidates,
    input.fleet,
    input.weights,
    priors,
    {
      semanticFitByAgent,
      burnRatesCentsPerDay: burnRates,
      thompsonSample: Boolean(input.explore),
      thompsonSeed: input.exploreSeed,
    }
  );
  const topN = Math.max(1, Math.min(20, Number(input.topN ?? 5)));
  const sliced = result.recommendations.slice(0, topN);

  const dayUtc = new Date().toISOString().slice(0, 10);
  if (BUDGET_FORECAST_ALERTED.size > 2000) {
    BUDGET_FORECAST_ALERTED.clear();
  }
  for (const rec of sliced) {
    const daysRemaining = rec.budgetForecast?.projectedDaysRemaining;
    if (typeof daysRemaining === 'number' && Number.isFinite(daysRemaining) && daysRemaining < 3) {
      const alertKey = `${input.userId || 'default'}::${rec.agentId}::${dayUtc}`;
      if (!BUDGET_FORECAST_ALERTED.has(alertKey)) {
        BUDGET_FORECAST_ALERTED.add(alertKey);
        void dispatchAlertWebhooks({
          event: 'paperclip.budget_forecast',
          severity: daysRemaining < 1 ? 'critical' : 'warning',
          summary: `Paperclip agent ${rec.name} (${rec.agentId}) projected to exhaust budget in ${daysRemaining}d ($${rec.budgetForecast?.burnRateUsdPerDay}/day).`,
          data: {
            agentId: rec.agentId,
            name: rec.name,
            burnRateUsdPerDay: rec.budgetForecast?.burnRateUsdPerDay ?? null,
            remainingBudgetUsd: rec.budgetForecast?.remainingBudgetUsd ?? null,
            projectedDaysRemaining: daysRemaining,
            companyId: input.companyIds?.[0] ?? null,
          },
          userId: input.userId || 'default',
        }).catch(() => {});
      }
    }
  }

  return {
    ...result,
    recommendations: sliced,
    semanticFitUsed: Boolean(semanticFitByAgent && Object.keys(semanticFitByAgent).length > 0),
  };
}
