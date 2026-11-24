import { createHash } from 'node:crypto';
import { getDb } from '../db.js';
import {
  scanResponseContent,
  scanAndMaskPii,
  type PromptGuardConfig,
  type PrivacyGuardConfig
} from '../guard.js';
import type { ContextProvider, RequestScope } from '../context/types.js';
import type { UpstreamConfig } from '../index.js';
import {
  resolveMulticaConfig,
  resolveMulticaPat,
  createMulticaRunner,
  multicaListRuns,
  multicaRunMessages,
  multicaGetIssue,
  MULTICA_TERMINAL_RUN_STATUSES,
  type MulticaRun,
  type MulticaMessage,
  type MulticaIssue
} from './multica.js';

/**
 * Multica run-transcript → Eluvix memory ingestion (phase d).
 *
 * The dispatch adapter (phase b) returns a run's transcript as the chat
 * completion when the run finishes inside the request deadline — and the
 * router's standard write-back stores that completion text. What phase
 * (d) closes is the other half: runs that are still working at the
 * deadline. Their transcripts never reach memory unless something comes
 * back for them. This module is that something: a standalone poller
 * that re-reads terminal runs for Eluvix-dispatched issues and remembers
 * their messages, one L1 record per message, under the owning user only.
 *
 * Keying (decided, not deferred): the poller keys off its own persisted
 * registry in `multica_ingestion_state` (eluvix.db), NOT off the harness
 * session map. The session map is process-local, only tracks the latest
 * run per session, and per-request mode (the default) never populates
 * it — a restart would lose every pending run. The DB registry survives
 * restarts; the sweep resumes where it left off. Issues and runs
 * created outside Eluvix (directly in the Multica UI) are not tracked:
 * the poller only follows work Eluvix dispatched.
 *
 * Record shape (decided): per-message L1 records, agent/assistant-role
 * messages only. `ContextProvider.remember()` is turn-shaped, so one
 * record per message maps naturally; the builtin provider truncates
 * assistant text to 600 chars, so a whole-transcript blob would be
 * nearly useless there, while per-message records survive. User-role
 * messages (dispatch prompts, steering) are skipped — they are already
 * in memory via the standard chat write-back. Each record carries its
 * provenance in the user side (`Multica MUL-123 · run run-1 · agent X`)
 * and in scope metadata (`issueId`, `companyId`, `agentId` via the
 * builtin provider). Caps: 100 messages per run per sweep, 4000 chars
 * per message.
 *
 * Gating (hard requirement, no exceptions): every message is scanned
 * with the same T5 response gate the router's `assistantTextSafeForMemory`
 * uses (`scanResponseContent` with prompt-guard + privacy-guard). An
 * injection detection BLOCKS the record — fail-closed, never stored.
 * PII detection REDACTS the text (`scanAndMaskPii`) and the redacted
 * form is stored. The split is deliberate: transcript PII is usually
 * incidental (an email in code, a token in a log) and mechanical
 * redaction preserves the signal; an injection is a control-plane threat
 * and no heuristic strip is trusted for storage. One deliberate
 * divergence from the router's own gate: the prompt guard is forced
 * enabled here (`{...config, enabled: true}`) so a config that disables
 * prompt-guard cannot silently disarm ingestion — the router's
 * `assistantTextSafeForMemory` spreads config over `enabled: true` in
 * the other order, which lets a disabled config win; that is a
 * pre-existing gap in the standard path, not repeated here.
 *
 * Dedup: per-run high-water mark `last_seq` (the CLI's `run-messages
 * --since` filter takes the message sequence number) plus a content-hash
 * backstop — SHA-256(role + text) for ingested messages, capped at the
 * last 200 — so a re-fetch that returns already-seen messages writes
 * nothing new even when messages carry no sequence number.
 *
 * Opt-in, default off: ingestion only runs for upstreams whose
 * `harness.multica.ingestTranscripts` is true. Transcripts contain code
 * and secrets; nothing is ingested unless the operator enables it for
 * that upstream. The sweep also respects the router's memory switch
 * (`memory.enabled` + `writeBack !== false`) via `deps.canRemember()`.
 *
 * No transcript → memory ingestion happens anywhere else in this file's
 * callers: the adapter only registers issues and ensures the poller is
 * running. The sweep is the single write path.
 */

