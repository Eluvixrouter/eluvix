import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { RequestScope } from '../context/types.js';
import type { ChatRequest, UpstreamConfig } from '../index.js';
import { resolveCliExecutable, MULTICA_CLI_BINARIES } from '../cli-exec.js';
import { buildHarnessPrompt, messageText } from './prompt.js';
import { buildChildEnv } from './env.js';
import { resolveUpstreamSecret } from '../secrets.js';
import { validateUpstreamHttpEndpoint } from '../ssrf-guard.js';
import { setBounded, DEFAULT_MAX_CACHE_ENTRIES } from '../bounded-map.js';
import {
  registerMulticaIssueForIngestion,
  ensureMulticaIngestionStarted,
  clampIngestIntervalMs,
  type MulticaIngestionDeps
} from './multica-ingestion.js';
import type { MulticaHarnessConfig } from './types.js';

/**
 * Multica harness adapter (`HarnessKind 'multica'`).
 *
 * Eluvix dispatches real coding work into a separately deployed Multica
 * workspace by spawning the operator-installed `multica` CLI (JSON out)
 * and polling run state back. Multica drives agent CLIs on operator
 * machines; Eluvix never bundles, vendors, or embeds it (Multica License
 * Part I 1a — network integration only, with the 1c "built on Multica"
 * attribution in the docs).
 *
 * Flow per turn:
 *   1. create issue (prompt as description, `--pr-auto-complete off` —
 *      review-gated, no auto-merge) → `MUL-123`
 *   2. assign the configured agent (assigning is what starts a run)
 *   3. poll `issue runs` until the latest run is terminal or the
 *      request deadline hits
 *   4. fetch `issue run-messages` and return the transcript as the
 *      chat completion text
 *
 * Session modes: `per-request` (default for multica) creates a fresh
 * issue per turn. `per-eluvix-session` / `per-conversation` reuses the
 * issue created for the session: a follow-up steers the active run
 * (`issue comment add --steer`) or re-assigns the agent when no run is
 * active. `RequestScope.issueId` (paperclip mapping) dispatches into an
 * existing `MUL-123` issue when present; `RequestScope.companyId` maps to
 * the Multica workspace id.
 *
 * Auth: the calling user's own Multica PAT (`mul_…`) from
 * `UpstreamConfig.apiKey` (literal or SecretRef, resolved per call).
 * Run-scoped `mat_…` task tokens are refused — they belong to a single
 * run and must never dispatch new work as the user. The PAT is injected
 * into the direct child's environment only (see the MULTICA_TOKEN
 * denylist entry in env.ts): it never lives in `process.env`, and the
 * `multica` CLI's issue commands spawn no subprocesses (verified in
 * multica-ai/multica source — the only `os/exec` hits under
 * `server/cmd/multica/cmd_issue*.go` are test files), so no grandchild
 * of an Eluvix dispatch can inherit it through the CLI.
 *
 * The CLI is the stable surface here on purpose: Multica's public API v1
 * is still a narrow slice (issue read/PATCH, comments, task messages) and
 * does not cover issue creation or run management yet. A REST transport
 * can replace the spawn path later without changing the dispatch shape.
 *
 * No transcript → memory ingestion happens in this adapter (phase (d),
 * T5-scan-gated, is a separate step).
 */

/** Grace period between SIGTERM and SIGKILL when cleaning up a CLI child. */
const MULTICA_KILL_GRACE_MS = 2000;
/** Only the tail of the child's stderr is retained for diagnostics. */
const MULTICA_STDERR_TAIL_BYTES = 8192;
/** Cap on a single CLI invocation's stdout (run transcripts can be long). */
const MULTICA_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
/** Default Multica self-host backend URL (SELF_HOSTING.md). */
export const MULTICA_DEFAULT_SERVER_URL = 'http://localhost:8080';
/** Default milliseconds between `issue runs` polls. */
export const MULTICA_DEFAULT_POLL_INTERVAL_MS = 5000;

