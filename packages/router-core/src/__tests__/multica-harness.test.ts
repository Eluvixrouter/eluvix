// Multica harness adapter tests (phase b). The fake `multica` CLI below
// emulates the real CLI's JSON surface (docs/cli.mdx): `issue create`
// (title via --title, description via stdin), `issue assign`, `issue
// runs`, `issue run-messages`, `issue comment add --steer`, `issue
// cancel-task`, `issue rerun-task`. It records every invocation's argv +
// env presence (never secret values) to a record file so tests can assert
// the exact command construction, and answers `issue runs` from a
// per-call script so polling/steering/timeout paths are deterministic.
//
// No live Multica instance is involved; nothing here calls the network.
// The spawn gate still applies: the fake runs as `node <script>` only
// under ELUVIX_ALLOW_TEST_AGENTS=1 (set by test-setup.ts), exactly like
// the fake ACP agents in hunt2-harness.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  forwardMulticaHarness,
  forwardHarnessRequest,
  resolveHarnessKind,
  resolveMulticaConfig,
  resolveMulticaPat,
  createMulticaRunner,
  multicaCancelRun,
  multicaRerunRun,
  multicaListRuns,
  buildChildEnv,
  type UpstreamConfig,
} from '../index.js';
import type { RequestScope } from '../context/types.js';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-multica-'));
  tmpDirs.push(dir);
  return dir;
}

interface MulticaRecord {
  argv: string[];
  stdin: string;
  hasMulticaToken: boolean;
  multicaTokenLength: number;
  hasAdminPassword: boolean;
  hasNextAuthSecret: boolean;
}

interface MulticaScenario {
  /** Per `issue runs` call ordinal (1-based): the run array to return. */
  runsByCall?: Record<string, Array<{ id: string; status: string; agent?: string }>>;
  /** Messages returned by `issue run-messages`. */
  runMessages?: Array<{ role: string; content: string }>;
  /** Issue object returned by `issue create`. */
  createdIssue?: Record<string, unknown>;
}

// Fake `multica` CLI. argv: [script, recordPath, scenarioPath].
const FAKE_MULTICA_CLI = `
import fs from 'node:fs';
const recordPath = process.argv[2];
const scenarioPath = process.argv[3];
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8'));
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(4);
  const records = fs.existsSync(recordPath)
    ? JSON.parse(fs.readFileSync(recordPath, 'utf-8'))
    : [];
  records.push({
    argv,
    stdin,
    hasMulticaToken: typeof process.env.MULTICA_TOKEN === 'string' && process.env.MULTICA_TOKEN.length > 0,
    multicaTokenLength: (process.env.MULTICA_TOKEN || '').length,
    hasAdminPassword: typeof process.env.ADMIN_PASSWORD === 'string',
    hasNextAuthSecret: typeof process.env.NEXTAUTH_SECRET === 'string'
  });
  fs.writeFileSync(recordPath, JSON.stringify(records), 'utf-8');
  const out = (v) => { process.stdout.write(JSON.stringify(v) + '\\n'); };
  const issueIdx = argv.indexOf('issue');
  const sub = issueIdx >= 0 ? argv[issueIdx + 1] : '';
  const runsCalls = records.filter((r) => r.argv.includes('issue') && r.argv.includes('runs')).length;
  if (sub === 'create') {
    const titleIdx = argv.indexOf('--title');
    out(scenario.createdIssue || { id: 'uuid-1', identifier: 'MUL-123', title: titleIdx >= 0 ? argv[titleIdx + 1] : '', status: 'todo' });
  } else if (sub === 'assign') {
    out({ id: 'uuid-1', identifier: 'MUL-123', assignee: 'Backend Agent', status: 'in_progress' });
  } else if (sub === 'get') {
    out({ id: 'uuid-1', identifier: 'MUL-123', title: 'Fix login failure', status: 'in_progress' });
  } else if (sub === 'runs') {
    const byCall = scenario.runsByCall || {};
    const runs = byCall[String(runsCalls)] || byCall['default'] || [{ id: 'run-1', status: 'completed', agent: 'Backend Agent' }];
    out(runs);
  } else if (sub === 'run-messages') {
    out(scenario.runMessages || [{ role: 'assistant', content: 'Fixed the login failure; tests pass.' }]);
  } else if (sub === 'comment') {
    out({ id: 'c-1', issue: 'MUL-123', status: 'ok' });
  } else if (sub === 'cancel-task') {
    out({ id: 'run-1', status: 'cancelled' });
  } else if (sub === 'rerun-task') {
    out({ id: 'run-2', status: 'queued' });
  } else {
    process.stderr.write('unknown subcommand: ' + sub + '\\n');
    process.exit(2);
  }
});
`;