/** Default milliseconds between ingestion sweeps. */
export const MULTICA_DEFAULT_INGEST_POLL_INTERVAL_MS = 60000;
/** Ingestion sweeps never run more often than this. */
export const MULTICA_INGEST_POLL_INTERVAL_MIN_MS = 10000;
/** Ingestion sweeps never run less often than this. */
export const MULTICA_INGEST_POLL_INTERVAL_MAX_MS = 600000;
/** CLI timeout for one `multica` invocation during a sweep. */
export const MULTICA_INGEST_CLI_TIMEOUT_MS = 60000;
/** Most messages remembered from one run in a single sweep. */
export const MULTICA_INGEST_MAX_MESSAGES_PER_RUN_PER_SWEEP = 100;
/** Most characters kept per remembered message (truncated, marked). */
export const MULTICA_INGEST_MAX_MESSAGE_CHARS = 4000;
/** Most content hashes retained per run for the dedup backstop. */
export const MULTICA_INGEST_MAX_SEEN_HASHES = 200;

export function clampIngestIntervalMs(ms?: number): number {
  const value = typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms) : MULTICA_DEFAULT_INGEST_POLL_INTERVAL_MS;
  return Math.min(
    MULTICA_INGEST_POLL_INTERVAL_MAX_MS,
    Math.max(MULTICA_INGEST_POLL_INTERVAL_MIN_MS, value)
  );
}

export interface MulticaIngestionDeps {
  /** Current router upstreams; read fresh on every sweep. */
  getUpstreams: () => UpstreamConfig[];
  /** The router's memory provider (undefined when memory is off). */
  getContextProvider: () => ContextProvider | undefined;
  /** Mirrors the router's canRemember: memory enabled + write-back on. */
  canRemember: () => boolean;
  /** Guard config for the T5 scan gate (router's prompt/privacy guard). */
  guardConfig?: {
    promptGuard?: PromptGuardConfig;
    privacyGuard?: PrivacyGuardConfig;
  };
  /** Sweep cadence for a poller started with these deps. */
  intervalMs?: number;
}

export interface MulticaIngestionRegistration {
  userId: string;
  upstreamId: string;
  issueKey: string;
  /** 'per-request' issues stop being polled once their run is done; session issues keep being watched for new runs. */
  sessionMode: string;
}

export interface MulticaIngestionRow extends MulticaIngestionRegistration {
  runId: string;
  lastSeq: number | null;
  seenHashes: string[];
  ingestedCount: number;
  status: string;
}

function rowFromDb(r: Record<string, unknown>): MulticaIngestionRow {
  let seenHashes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(r.seen_hashes ?? '[]'));
    if (Array.isArray(parsed)) seenHashes = parsed.filter((h): h is string => typeof h === 'string');
  } catch {
    seenHashes = [];
  }
  return {
    userId: String(r.user_id ?? ''),
    upstreamId: String(r.upstream_id ?? ''),
    issueKey: String(r.issue_key ?? ''),
    runId: String(r.run_id ?? ''),
    sessionMode: String(r.session_mode ?? 'per-request'),
    lastSeq: typeof r.last_seq === 'number' ? r.last_seq : null,
    seenHashes,
    ingestedCount: typeof r.ingested_count === 'number' ? r.ingested_count : 0,
    status: String(r.status ?? 'watching')
  };
}

/**
 * Register an Eluvix-dispatched issue for ingestion. Called by the
 * dispatch adapter when the upstream has `ingestTranscripts` enabled.
 * Idempotent: re-registering an issue re-opens it for watching (a
 * per-request issue that finished can gain a new run if it is steered
 * later) and updates the session mode.
 */
export function registerMulticaIssueForIngestion(reg: MulticaIngestionRegistration): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO multica_ingestion_state
       (user_id, upstream_id, issue_key, run_id, session_mode, status)
     VALUES (?, ?, ?, '', ?, 'watching')
     ON CONFLICT(user_id, upstream_id, issue_key, run_id) DO UPDATE SET
       session_mode = excluded.session_mode,
       status = 'watching',
       updated_at = CURRENT_TIMESTAMP`
  ).run(reg.userId, reg.upstreamId, reg.issueKey, reg.sessionMode);
}

/** Issue rows still being watched (run_id '' marks the issue-level row). */
export function listMulticaIngestionIssues(): MulticaIngestionRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM multica_ingestion_state
        WHERE run_id = '' AND status = 'watching'
        ORDER BY updated_at ASC`
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowFromDb);
}