/** Run states that mean "still working" (tasks.mdx). */
export const MULTICA_ACTIVE_RUN_STATUSES: readonly string[] = [
  'deferred',
  'queued',
  'dispatched',
  'waiting_local_directory',
  'running'
];
/** Run states that mean "done, read the transcript". */
export const MULTICA_TERMINAL_RUN_STATUSES: readonly string[] = [
  'completed',
  'failed',
  'cancelled'
];

export interface MulticaResolvedConfig {
  serverUrl: string;
  workspaceId?: string;
  profile?: string;
  project?: string;
  pollIntervalMs: number;
  command: string | string[];
  args: string[];
  cwd: string;
  /** Multica agent name to assign (HarnessConfig.agentId). 'default' means unassigned. */
  agentName?: string;
  approvals: string;
  sessionMode: string;
  multica: MulticaHarnessConfig;
}

export interface MulticaIssue {
  key: string;
  id?: string;
  title?: string;
  status?: string;
  raw: unknown;
}

export interface MulticaRun {
  id: string;
  status: string;
  agent?: string;
  raw: unknown;
}

export interface MulticaMessage {
  role: string;
  text: string;
  /** Message sequence number from the run transcript (drives `--since` dedup in phase d). */
  seq?: number;
  /** API message type (text/thinking/tool-use/tool-result/status/error); only 'text' rows hold agent prose. */
  type?: string;
  raw: unknown;
}

export interface MulticaCliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface MulticaCliRunner {
  run(args: string[], stdin?: string, timeoutMs?: number, signal?: AbortSignal): Promise<MulticaCliResult>;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const rec = asRecord(value);
  if (rec) {
    for (const key of ['runs', 'tasks', 'messages', 'items', 'results', 'data']) {
      if (Array.isArray(rec[key])) return rec[key] as unknown[];
    }
    return [value];
  }
  return value === undefined || value === null ? [] : [value];
}