function writeFakeMultica(scenario: MulticaScenario): {
  script: string;
  recordPath: string;
  scenarioPath: string;
} {
  const dir = mkTmpDir();
  const script = path.join(dir, 'multica.mjs');
  const recordPath = path.join(dir, 'record.json');
  const scenarioPath = path.join(dir, 'scenario.json');
  fs.writeFileSync(script, FAKE_MULTICA_CLI, 'utf-8');
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario), 'utf-8');
  return { script, recordPath, scenarioPath };
}

function readRecords(recordPath: string): MulticaRecord[] {
  if (!fs.existsSync(recordPath)) return [];
  return JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
}

function multicaUpstream(
  script: string,
  scenarioPath: string,
  overrides: Partial<UpstreamConfig> = {}
): UpstreamConfig {
  return {
    id: 'multica-test',
    name: 'Mock Multica',
    type: 'harness',
    endpoint: 'http://localhost:8080',
    priority: 50,
    models: ['harness/multica'],
    apiKey: 'mul_test_pat_0123456789abcdef',
    harness: {
      kind: 'multica',
      command: process.execPath,
      args: [script, 'RECORD', 'SCENARIO'],
      agentId: 'Backend Agent',
      approvals: 'surface',
      sessionMode: 'per-request',
      multica: { pollIntervalMs: 100 },
    },
    ...overrides,
  } as UpstreamConfig;
}

/** Wire the record/scenario paths into the harness args. */
function wirePaths(upstream: UpstreamConfig, recordPath: string, scenarioPath: string): UpstreamConfig {
  const h = { ...(upstream.harness as unknown as Record<string, unknown>) };
  const args = [...((h.args as string[]) || [])];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'RECORD') args[i] = recordPath;
    if (args[i] === 'SCENARIO') args[i] = scenarioPath;
  }
  h.args = args;
  return { ...upstream, harness: h as unknown as UpstreamConfig['harness'] };
}

const SCOPE: RequestScope = { userId: 'alice', sessionId: 'sess-multica-1', origin: 'client' };

function chatRequest(text: string) {
  return {
    model: 'harness/multica',
    messages: [{ role: 'user' as const, content: text }],
  };
}