export function getMulticaRunRow(
  reg: MulticaIngestionRegistration,
  runId: string
): MulticaIngestionRow | undefined {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM multica_ingestion_state
        WHERE user_id = ? AND upstream_id = ? AND issue_key = ? AND run_id = ?`
    )
    .get(reg.userId, reg.upstreamId, reg.issueKey, runId) as Record<string, unknown> | undefined;
  return row ? rowFromDb(row) : undefined;
}

function getOrCreateMulticaRunRow(
  reg: MulticaIngestionRegistration,
  runId: string
): MulticaIngestionRow {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO multica_ingestion_state
       (user_id, upstream_id, issue_key, run_id, session_mode, status)
     VALUES (?, ?, ?, ?, ?, 'watching')`
  ).run(reg.userId, reg.upstreamId, reg.issueKey, runId, reg.sessionMode);
  const row = getMulticaRunRow(reg, runId);
  if (!row) throw new Error(`multica ingestion: could not create run row for ${reg.issueKey}/${runId}`);
  return row;
}

function updateMulticaRunRow(
  reg: MulticaIngestionRegistration,
  runId: string,
  patch: { lastSeq?: number | null; seenHashes?: string[]; ingestedDelta?: number; status?: string }
): void {
  const db = getDb();
  const current = getMulticaRunRow(reg, runId);
  if (!current) return;
  const lastSeq = patch.lastSeq !== undefined ? patch.lastSeq : current.lastSeq;
  const seenHashes = patch.seenHashes !== undefined ? patch.seenHashes : current.seenHashes;
  const ingestedCount = current.ingestedCount + (patch.ingestedDelta ?? 0);
  const status = patch.status ?? current.status;
  db.prepare(
    `UPDATE multica_ingestion_state
        SET last_seq = ?, seen_hashes = ?, ingested_count = ?, status = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND upstream_id = ? AND issue_key = ? AND run_id = ?`
  ).run(
    lastSeq,
    JSON.stringify(seenHashes.slice(-MULTICA_INGEST_MAX_SEEN_HASHES)),
    ingestedCount,
    status,
    reg.userId,
    reg.upstreamId,
    reg.issueKey,
    runId
  );
}

function markMulticaIssueDone(reg: MulticaIngestionRegistration): void {
  const db = getDb();
  db.prepare(
    `UPDATE multica_ingestion_state SET status = 'done', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND upstream_id = ? AND issue_key = ? AND run_id = ''`
  ).run(reg.userId, reg.upstreamId, reg.issueKey);
}

/** SHA-256 of role + text: the dedup backstop when messages carry no seq. */
export function multicaMessageHash(message: MulticaMessage): string {
  return createHash('sha256')
    .update(`${message.role}\n${message.text}`)
    .digest('hex');
}

export type MulticaGateAction = 'remember' | 'redacted' | 'blocked';

export interface MulticaGateResult {
  action: MulticaGateAction;
  /** Text to store ('' when blocked). */
  text: string;
  /** Guard rules that fired (detection types only, never content). */
  rules: string[];
}

/**
 * The T5 scan gate for one transcript message. Injection → blocked
 * (fail-closed, never stored). PII without injection → redacted and the
 * redacted form is stored. Clean → stored verbatim. The prompt guard is
 * forced enabled regardless of config: a disabled prompt-guard must not
 * silently disarm ingestion.
 */
export function gateMulticaTranscriptText(
  text: string,
  guardConfig?: MulticaIngestionDeps['guardConfig']
): MulticaGateResult {
  const scan = scanResponseContent(text, {
    promptGuard: { ...(guardConfig?.promptGuard || {}), enabled: true },
    privacyGuard: guardConfig?.privacyGuard
  });
  if (!scan.injection.passed) {
    return { action: 'blocked', text: '', rules: scan.rules };
  }
  if (scan.piiTypes.length > 0) {
    const { redacted } = scanAndMaskPii(text, guardConfig?.privacyGuard);
    if (!redacted.trim()) {
      return { action: 'blocked', text: '', rules: scan.rules };
    }
    return { action: 'redacted', text: redacted, rules: scan.rules };
  }
  return { action: 'remember', text, rules: [] };
}