function strField(rec: Record<string, any> | null, names: string[]): string | undefined {
  if (!rec) return undefined;
  for (const name of names) {
    const v = rec[name];
    if (typeof v === 'string' && v.trim().length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/**
 * Parse CLI `--output json` stdout tolerantly. The Multica CLI's JSON
 * shapes are not version-pinned here (no published JSON schema exists for
 * the issue commands), so callers extract the fields they need with
 * fallbacks instead of asserting an exact shape.
 */
export function parseMulticaJson(stdout: string, cmd: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`multica ${cmd} returned empty output`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(
      `multica ${cmd} returned unparseable output: ${trimmed.slice(0, 500)}`
    );
  }
}

function pickIssueKey(value: unknown): string | undefined {
  const rec = asRecord(value);
  return strField(rec, ['identifier', 'key', 'issueKey', 'issue_key', 'id']);
}

function normalizeRun(value: unknown): MulticaRun | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const id = strField(rec, ['id', 'taskId', 'task_id', 'runId', 'run_id']);
  if (!id) return null;
  return {
    id,
    status: (strField(rec, ['status', 'state']) || 'unknown').toLowerCase(),
    agent: strField(rec, ['agent', 'agentName', 'agent_name', 'assignee']),
    raw: value
  };
}

function normalizeMessage(value: unknown): MulticaMessage | null {
  if (typeof value === 'string' && value.trim()) {
    return { role: 'agent', text: value, raw: value };
  }
  const rec = asRecord(value);
  if (!rec) return null;
  const text = strField(rec, ['content', 'text', 'body', 'message']);
  if (!text) return null;
  const seqRaw = rec.seq;
  const typeRaw = rec.type;
  return {
    role: (strField(rec, ['role', 'author', 'actor', 'sender']) || 'agent').toLowerCase(),
    text,
    ...(typeof seqRaw === 'number' && Number.isFinite(seqRaw) ? { seq: Math.floor(seqRaw) } : {}),
    ...(typeof typeRaw === 'string' && typeRaw.trim() ? { type: typeRaw.trim().toLowerCase() } : {}),
    raw: value
  };
}

export function multicaTranscriptText(messages: MulticaMessage[]): string {
  return messages
    .map(m => {
      const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Agent';
      return `${label}: ${m.text}`;
    })
    .join('\n\n');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Client aborted request', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Client aborted request', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Resolve the Multica connection + dispatch config for an upstream.
 * The server URL is validated with the SSRF guard (loopback/LAN
 * carve-out) BEFORE it is handed to the CLI: a malicious config value
 * would otherwise make the CLI — holding the user's PAT — call an
 * arbitrary internal address (e.g. cloud metadata).
 */
export function resolveMulticaConfig(
  upstream: UpstreamConfig,
  scope?: RequestScope
): MulticaResolvedConfig {
  const harnessCfg = upstream.harness || { kind: 'multica' as const };
  const mc: MulticaHarnessConfig = (harnessCfg as { multica?: MulticaHarnessConfig }).multica || {};
  const serverUrl = (mc.serverUrl || upstream.endpoint || MULTICA_DEFAULT_SERVER_URL).trim();
  const check = validateUpstreamHttpEndpoint(serverUrl, { allowLoopbackAndLan: true });
  if (!check.ok) {
    throw new Error(
      `Multica server URL rejected by the SSRF guard: ${check.reason || 'invalid endpoint'}`
    );
  }
  const pollIntervalMs = Math.min(
    30000,
    Math.max(1000, mc.pollIntervalMs ?? MULTICA_DEFAULT_POLL_INTERVAL_MS)
  );
  return {
    serverUrl,
    workspaceId: mc.workspaceId || scope?.companyId || undefined,
    profile: mc.profile,
    project: mc.project,
    pollIntervalMs,
    command: harnessCfg.command || 'multica',
    args: Array.isArray(harnessCfg.args) ? harnessCfg.args : [],
    cwd: harnessCfg.cwd || process.cwd(),
    agentName:
      harnessCfg.agentId && harnessCfg.agentId !== 'default' ? harnessCfg.agentId : undefined,
    approvals: harnessCfg.approvals || harnessCfg.approvalPolicy || 'surface',
    sessionMode: harnessCfg.sessionMode || 'per-request',
    multica: mc
  };
}

/**
 * Resolve the calling user's Multica PAT from `upstream.apiKey` (literal
 * or SecretRef). Per-user only: there is no shared-service PAT. A
 * run-scoped `mat_…` task token is refused outright — it belongs to one
 * run and must never dispatch new work as the user.
 */
export async function resolveMulticaPat(upstream: UpstreamConfig): Promise<string> {
  const resolved = await resolveUpstreamSecret(upstream.apiKey);
  const pat = (resolved || '').trim();
  if (!pat) {
    throw new Error(
      'Multica harness requires a per-user PAT (mul_…) in the upstream apiKey ' +
        '(literal or SecretRef); anonymous dispatch is refused'
    );
  }
  if (pat.startsWith('mat_')) {
    throw new Error(
      'Multica harness refuses run-scoped mat_ task tokens: dispatch requires ' +
        'the calling user\'s own PAT (mul_…), never a token minted for one run'
    );
  }
  if (!pat.startsWith('mul_')) {
    throw new Error(
      'Multica harness expects a personal access token (mul_…); ' +
        'the configured credential does not look like one'
    );
  }
  return pat;
}

/**
 * Build the runner for one dispatch: resolves the `multica` binary
 * through the spawn gate and binds the PAT into the direct child's env.
 *
 * The PAT is assigned onto the env object AFTER buildChildEnv returns:
 * MULTICA_TOKEN is on the child-env denylist, so every other spawn site
 * strips it — this is the single intended injection point. The token
 * never lives in process.env.
 */
export async function createMulticaRunner(
  upstream: UpstreamConfig,
  cfg: MulticaResolvedConfig,
  pat: string,
  hops: number
): Promise<MulticaCliRunner> {
  let cmdArray: string[];
  if (Array.isArray(cfg.command) && cfg.command.length > 0) {
    cmdArray = [...cfg.command, ...cfg.args];
  } else if (typeof cfg.command === 'string' && cfg.command.trim().length > 0) {
    cmdArray = [cfg.command.trim(), ...cfg.args];
  } else {
    cmdArray = ['multica'];
  }
  const rawBin = cmdArray[0].trim();
  const allowTestAgents = process.env.ELUVIX_ALLOW_TEST_AGENTS === '1';
  let resolvedBin: string;
  try {
    resolvedBin = resolveCliExecutable(rawBin, {
      allowedBasenames: allowTestAgents
        ? [...MULTICA_CLI_BINARIES, 'node']
        : MULTICA_CLI_BINARIES
    });
  } catch (err) {
    throw new Error(
      `Multica CLI not available (${err instanceof Error ? err.message : String(err)}). ` +
        'Install the operator-owned `multica` binary (multica.ai / the self-host ' +
        'installer) on this machine — Eluvix never ships it.'
    );
  }
  const baseArgs = cmdArray.slice(1);
  const baseBin = path.basename(resolvedBin);
  const childEnv = buildChildEnv({
    ELUVIX_ORIGIN: 'harness',
    ELUVIX_HOPS: String(hops + 1)
  });
  // Single intended injection point for the PAT (see MULTICA_TOKEN
  // denylist entry in env.ts). buildChildEnv already stripped it; the
  // assignment below is deliberate and scoped to this one child.
  childEnv.MULTICA_TOKEN = pat;

  const globalFlags: string[] = [];
  if (cfg.serverUrl) globalFlags.push('--server-url', cfg.serverUrl);
  if (cfg.workspaceId) globalFlags.push('--workspace-id', cfg.workspaceId);
  if (cfg.profile) globalFlags.push('--profile', cfg.profile);

  const run: MulticaCliRunner['run'] = (args, stdin, timeoutMs = 60000, signal) => {
    return new Promise<MulticaCliResult>((resolve, reject) => {
      const child = spawn(resolvedBin, [...baseArgs, ...globalFlags, ...args], {
        cwd: cfg.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv
      });
      let stdout = '';
      let stdoutExceeded = false;
      let stderrTail = '';
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        try {
          if (!child.killed) {
            child.kill('SIGTERM');
            killTimer = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {}
            }, MULTICA_KILL_GRACE_MS);
            killTimer.unref?.();
          }
        } catch {}
      };
      const finishOk = (result: MulticaCliResult) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        resolve(result);
      };
      const finishErr = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const timer = setTimeout(() => {
        finishErr(
          new DOMException(
            `multica ${args[0] || ''} ${args[1] || ''} timed out after ${timeoutMs}ms`,
            'TimeoutError'
          )
        );
      }, timeoutMs);

      if (signal) {
        if (signal.aborted) {
          finishErr(new DOMException('Client aborted request', 'AbortError'));
          return;
        }
        signal.addEventListener(
          'abort',
          () => finishErr(new DOMException('Client aborted request', 'AbortError')),
          { once: true }
        );
      }

      if (stdin !== undefined) {
        try {
          child.stdin.write(stdin);
        } catch {}
        try {
          child.stdin.end();
        } catch {}
      } else {
        try {
          child.stdin.end();
        } catch {}
      }
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutExceeded) return;
        stdout += chunk.toString('utf8');
        if (stdout.length > MULTICA_STDOUT_MAX_BYTES) {
          stdoutExceeded = true;
          finishErr(
            new Error(`multica ${args[0] || ''} output exceeded ${MULTICA_STDOUT_MAX_BYTES} bytes`)
          );
        }
      });
      child.stdout.on('error', () => {});
      // stderr is piped, so it MUST be drained: a child that logs more
      // than the OS pipe buffer (~64KB) blocks mid-command and the call
      // times out. Consume it, retaining only a bounded rolling tail.
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-MULTICA_STDERR_TAIL_BYTES);
      });
      child.stderr.on('error', () => {});
      child.on('error', err => finishErr(err));
      child.on('close', code => {
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        if (settled) return;
        if (code === 0) {
          finishOk({ stdout, stderr: stderrTail, code });
        } else {
          const tail = stderrTail.trim();
          finishErr(
            new Error(
              `multica ${args.join(' ')} failed (exit ${code})` +
                (tail ? `: ${tail.slice(-500)}` : '') +
                (stdout.trim() ? ` | stdout: ${stdout.trim().slice(0, 500)}` : '')
            )
          );
        }
      });
    });
  };

  return { run };
}