describe('multica harness', () => {
  it('routes model harness/multica to the multica adapter via forwardHarnessRequest', async () => {
    expect(resolveHarnessKind(multicaUpstream('x', 'y'))).toBe('multica');
    const { script, recordPath, scenarioPath } = writeFakeMultica({
      runsByCall: { '1': [{ id: 'run-1', status: 'running' }], '2': [{ id: 'run-1', status: 'completed' }] },
    });
    const upstream = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
    const res = await forwardHarnessRequest(upstream, chatRequest('Fix login failure'), 10000, undefined, SCOPE);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-harness')).toBe('multica');
    expect(res.headers.get('x-eluvix-multica-issue')).toBe('MUL-123');
    expect(res.headers.get('x-eluvix-multica-run')).toBe('run-1');
    const body = await res.json();
    expect(body.choices[0].message.content).toContain('Fixed the login failure');
    expect(body.choices[0].message.content).toContain('review gate');
  }, 20000);

  it('dispatches create + assign + poll + run-messages with the prompt on stdin, not argv', async () => {
    const { script, recordPath, scenarioPath } = writeFakeMultica({
      runsByCall: { '1': [{ id: 'run-1', status: 'running' }], '2': [{ id: 'run-1', status: 'completed' }] },
      runMessages: [
        { role: 'assistant', content: 'Patched auth.ts.' },
        { role: 'assistant', content: 'All 12 tests pass.' },
      ],
    });
    const upstream = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
    const res = await forwardMulticaHarness(upstream, chatRequest('Fix login failure'), 10000, undefined, SCOPE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toContain('Patched auth.ts.');
    expect(body.choices[0].message.content).toContain('All 12 tests pass.');

    const records = readRecords(recordPath);
    const argvJoined = records.map(r => r.argv.join(' '));
    // create carries the title as an arg, the description on stdin, and
    // the review-gate flag; assign names the agent; runs are polled.
    const create = records.find(r => r.argv.includes('create'));
    expect(create).toBeDefined();
    expect(create!.argv).toContain('--title');
    expect(create!.argv).toContain('Fix login failure');
    expect(create!.argv).toContain('--description-stdin');
    expect(create!.argv).toContain('--pr-auto-complete');
    expect(create!.argv).toContain('off');
    expect(create!.argv).not.toContain('Fix login failure\n');
    expect(create!.stdin).toContain('Fix login failure');
    expect(argvJoined.some(a => a.includes('issue assign MUL-123 --to Backend Agent'))).toBe(true);
    expect(argvJoined.filter(a => a.includes('issue runs MUL-123')).length).toBeGreaterThanOrEqual(2);
    expect(argvJoined.some(a => a.includes('issue run-messages run-1 --issue MUL-123'))).toBe(true);
    // Global flags precede the subcommand.
    expect(create!.argv.indexOf('--server-url')).toBeLessThan(create!.argv.indexOf('issue'));
    expect(create!.argv).toContain('http://localhost:8080');
  }, 20000);

  it('PAT reaches the direct child only: present in the child env, never in process.env afterwards', async () => {
    const { script, recordPath, scenarioPath } = writeFakeMultica({});
    const upstream = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
    expect(process.env.MULTICA_TOKEN).toBeUndefined();
    await forwardMulticaHarness(upstream, chatRequest('hi'), 10000, undefined, SCOPE);
    expect(process.env.MULTICA_TOKEN).toBeUndefined();
    const records = readRecords(recordPath);
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec.hasMulticaToken).toBe(true);
      expect(rec.multicaTokenLength).toBe('mul_test_pat_0123456789abcdef'.length);
    }
    // A fresh buildChildEnv afterwards carries no trace of the PAT.
    expect(buildChildEnv({})).not.toHaveProperty('MULTICA_TOKEN');
  }, 20000);

  it('child env is scrubbed: ADMIN_PASSWORD / NEXTAUTH_SECRET never reach the CLI', async () => {
    const savedAdmin = process.env.ADMIN_PASSWORD;
    const savedNextAuth = process.env.NEXTAUTH_SECRET;
    process.env.ADMIN_PASSWORD = 'admin-secret-value';
    process.env.NEXTAUTH_SECRET = 'nextauth-secret-value';
    try {
      const { script, recordPath, scenarioPath } = writeFakeMultica({});
      const upstream = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
      await forwardMulticaHarness(upstream, chatRequest('hi'), 10000, undefined, SCOPE);
      const records = readRecords(recordPath);
      expect(records.length).toBeGreaterThan(0);
      for (const rec of records) {
        expect(rec.hasAdminPassword).toBe(false);
        expect(rec.hasNextAuthSecret).toBe(false);
      }
    } finally {
      if (savedAdmin === undefined) delete process.env.ADMIN_PASSWORD;
      else process.env.ADMIN_PASSWORD = savedAdmin;
      if (savedNextAuth === undefined) delete process.env.NEXTAUTH_SECRET;
      else process.env.NEXTAUTH_SECRET = savedNextAuth;
    }
  }, 20000);

  it('negative control: buildChildEnv strips MULTICA_TOKEN even when injected via extra or process.env', () => {
    expect(buildChildEnv({ MULTICA_TOKEN: 'mul_should_be_stripped' })).not.toHaveProperty(
      'MULTICA_TOKEN'
    );
    const saved = process.env.MULTICA_TOKEN;
    process.env.MULTICA_TOKEN = 'mul_polluted_process_env';
    try {
      expect(buildChildEnv({})).not.toHaveProperty('MULTICA_TOKEN');
    } finally {
      if (saved === undefined) delete process.env.MULTICA_TOKEN;
      else process.env.MULTICA_TOKEN = saved;
    }
  });

  it('negative control: mat_ task tokens are refused — dispatch needs the user PAT', async () => {
    const { script, scenarioPath } = writeFakeMultica({});
    const upstream = wirePaths(
      multicaUpstream(script, scenarioPath, { apiKey: 'mat_run_scoped_token_abc' }),
      path.join(path.dirname(script), 'record.json'),
      scenarioPath
    );
    await expect(
      forwardMulticaHarness(upstream, chatRequest('hi'), 10000, undefined, SCOPE)
    ).rejects.toThrow(/mat_.*task token/);
  });

  it('negative control: missing PAT refuses anonymous dispatch', async () => {
    const { script, scenarioPath } = writeFakeMultica({});
    const upstream = wirePaths(
      multicaUpstream(script, scenarioPath, { apiKey: undefined }),
      path.join(path.dirname(script), 'record.json'),
      scenarioPath
    );
    await expect(
      forwardMulticaHarness(upstream, chatRequest('hi'), 10000, undefined, SCOPE)
    ).rejects.toThrow(/per-user PAT/);
  });

  it('negative control: a non-mul_ credential is refused', async () => {
    const { script, scenarioPath } = writeFakeMultica({});
    const upstream = wirePaths(
      multicaUpstream(script, scenarioPath, { apiKey: 'sk-something-else' }),
      path.join(path.dirname(script), 'record.json'),
      scenarioPath
    );
    await expect(resolveMulticaPat(upstream)).rejects.toThrow(/mul_/);
  });

  it('negative control: without ELUVIX_ALLOW_TEST_AGENTS, a node multica agent is denied', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    const saved = process.env.ELUVIX_ALLOW_TEST_AGENTS;
    delete process.env.ELUVIX_ALLOW_TEST_AGENTS;
    try {
      const { script, scenarioPath } = writeFakeMultica({});
      const upstream = wirePaths(
        multicaUpstream(script, scenarioPath),
        path.join(path.dirname(script), 'record.json'),
        scenarioPath
      );
      await expect(
        forwardMulticaHarness(upstream, chatRequest('hi'), 10000, undefined, SCOPE)
      ).rejects.toThrow(/not an authorized CLI binary/);
    } finally {
      if (saved === undefined) delete process.env.ELUVIX_ALLOW_TEST_AGENTS;
      else process.env.ELUVIX_ALLOW_TEST_AGENTS = saved;
    }
  });

  it('SSRF guard: a metadata server URL is rejected before the CLI ever runs', () => {
    const upstream = multicaUpstream('x', 'y', { endpoint: 'http://169.254.169.254/' });
    expect(() => resolveMulticaConfig(upstream, SCOPE)).toThrow(/SSRF guard/);
    const creds = multicaUpstream('x', 'y', { endpoint: 'http://user:pass@127.0.0.1:8080/' });
    expect(() => resolveMulticaConfig(creds, SCOPE)).toThrow(/SSRF guard/);
  });

  it('tool-bearing requests are refused instead of silently dropping the tools', async () => {
    const { script, scenarioPath } = writeFakeMultica({});
    const upstream = wirePaths(
      multicaUpstream(script, scenarioPath),
      path.join(path.dirname(script), 'record.json'),
      scenarioPath
    );
    await expect(
      forwardMulticaHarness(
        upstream,
        {
          model: 'harness/multica',
          messages: [{ role: 'user' as const, content: 'hi' }],
          tools: [{ type: 'function', function: { name: 'read_file' } }],
        } as never,
        10000,
        undefined,
        SCOPE
      )
    ).rejects.toThrow(/tool calling/);
  });

  it('approval policy never refuses dispatch', async () => {
    const { script, scenarioPath } = writeFakeMultica({});
    const upstream = wirePaths(
      multicaUpstream(script, scenarioPath, {
        harness: {
          kind: 'multica',
          command: process.execPath,
          args: [script, 'RECORD', 'SCENARIO'],
          approvals: 'never',
        },
      }),
      path.join(path.dirname(script), 'record.json'),
      scenarioPath
    );
    await expect(
      forwardMulticaHarness(upstream, chatRequest('hi'), 10000, undefined, SCOPE)
    ).rejects.toThrow(/approval policy "never"/);
  });

  it('timeout: a still-running run is reported, NOT cancelled', async () => {
    const { script, recordPath, scenarioPath } = writeFakeMultica({
      runsByCall: { default: [{ id: 'run-1', status: 'running' }] },
    });
    const upstream = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
    const res = await forwardMulticaHarness(upstream, chatRequest('long job'), 1200, undefined, {
      ...SCOPE,
      sessionId: 'sess-multica-timeout',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toMatch(/still working/);
    expect(body.choices[0].message.content).toMatch(/NOT cancelled/);
    expect(body.choices[0].message.content).toContain('MUL-123');
    const records = readRecords(recordPath);
    expect(records.some(r => r.argv.includes('cancel-task'))).toBe(false);
    expect(records.some(r => r.argv.includes('run-messages'))).toBe(false);
  }, 20000);

  it('failed run: completion text reports the failure instead of throwing', async () => {
    const { script, recordPath, scenarioPath } = writeFakeMultica({
      runsByCall: { '1': [{ id: 'run-1', status: 'failed' }] },
      runMessages: [{ role: 'assistant', content: 'Build broke on step 3.' }],
    });
    const upstream = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
    const res = await forwardMulticaHarness(upstream, chatRequest('do it'), 10000, undefined, {
      ...SCOPE,
      sessionId: 'sess-multica-failed',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toMatch(/ended with status 'failed'/);
    expect(body.choices[0].message.content).toContain('Build broke on step 3.');
  }, 20000);

  it('session reuse: a follow-up steers the live run instead of opening a new issue', async () => {
    const { script, recordPath, scenarioPath } = writeFakeMultica({
      runsByCall: {
        '1': [{ id: 'run-1', status: 'running' }],
        '2': [{ id: 'run-1', status: 'completed' }],
        '3': [{ id: 'run-1', status: 'running' }],
        '4': [{ id: 'run-1', status: 'completed' }],
      },
    });
    const base = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
    const sessionUpstream: UpstreamConfig = {
      ...base,
      harness: { ...(base.harness as object), sessionMode: 'per-eluvix-session' } as never,
    };
    const scope = { ...SCOPE, sessionId: 'sess-multica-steer' };
    await forwardMulticaHarness(sessionUpstream, chatRequest('first task'), 10000, undefined, scope);
    const second = await forwardMulticaHarness(
      sessionUpstream,
      chatRequest('also check the edge case'),
      10000,
      undefined,
      scope
    );
    expect(second.status).toBe(200);
    const records = readRecords(recordPath);
    expect(records.filter(r => r.argv.includes('create')).length).toBe(1);
    const steer = records.find(r => r.argv.includes('--steer'));
    expect(steer).toBeDefined();
    expect(steer!.argv).toContain('run-1');
    expect(steer!.argv).toContain('--idempotency-key');
    expect(steer!.stdin).toContain('also check the edge case');
  }, 20000);

  it('paperclip issueId dispatches into the existing issue instead of creating one', async () => {
    const { script, recordPath, scenarioPath } = writeFakeMultica({
      runsByCall: { '1': [{ id: 'run-9', status: 'completed' }] },
    });
    const upstream = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
    const res = await forwardMulticaHarness(
      upstream,
      chatRequest('status update please'),
      10000,
      undefined,
      { ...SCOPE, issueId: 'MUL-456', sessionId: 'sess-multica-paperclip' }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-multica-issue')).toBe('MUL-456');
    const records = readRecords(recordPath);
    expect(records.some(r => r.argv.includes('create'))).toBe(false);
    expect(records.some(r => r.argv.includes('runs') && r.argv.includes('MUL-456'))).toBe(true);
  }, 20000);

  it('no agent configured: issue is created unassigned and the text says so plainly', async () => {
    const { script, recordPath, scenarioPath } = writeFakeMultica({});
    const base = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
    const noAgent: UpstreamConfig = {
      ...base,
      harness: { ...(base.harness as object), agentId: 'default' } as never,
    };
    const res = await forwardMulticaHarness(noAgent, chatRequest('triage this'), 10000, undefined, {
      ...SCOPE,
      sessionId: 'sess-multica-noagent',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toMatch(/no agent assigned/);
    const records = readRecords(recordPath);
    expect(records.some(r => r.argv.includes('assign'))).toBe(false);
    expect(records.some(r => r.argv.includes('runs'))).toBe(false);
  }, 20000);

  it('streaming: transcript arrives as SSE deltas ending in [DONE]', async () => {
    const { script, recordPath, scenarioPath } = writeFakeMultica({});
    const upstream = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
    const res = await forwardMulticaHarness(
      upstream,
      { ...chatRequest('stream me'), stream: true },
      10000,
      undefined,
      { ...SCOPE, sessionId: 'sess-multica-stream' }
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('Fixed the login failure');
    expect(text).toContain('data: [DONE]');
    expect(text).toContain('"finish_reason":"stop"');
  }, 20000);

  it('cancel + rerun helpers invoke the exact CLI commands', async () => {
    const { script, recordPath, scenarioPath } = writeFakeMultica({});
    const upstream = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
    const cfg = resolveMulticaConfig(upstream, SCOPE);
    const pat = await resolveMulticaPat(upstream);
    const runner = await createMulticaRunner(upstream, cfg, pat, 0);
    await multicaCancelRun(runner, 'MUL-123', 'run-1', 10000);
    await multicaRerunRun(runner, 'MUL-123', 'run-1', true, 10000);
    const runs = await multicaListRuns(runner, 'MUL-123', 10000);
    expect(runs[0].id).toBe('run-1');
    expect(runs[0].status).toBe('completed');
    const records = readRecords(recordPath);
    const joined = records.map(r => r.argv.join(' '));
    expect(joined.some(a => a.includes('issue cancel-task run-1 --issue MUL-123'))).toBe(true);
    expect(joined.some(a => a.includes('issue rerun-task run-1 --issue MUL-123 --fresh'))).toBe(true);
  }, 20000);

  it('unknown run status is treated as active (poll continues) instead of erroring', async () => {
    const { script, recordPath, scenarioPath } = writeFakeMultica({
      runsByCall: {
        '1': [{ id: 'run-1', status: 'mysterious' }],
        '2': [{ id: 'run-1', status: 'completed' }],
      },
    });
    const upstream = wirePaths(multicaUpstream(script, scenarioPath), recordPath, scenarioPath);
    const res = await forwardMulticaHarness(upstream, chatRequest('hi'), 10000, undefined, {
      ...SCOPE,
      sessionId: 'sess-multica-unknown',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toContain('Fixed the login failure');
  }, 20000);
});
