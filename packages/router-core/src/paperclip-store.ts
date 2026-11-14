import { getDb } from './db.js';
import type { PaperclipOutcomePrior } from './paperclip-assign.js';

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
  userId?: string
): PaperclipRunUsageSummary {
  const db = getDb();
  const hasUserFilter = Boolean(userId && userId !== 'admin' && userId !== 'default');
  const rows = hasUserFilter
    ? (db
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
           WHERE correlation_id = ? AND user_id = ?
           GROUP BY model, upstream_id`
        )
        .all(runId, userId) as any[])
    : (db
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
           WHERE correlation_id = ?
           GROUP BY model, upstream_id`
        )
        .all(runId) as any[]);

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

export interface PaperclipAssignmentOutcomeInput {
  userId?: string;
  issueId: string;
  agentId: string;
  taskClass: string;
  success: boolean;
  costUsd?: number;
  durationMs?: number;
}

export function recordPaperclipAssignmentOutcome(input: PaperclipAssignmentOutcomeInput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO paperclip_assignment_outcomes (user_id, issue_id, agent_id, task_class, success, cost_usd, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.userId || 'default',
    input.issueId,
    input.agentId,
    input.taskClass,
    input.success ? 1 : 0,
    typeof input.costUsd === 'number' && Number.isFinite(input.costUsd) ? input.costUsd : 0,
    typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
      ? Math.round(input.durationMs)
      : 0
  );
}

export function getPaperclipOutcomePriors(
  taskClass?: string,
  userId?: string
): Record<string, PaperclipOutcomePrior> {
  const db = getDb();
  const hasUser = Boolean(userId && userId !== 'admin' && userId !== 'default');
  let sql = `SELECT agent_id, SUM(success) AS wins, COUNT(*) AS total FROM paperclip_assignment_outcomes WHERE 1=1`;
  const params: any[] = [];
  if (taskClass) {
    sql += ` AND task_class = ?`;
    params.push(taskClass);
  }
  if (hasUser) {
    sql += ` AND user_id = ?`;
    params.push(userId);
  }
  sql += ` GROUP BY agent_id`;

  const rows = db.prepare(sql).all(...params) as Array<{
    agent_id: string;
    wins: number;
    total: number;
  }>;
  const out: Record<string, PaperclipOutcomePrior> = {};
  for (const r of rows) {
    out[String(r.agent_id)] = {
      wins: Number(r.wins || 0),
      total: Number(r.total || 0),
    };
  }
  return out;
}