/** Run one CLI command and parse its `--output json` stdout. */
async function runJson(
  runner: MulticaCliRunner,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  cmdLabel: string
): Promise<unknown> {
  const res = await runner.run([...args, '--output', 'json'], stdin, timeoutMs, signal);
  return parseMulticaJson(res.stdout, cmdLabel);
}

/** Create an issue. Review-gated by default: `--pr-auto-complete off`. */
export async function multicaCreateIssue(
  runner: MulticaCliRunner,
  input: { title: string; description: string; project?: string },
  timeoutMs: number,
  signal?: AbortSignal
): Promise<MulticaIssue> {
  const args = ['issue', 'create', '--title', input.title, '--description-stdin', '--pr-auto-complete', 'off'];
  if (input.project) args.push('--project', input.project);
  const out = await runJson(runner, args, input.description, timeoutMs, signal, 'issue create');
  const key = pickIssueKey(out);
  if (!key) {
    throw new Error(
      `multica issue create returned no issue key: ${JSON.stringify(out).slice(0, 500)}`
    );
  }
  const rec = asRecord(out);
  return {
    key,
    id: strField(rec, ['id']),
    title: strField(rec, ['title']),
    status: strField(rec, ['status', 'state']),
    raw: out
  };
}

/** Assign an agent by name — assigning is what starts a run. */
export async function multicaAssignIssue(
  runner: MulticaCliRunner,
  issueKey: string,
  agentName: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  return runJson(
    runner,
    ['issue', 'assign', issueKey, '--to', agentName],
    undefined,
    timeoutMs,
    signal,
    'issue assign'
  );
}