/** Provenance line carried on the user side of every ingested record. */
export function multicaIngestionProvenance(
  issue: { key: string; title?: string },
  run: MulticaRun
): string {
  const agent = run.agent && run.agent.trim() ? run.agent.trim() : 'unassigned';
  const title = issue.title && issue.title.trim() ? ` · issue "${issue.title.trim().slice(0, 120)}"` : '';
  return `Multica ${issue.key} · run ${run.id} · agent ${agent}${title}`;
}

/**
 * Scope for an ingested record. Mirrors the router's own memory-scope
 * rule: when a Multica workspace id is known it suffixes the user id
 * (`user::pc:<workspace>`) exactly like the paperclip company suffix,
 * so ingested records land in the same partition as the dispatch's own
 * write-back. The session is the issue key, so records group per issue.
 */
export function multicaIngestionScope(
  reg: MulticaIngestionRegistration,
  workspaceId: string | undefined,
  agentName: string | undefined
): RequestScope {
  const company = (workspaceId || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  return {
    userId: company ? `${reg.userId}::pc:${company}` : reg.userId,
    sessionId: reg.issueKey,
    agentId: agentName,
    companyId: workspaceId || undefined,
    issueId: reg.issueKey,
    origin: 'harness'
  };
}

export interface MulticaIngestCounts {
  remembered: number;
  redacted: number;
  blocked: number;
  skipped: number;
  /** True when the per-sweep message cap stopped the pass early. */
  capped: boolean;
}

/**
 * Gate + remember one run's newly fetched messages. Only
 * agent/assistant text messages are remembered: user-role messages
 * (dispatch prompts, steering) are already in memory via the standard
 * chat write-back, and tool-use/error rows carry no agent prose. The
 * high-water mark advances only past messages fully resolved in this
 * pass, so a capped pass re-fetches the remainder next sweep.
 */
export async function ingestMulticaRunMessages(
  deps: MulticaIngestionDeps,
  reg: MulticaIngestionRegistration,
  issue: { key: string; title?: string },
  run: MulticaRun,
  messages: MulticaMessage[],
  opts?: { workspaceId?: string }
): Promise<MulticaIngestCounts> {
  const counts: MulticaIngestCounts = { remembered: 0, redacted: 0, blocked: 0, skipped: 0, capped: false };
  const provider = deps.getContextProvider();
  if (!provider || !deps.canRemember()) {
    counts.skipped = messages.length;
    return counts;
  }
  const row = getOrCreateMulticaRunRow(reg, run.id);
  const seen = new Set<string>(row.seenHashes);
  let lastSeq = row.lastSeq;
  let ingestedDelta = 0;
  const scope = multicaIngestionScope(reg, opts?.workspaceId, run.agent);
  const provenance = multicaIngestionProvenance(issue, run);

  // Sequence order when present, so the high-water mark only moves
  // forward and a capped pass resumes cleanly next sweep.
  const ordered = [...messages].sort((a, b) => {
    const sa = typeof a.seq === 'number' ? a.seq : Number.POSITIVE_INFINITY;
    const sb = typeof b.seq === 'number' ? b.seq : Number.POSITIVE_INFINITY;
    return sa - sb;
  });

  for (const message of ordered) {
    if (counts.remembered + counts.redacted >= MULTICA_INGEST_MAX_MESSAGES_PER_RUN_PER_SWEEP) {
      counts.capped = true;
      break;
    }
    const text = (message.text || '').trim();
    if (!text) {
      counts.skipped++;
      if (typeof message.seq === 'number' && (lastSeq === null || message.seq > lastSeq)) {
        lastSeq = message.seq;
      }
      continue;
    }
    // Real API rows carry a `type` (text/thinking/tool-use/tool-result/
    // status/error); only text rows hold agent prose. Rows without a
    // type (older shapes, stubs) fall through to the role filter.
    const rawType = typeof message.type === 'string' ? message.type.toLowerCase() : undefined;
    if (rawType !== undefined && rawType !== 'text') {
      counts.skipped++;
      if (typeof message.seq === 'number' && (lastSeq === null || message.seq > lastSeq)) {
        lastSeq = message.seq;
      }
      continue;
    }
    if (message.role.toLowerCase() === 'user') {
      counts.skipped++;
      if (typeof message.seq === 'number' && (lastSeq === null || message.seq > lastSeq)) {
        lastSeq = message.seq;
      }
      continue;
    }
    const hash = multicaMessageHash(message);
    if (seen.has(hash)) {
      counts.skipped++;
      if (typeof message.seq === 'number' && (lastSeq === null || message.seq > lastSeq)) {
        lastSeq = message.seq;
      }
      continue;
    }
    // Gate the full text, then truncate the gated form for storage.
    const gated = gateMulticaTranscriptText(text, deps.guardConfig);
    if (gated.action === 'blocked') {
      counts.blocked++;
      seen.add(hash);
      if (typeof message.seq === 'number' && (lastSeq === null || message.seq > lastSeq)) {
        lastSeq = message.seq;
      }
      continue;
    }
    let stored = gated.text;
    if (stored.length > MULTICA_INGEST_MAX_MESSAGE_CHARS) {
      stored = `${stored.slice(0, MULTICA_INGEST_MAX_MESSAGE_CHARS)}… [truncated]`;
    }
    try {
      await provider.remember(
        { user: { role: 'user', content: provenance }, assistant: stored },
        scope
      );
    } catch {
      // A failed write is not ingested: leave the mark unmoved so the
      // next sweep retries it instead of silently dropping the message.
      counts.skipped++;
      continue;
    }
    if (gated.action === 'redacted') counts.redacted++;
    else counts.remembered++;
    ingestedDelta++;
    seen.add(hash);
    if (typeof message.seq === 'number' && (lastSeq === null || message.seq > lastSeq)) {
      lastSeq = message.seq;
    }
  }

  updateMulticaRunRow(reg, run.id, {
    lastSeq,
    seenHashes: [...seen],
    ingestedDelta
  });
  return counts;
}

export interface MulticaIngestionSweepResult {
  issuesChecked: number;
  runsChecked: number;
  runsIngested: number;
  messagesRemembered: number;
  messagesRedacted: number;
  messagesBlocked: number;
  messagesSkipped: number;
  errors: string[];
}

/**
 * One ingestion pass: for every watched issue, list its runs and pull
 * new transcript messages for terminal runs only. A still-running run
 * is never ingested — its transcript is incomplete and it may still be
 * steered. Failed/cancelled runs ARE ingested: what went wrong is
 * signal for future runs. A run row is marked done only after a
 * successful fetch + ingest pass that did not hit the message cap.
 */
export async function sweepMulticaIngestion(
  deps: MulticaIngestionDeps,
  signal?: AbortSignal
): Promise<MulticaIngestionSweepResult> {
  const result: MulticaIngestionSweepResult = {
    issuesChecked: 0,
    runsChecked: 0,
    runsIngested: 0,
    messagesRemembered: 0,
    messagesRedacted: 0,
    messagesBlocked: 0,
    messagesSkipped: 0,
    errors: []
  };
  if (!deps.canRemember() || !deps.getContextProvider()) return result;
  const issues = listMulticaIngestionIssues();
  if (issues.length === 0) return result;

  const byUpstream = new Map<string, MulticaIngestionRow[]>();
  for (const issue of issues) {
    const list = byUpstream.get(issue.upstreamId) || [];
    list.push(issue);
    byUpstream.set(issue.upstreamId, list);
  }

  for (const [upstreamId, rows] of byUpstream) {
    const upstream = deps.getUpstreams().find(u => u.id === upstreamId);
    if (!upstream) {
      result.errors.push(`multica ingestion: upstream ${upstreamId} no longer configured; skipping ${rows.length} watched issue(s)`);
      continue;
    }
    const mc = upstream.harness?.multica;
    if (upstream.harness?.kind !== 'multica' || !mc?.ingestTranscripts) {
      continue;
    }
    let runner;
    let cfg;
    try {
      cfg = resolveMulticaConfig(upstream);
      const pat = await resolveMulticaPat(upstream);
      runner = await createMulticaRunner(upstream, cfg, pat, 0);
    } catch (err) {
      result.errors.push(
        `multica ingestion: cannot build runner for upstream ${upstreamId}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    for (const reg of rows) {
      // Defense in depth on H-9: a row without an owning user is never
      // ingested under a shared or guessed identity.
      if (!reg.userId || !reg.userId.trim()) {
        result.errors.push(`multica ingestion: skipping row for ${reg.issueKey} with no owning user`);
        continue;
      }
      result.issuesChecked++;
      let runs: MulticaRun[];
      try {
        runs = await multicaListRuns(runner, reg.issueKey, MULTICA_INGEST_CLI_TIMEOUT_MS, signal);
      } catch (err) {
        result.errors.push(
          `multica ingestion: issue runs failed for ${reg.issueKey}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      let issue: MulticaIssue | undefined;
      try {
        issue = await multicaGetIssue(runner, reg.issueKey, MULTICA_INGEST_CLI_TIMEOUT_MS, signal);
      } catch {
        issue = undefined;
      }
      const terminal = runs.filter(r => MULTICA_TERMINAL_RUN_STATUSES.includes(r.status));
      let allTerminalDone = terminal.length > 0;
      for (const run of terminal) {
        result.runsChecked++;
        const row = getOrCreateMulticaRunRow(reg, run.id);
        if (row.status === 'done') continue;
        let messages: MulticaMessage[];
        try {
          messages = await multicaRunMessages(
            runner,
            reg.issueKey,
            run.id,
            MULTICA_INGEST_CLI_TIMEOUT_MS,
            signal,
            row.lastSeq ?? undefined
          );
        } catch (err) {
          result.errors.push(
            `multica ingestion: run-messages failed for ${reg.issueKey}/${run.id}: ${err instanceof Error ? err.message : String(err)}`
          );
          allTerminalDone = false;
          continue;
        }
        const counts = await ingestMulticaRunMessages(
          deps,
          reg,
          { key: reg.issueKey, title: issue?.title },
          run,
          messages,
          { workspaceId: cfg.workspaceId }
        );
        result.messagesRemembered += counts.remembered;
        result.messagesRedacted += counts.redacted;
        result.messagesBlocked += counts.blocked;
        result.messagesSkipped += counts.skipped;
        if (counts.remembered + counts.redacted > 0 || messages.length === 0) {
          result.runsIngested++;
        }
        if (!counts.capped) {
          updateMulticaRunRow(reg, run.id, { status: 'done' });
        } else {
          allTerminalDone = false;
        }
      }
      // Per-request issues have exactly one run ever: once it is done,
      // stop polling the issue. Session issues keep being watched —
      // a steer or re-assign can start a new run at any time.
      if (reg.sessionMode === 'per-request' && allTerminalDone) {
        markMulticaIssueDone(reg);
      }
    }
  }
  return result;
}

let ingestionTimer: NodeJS.Timeout | null = null;
let ingestionTimerDeps: MulticaIngestionDeps | null = null;

/** True while the ingestion poller timer is armed in this process. */
export function isMulticaIngestionPollerRunning(): boolean {
  return ingestionTimer !== null;
}

/**
 * Start the ingestion poller (process singleton). The timer is unref'd
 * so it never keeps the process alive, and each sweep re-reads the
 * current upstreams + provider through the deps callbacks, so config
 * changes are picked up without a restart. Returns false when a poller
 * is already running (the first starter's interval wins; later
 * upstreams share it).
 */
export function startMulticaIngestionPoller(deps: MulticaIngestionDeps): boolean {
  if (ingestionTimer) return false;
  ingestionTimerDeps = deps;
  const ms = clampIngestIntervalMs(deps.intervalMs);
  ingestionTimer = setInterval(() => {
    if (!ingestionTimerDeps) return;
    void sweepMulticaIngestion(ingestionTimerDeps).catch(() => {});
  }, ms);
  ingestionTimer.unref?.();
  return true;
}

/** Stop the ingestion poller. Tests call this in afterEach. */
export function stopMulticaIngestionPoller(): void {
  if (ingestionTimer) {
    clearInterval(ingestionTimer);
    ingestionTimer = null;
  }
  ingestionTimerDeps = null;
}

/**
 * Ensure the poller is running, starting it on first use. Called by the
 * dispatch adapter when it sees the first ingestion-enabled dispatch;
 * the router wires the deps through the harness dispatch chain, so no
 * server or router lifecycle change is needed.
 */
export function ensureMulticaIngestionStarted(
  deps: MulticaIngestionDeps,
  intervalMs?: number
): boolean {
  if (ingestionTimer) return false;
  return startMulticaIngestionPoller({ ...deps, intervalMs });
}