/** Read a single issue (status, assignee, …). */
export async function multicaGetIssue(
  runner: MulticaCliRunner,
  issueKey: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<MulticaIssue> {
  const out = await runJson(
    runner,
    ['issue', 'get', issueKey],
    undefined,
    timeoutMs,
    signal,
    'issue get'
  );
  const key = pickIssueKey(out) || issueKey;
  const rec = asRecord(out);
  return {
    key,
    id: strField(rec, ['id']),
    title: strField(rec, ['title']),
    status: strField(rec, ['status', 'state']),
    raw: out
  };
}

/** List runs (tasks) for an issue, newest first per the CLI contract. */
export async function multicaListRuns(
  runner: MulticaCliRunner,
  issueKey: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<MulticaRun[]> {
  const out = await runJson(
    runner,
    ['issue', 'runs', issueKey],
    undefined,
    timeoutMs,
    signal,
    'issue runs'
  );
  return asArray(out)
    .map(normalizeRun)
    .filter((r): r is MulticaRun => r !== null);
}

/** Fetch one run's transcript messages. `since` is a message sequence number: only messages after it are returned. */
export async function multicaRunMessages(
  runner: MulticaCliRunner,
  issueKey: string,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal,
  since?: number
): Promise<MulticaMessage[]> {
  const args = ['issue', 'run-messages', runId, '--issue', issueKey];
  if (typeof since === 'number' && Number.isFinite(since) && since > 0) {
    args.push('--since', String(Math.floor(since)));
  }
  const out = await runJson(
    runner,
    args,
    undefined,
    timeoutMs,
    signal,
    'issue run-messages'
  );
  return asArray(out)
    .map(normalizeMessage)
    .filter((m): m is MulticaMessage => m !== null);
}

/**
 * Steer a running agent: post a comment that lands in the current run
 * instead of queueing a follow-up. Idempotency-keyed so a retry after a
 * lost connection does not post the same steering twice.
 */
export async function multicaSteerRun(
  runner: MulticaCliRunner,
  issueKey: string,
  runId: string,
  text: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  const idempotencyKey = `eluvix-steer-${randomUUID()}`;
  return runJson(
    runner,
    [
      'issue',
      'comment',
      'add',
      issueKey,
      '--content-stdin',
      '--steer',
      runId,
      '--idempotency-key',
      idempotencyKey
    ],
    text,
    timeoutMs,
    signal,
    'issue comment add --steer'
  );
}

/** Post a plain comment on an issue (no steering). */
export async function multicaAddComment(
  runner: MulticaCliRunner,
  issueKey: string,
  text: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  return runJson(
    runner,
    ['issue', 'comment', 'add', issueKey, '--content-stdin'],
    text,
    timeoutMs,
    signal,
    'issue comment add'
  );
}

/** Cancel a running or queued run. */
export async function multicaCancelRun(
  runner: MulticaCliRunner,
  issueKey: string,
  runId: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  return runJson(
    runner,
    ['issue', 'cancel-task', runId, '--issue', issueKey],
    undefined,
    timeoutMs,
    signal,
    'issue cancel-task'
  );
}

/** Repeat a run with its original agent and trigger context. */
export async function multicaRerunRun(
  runner: MulticaCliRunner,
  issueKey: string,
  runId: string,
  fresh: boolean,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  const args = ['issue', 'rerun-task', runId, '--issue', issueKey];
  if (fresh) args.push('--fresh');
  return runJson(runner, args, undefined, timeoutMs, signal, 'issue rerun-task');
}

interface MulticaSessionState {
  issueKey: string;
  lastRunId?: string;
  lastRunStatus?: string;
}

/** Per-(upstream, user, session) issue reuse. Bounded so sessions cannot grow without bound. */
const multicaSessions = new Map<string, MulticaSessionState>();

function sessionKey(upstream: UpstreamConfig, scope?: RequestScope): string {
  return `${upstream.id}:${scope?.userId || 'default'}:${scope?.sessionId || 'default'}`;
}

function sanitizeTitle(text: string): string {
  const firstLine = text
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0) || '';
  const single = firstLine.replace(/\s+/g, ' ').trim();
  if (!single) return 'Eluvix dispatch';
  return single.length > 80 ? `${single.slice(0, 77)}...` : single;
}

function reviewNote(issueKey: string, runId?: string): string {
  return (
    `\n\n---\nMultica review gate: PR auto-complete is off — a human approves ` +
    `the result in Multica before anything merges. Issue ${issueKey}` +
    (runId ? `, run ${runId}` : '') +
    `. Runs execute on the operator's daemon machines, not in the cluster.`
  );
}

export async function forwardMulticaHarness(
  upstream: UpstreamConfig,
  request: ChatRequest,
  timeoutMs = 60000,
  clientSignal?: AbortSignal,
  scope?: RequestScope,
  hops = 0,
  ingestionDeps?: MulticaIngestionDeps
): Promise<Response> {
  // The Multica dispatch channel carries text only: forwarding a
  // tool-bearing request would silently drop the tools. Fail the attempt
  // instead so router failover can pick an upstream that supports them.
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    throw new Error(
      'Multica harness does not support client tool calling; refusing to silently drop request tools'
    );
  }

  const cfg = resolveMulticaConfig(upstream, scope);
  if (cfg.approvals === 'never') {
    throw new Error('Multica dispatch refused by approval policy "never"');
  }
  const pat = await resolveMulticaPat(upstream);
  const runner = await createMulticaRunner(upstream, cfg, pat, hops);

  const promptText = buildHarnessPrompt(request.messages || [], { includeHistory: true });
  const lastUser = [...(request.messages || [])].reverse().find(m => m.role === 'user');
  const title = sanitizeTitle(messageText(lastUser));
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const servedModel = `multica/${cfg.agentName || 'dispatch'}`;
  const completionId = `chatcmpl-multica-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const sKey = sessionKey(upstream, scope);
  const reuseSession = cfg.sessionMode !== 'per-request';
  const paperclipIssue = /^MUL-\d+$/i.test((scope?.issueId || '').trim())
    ? scope!.issueId!.trim().toUpperCase()
    : undefined;

  let issueKey: string;
  let steeredRunId: string | undefined;
  const existing = reuseSession ? multicaSessions.get(sKey) : undefined;

  if (paperclipIssue || existing) {
    // Paperclip already names the Multica issue, or the session already
    // has one: dispatch into it. A live run gets steered; otherwise the
    // agent is re-assigned (which starts a new run), or the prompt lands
    // as a plain comment when no agent is configured.
    issueKey = paperclipIssue || existing!.issueKey;
    const runs = await multicaListRuns(runner, issueKey, remaining(), clientSignal);
    const active = runs.find(r => MULTICA_ACTIVE_RUN_STATUSES.includes(r.status));
    if (active) {
      await multicaSteerRun(runner, issueKey, active.id, promptText, remaining(), clientSignal);
      steeredRunId = active.id;
      if (reuseSession) {
        setBounded(
          multicaSessions,
          sKey,
          { issueKey, lastRunId: active.id, lastRunStatus: active.status },
          DEFAULT_MAX_CACHE_ENTRIES
        );
      }
    } else if (cfg.agentName) {
      await multicaAssignIssue(runner, issueKey, cfg.agentName, remaining(), clientSignal);
    } else {
      await multicaAddComment(runner, issueKey, promptText, remaining(), clientSignal);
    }
  } else {
    const createdIssue = await multicaCreateIssue(
      runner,
      { title, description: promptText, project: cfg.project },
      remaining(),
      clientSignal
    );
    issueKey = createdIssue.key;
    if (cfg.agentName) {
      await multicaAssignIssue(runner, issueKey, cfg.agentName, remaining(), clientSignal);
    }
    if (reuseSession) {
      setBounded(
        multicaSessions,
        sKey,
        { issueKey },
        DEFAULT_MAX_CACHE_ENTRIES
      );
    }
  }

  // Transcript ingestion (phase d, opt-in): register the dispatched
  // issue so the poller comes back for its runs — including runs that
  // are still working when this request's deadline hits. Registration
  // is best-effort and never fails a dispatch; without ingestion deps
  // (direct harness calls outside the router) nothing is registered.
  if (cfg.multica.ingestTranscripts === true && ingestionDeps) {
    try {
      registerMulticaIssueForIngestion({
        userId: scope?.userId || 'default',
        upstreamId: upstream.id,
        issueKey,
        sessionMode: cfg.sessionMode
      });
      ensureMulticaIngestionStarted(ingestionDeps, clampIngestIntervalMs(cfg.multica.ingestPollIntervalMs));
    } catch (err) {
      console.warn(
        `[MulticaIngestion] Failed to register ${issueKey} for ingestion:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // Poll for the run to finish. A run that is still working at the
  // deadline is NOT cancelled: the completion text reports where it is
  // and the run continues in Multica.
  let text: string;
  let finalRunId = steeredRunId;
  let finalStatus: string | undefined;

  if (!cfg.agentName && !paperclipIssue && !existing) {
    // Nothing was assigned, so no run will ever start. Report the created
    // issue instead of polling a run that does not exist.
    text =
      `Created Multica issue ${issueKey} ("${title}") with no agent assigned — ` +
      `no run will start until an agent is assigned in Multica.` +
      reviewNote(issueKey);
  } else {
    let latest: MulticaRun | undefined;
    let terminal: MulticaRun | undefined;
    while (remaining() > 0) {
      const runs = await multicaListRuns(runner, issueKey, remaining(), clientSignal);
      latest = runs[0];
      terminal = runs.find(r => MULTICA_TERMINAL_RUN_STATUSES.includes(r.status));
      if (terminal) break;
      if (remaining() <= 0) break;
      await sleep(Math.min(cfg.pollIntervalMs, remaining()), clientSignal);
    }
    finalRunId = terminal?.id || latest?.id || finalRunId;
    finalStatus = terminal?.status || latest?.status;

    if (terminal) {
      const messages = await multicaRunMessages(
        runner,
        issueKey,
        terminal.id,
        remaining(),
        clientSignal
      );
      const transcript = multicaTranscriptText(messages);
      if (terminal.status === 'completed') {
        text =
          (transcript || '(run completed with no transcript messages)') +
          reviewNote(issueKey, terminal.id);
      } else {
        text =
          `Multica run ${terminal.id} on issue ${issueKey} ended with status ` +
          `'${terminal.status}'.` +
          (transcript ? `\n\n${transcript}` : ' No transcript messages were returned.') +
          reviewNote(issueKey, terminal.id);
      }
      if (reuseSession) {
        setBounded(
          multicaSessions,
          sKey,
          { issueKey, lastRunId: terminal.id, lastRunStatus: terminal.status },
          DEFAULT_MAX_CACHE_ENTRIES
        );
      }
    } else {
      text =
        `Dispatched to Multica issue ${issueKey}` +
        (finalRunId ? ` (run ${finalRunId}, status '${finalStatus || 'unknown'}')` : '') +
        ` — the run is still working and was NOT cancelled. Ask again to steer it, ` +
        `or check \`multica issue runs ${issueKey}\`.` +
        reviewNote(issueKey, finalRunId);
      if (reuseSession && finalRunId) {
        setBounded(
          multicaSessions,
          sKey,
          { issueKey, lastRunId: finalRunId, lastRunStatus: finalStatus },
          DEFAULT_MAX_CACHE_ENTRIES
        );
      }
    }
  }

  const promptTokens = Math.ceil(promptText.length / 4);
  const completionTokens = Math.ceil(text.length / 4);

  if (!request.stream) {
    const payload = {
      id: completionId,
      object: 'chat.completion',
      created,
      model: servedModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop'
        }
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    };
    const headers = new Headers({
      'Content-Type': 'application/json',
      'x-eluvix-model': servedModel,
      'x-eluvix-harness': 'multica',
      'x-eluvix-multica-issue': issueKey,
      'x-eluvix-prompt-tokens': String(promptTokens),
      'x-eluvix-completion-tokens': String(completionTokens)
    });
    if (finalRunId) headers.set('x-eluvix-multica-run', finalRunId);
    return new Response(JSON.stringify(payload), { status: 200, headers });
  }

  // Streaming: the transcript arrives whole after polling, so it is
  // emitted as a single delta chunk followed by the stop chunk.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const chunk = (delta: unknown, finish: string | null) =>
        encoder.encode(
          `data: ${JSON.stringify({
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: servedModel,
            choices: [{ index: 0, delta, finish_reason: finish }]
          })}\n\n`
        );
      ctrl.enqueue(
        chunk({ role: 'assistant', content: '' }, null)
      );
      ctrl.enqueue(chunk({ content: text }, null));
      ctrl.enqueue(chunk({}, 'stop'));
      ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
      ctrl.close();
    }
  });
  const headers = new Headers({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'x-eluvix-model': servedModel,
    'x-eluvix-harness': 'multica',
    'x-eluvix-multica-issue': issueKey
  });
  if (finalRunId) headers.set('x-eluvix-multica-run', finalRunId);
  return new Response(stream, { status: 200, headers });
}
