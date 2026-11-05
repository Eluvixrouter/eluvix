// Regression tests for the Eluvix 2026-11-04 deep-dive bug hunt, Slice B
// (harness & context/memory). Each test pins one confirmed finding; the
// fake servers/agents below reproduce the hunt's /tmp repros in-suite.
//
// Findings covered:
//   H-B1  approval-reply fetches with no timeout (TrueForge + OpenCode)
//   M-B1  TrueForge approvals:'surface' + blocking server stalls to timeout
//   M-B2  ACP answers permission requests with fabricated optionIds
//   M-B3  TrueForge SSE reader drops the final event without trailing \n
//   L-B1  unbounded per-session transcript arrays (trim helper)
//   L-B2  OpenViking remember counts server-rejected writes to auto-commit
//   L-B3  builtin recall URI fallback interpolates raw scope.userId
//   L-B4  ACP test-env 'node' exception (negative control: no flag = denied)
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  forwardAcpHarness,
  forwardOpencodeHarness,
  forwardTrueForgeHarness,
  type UpstreamConfig,
} from '../index.js';
import {
  appendCappedTranscript,
  MAX_EMBEDDED_SESSION_TRANSCRIPT,
} from '../harness/trueforge.js';
import { OpenVikingContextProvider } from '../context/openviking.js';
import { BuiltinContextProvider } from '../context/builtin.js';
import { getDb } from '../db.js';

type Handler = (
  req: http.IncomingMessage,
  body: string,
  res: http.ServerResponse
) => void | Promise<void>;

async function startMockServer(handler: Handler): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      void handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // Never-responding approval endpoints (H-B1) leave sockets open;
        // destroy them so close() cannot hang on the aborted turn.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-hunt2-'));
  tmpDirs.push(dir);
  return dir;
}

function tfUpstream(url: string, approvals: string): UpstreamConfig {
  return {
    id: 'tf',
    name: 'TrueForge',
    type: 'harness',
    endpoint: url,
    priority: 100,
    models: ['*'],
    harness: { kind: 'trueforge', approvals: approvals as never },
  };
}

function ocUpstream(url: string, approvals: string): UpstreamConfig {
  return {
    id: 'oc',
    name: 'OpenCode',
    type: 'harness',
    endpoint: url,
    priority: 100,
    models: ['*'],
    harness: { kind: 'opencode', approvals: approvals as never },
  };
}

describe('hunt-2 slice B regressions', () => {
  it('H-B1 (TrueForge): a never-answering approval endpoint fails the turn at timeoutMs, not forever', async () => {
    let approvalPostSeen = false;
    const srv = await startMockServer((req, _body, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'tf-1' }));
        return;
      }
      if (req.url?.includes('/events')) {
        // The defect: never answer the approval POST.
        approvalPostSeen = true;
        return;
      }
      if (req.url?.includes('/turns')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ type: 'approval-required', turnId: 't1', approvalId: 'a1', toolName: 'read_file' })}\n\n`
        );
        return; // keep the turn stream open
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const start = Date.now();
      await expect(
        forwardTrueForgeHarness(
          tfUpstream(srv.url, 'auto-deny'),
          { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
          5000
        )
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - start).toBeLessThan(15000);
      expect(approvalPostSeen).toBe(true);
    } finally {
      await srv.close();
    }
  }, 30000);

  it('H-B1 (OpenCode): a never-answering permission reply fails the turn at timeoutMs, not forever', async () => {
    let replySeen = false;
    const srv = await startMockServer((req, _body, res) => {
      if (req.method === 'POST' && req.url === '/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'oc-1' }));
        return;
      }
      if (req.url?.includes('/permission/')) {
        // The defect: never answer the permission reply POST.
        replySeen = true;
        return;
      }
      if (req.url?.includes('/message')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            parts: [{ type: 'permission_request', id: 'perm-1', tool: 'read_file' }],
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const start = Date.now();
      await expect(
        forwardOpencodeHarness(
          ocUpstream(srv.url, 'auto-deny'),
          { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
          5000
        )
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - start).toBeLessThan(15000);
      expect(replySeen).toBe(true);
    } finally {
      await srv.close();
    }
  }, 30000);

  it("M-B1 (TrueForge): 'surface' mode answers a blocking approval with a denial instead of stalling to the timeout", async () => {
    let approvalBody: any = null;
    let resolveApproval: (body: any) => void = () => {};
    const approvalPromise = new Promise<any>((r) => {
      resolveApproval = r;
    });
    const srv = await startMockServer(async (req, body, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'tf-1' }));
        return;
      }
      if (req.url?.includes('/events')) {
        approvalBody = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        resolveApproval(approvalBody);
        return;
      }
      if (req.url?.includes('/turns')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ type: 'approval-required', turnId: 't1', approvalId: 'a1', toolName: 'read_file' })}\n\n`
        );
        // Blocking server: only finish the turn once the approval is answered.
        await approvalPromise;
        res.write(`data: ${JSON.stringify({ type: 'text-delta', delta: 'done' })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const start = Date.now();
      const res = await forwardTrueForgeHarness(
        tfUpstream(srv.url, 'surface'),
        { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
        5000
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      const content = String(json.choices[0].message.content);
      expect(content).toContain('[Approval Required');
      expect(content).toContain('done');
      expect(approvalBody).not.toBeNull();
      expect(approvalBody.approved).toBe(false);
      expect(Date.now() - start).toBeLessThan(4000);
    } finally {
      await srv.close();
    }
  }, 10000);

  it('M-B3 (TrueForge): a final SSE event without a trailing newline is still delivered (non-stream)', async () => {
    const srv = await startMockServer((req, _body, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'tf-1' }));
        return;
      }
      if (req.url?.includes('/turns')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // Deliberately no trailing newline: pre-fix, this event vanished.
        res.write(`data: ${JSON.stringify({ type: 'text-delta', delta: 'HELLO' })}`);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const res = await forwardTrueForgeHarness(
        tfUpstream(srv.url, 'auto-deny'),
        { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
        5000
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.choices[0].message.content).toBe('HELLO');
    } finally {
      await srv.close();
    }
  }, 10000);

  it('M-B3 control: a newline-terminated final event still works (non-stream)', async () => {
    const srv = await startMockServer((req, _body, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'tf-1' }));
        return;
      }
      if (req.url?.includes('/turns')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'text-delta', delta: 'HELLO' })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const res = await forwardTrueForgeHarness(
        tfUpstream(srv.url, 'auto-deny'),
        { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
        5000
      );
      const json = await res.json();
      expect(json.choices[0].message.content).toBe('HELLO');
    } finally {
      await srv.close();
    }
  }, 10000);

  it('M-B3 (TrueForge): a final SSE event without a trailing newline is still delivered (stream)', async () => {
    const srv = await startMockServer((req, _body, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'tf-1' }));
        return;
      }
      if (req.url?.includes('/turns')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'text-delta', delta: 'HELLO' })}`);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const res = await forwardTrueForgeHarness(
        tfUpstream(srv.url, 'auto-deny'),
        { model: 'test-model', messages: [{ role: 'user', content: 'hi' }], stream: true },
        5000
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('HELLO');
    } finally {
      await srv.close();
    }
  }, 10000);

  // --- ACP permission options (M-B2) -------------------------------------
  // Fake ACP agent: answers initialize/session-new, then issues one
  // permission request with the options from argv[2], records the
  // optionId the router answers with to argv[3], then completes the turn.
  const ACP_PERMISSION_AGENT = `
import readline from 'node:readline';
import fs from 'node:fs';
const options = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
const recordPath = process.argv[3];
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-sess-1' } }) + '\\n');
  } else if (msg.method === 'session/prompt') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: 99, method: 'session/request_permission',
      params: { toolCall: { name: 'read_file', title: 'read_file' }, options }
    }) + '\\n');
  } else if (msg.id === 99 && msg.result) {
    fs.writeFileSync(recordPath, String(msg.result?.outcome?.optionId ?? ''));
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { text: 'permission flow done' } }) + '\\n');
  }
});
`;

  function writeAcpAgent(options: unknown[]): {
    script: string;
    optionsPath: string;
    recordPath: string;
  } {
    const dir = mkTmpDir();
    const script = path.join(dir, 'agent.mjs');
    const optionsPath = path.join(dir, 'options.json');
    const recordPath = path.join(dir, 'record.txt');
    fs.writeFileSync(script, ACP_PERMISSION_AGENT, 'utf-8');
    fs.writeFileSync(optionsPath, JSON.stringify(options), 'utf-8');
    return { script, optionsPath, recordPath };
  }

  function acpUpstream(
    script: string,
    optionsPath: string,
    recordPath: string,
    approvals: string,
    autoApproveTools?: string[]
  ): UpstreamConfig {
    return {
      id: 'acp',
      name: 'Mock ACP',
      type: 'harness',
      endpoint: 'acp://node',
      priority: 50,
      models: ['harness/acp'],
      harness: {
        kind: 'acp',
        command: process.execPath,
        args: [script, optionsPath, recordPath],
        approvals: approvals as never,
        ...(autoApproveTools ? { autoApproveTools } : {}),
      },
    };
  }

  it('M-B2: ACP denial with no reject-like option fails the turn instead of inventing an optionId', async () => {
    const { script, optionsPath, recordPath } = writeAcpAgent([
      { optionId: 'opt-yes', kind: 'proceed' },
      { optionId: 'opt-no', kind: 'cancel' },
    ]);
    await expect(
      forwardAcpHarness(
        acpUpstream(script, optionsPath, recordPath, 'auto-deny'),
        { model: 'harness/acp', messages: [{ role: 'user', content: 'hi' }] },
        10000
      )
    ).rejects.toThrow(/no usable optionId/);
    expect(fs.existsSync(recordPath)).toBe(false);
  }, 20000);

  it('M-B2: ACP denial answers with the offered reject-like optionId, not a fabricated one', async () => {
    const { script, optionsPath, recordPath } = writeAcpAgent([
      { optionId: 'opt-yes', kind: 'proceed' },
      { optionId: 'opt-no', kind: 'reject' },
    ]);
    const res = await forwardAcpHarness(
      acpUpstream(script, optionsPath, recordPath, 'auto-deny'),
      { model: 'harness/acp', messages: [{ role: 'user', content: 'hi' }] },
      10000
    );
    expect(res.status).toBe(200);
    expect(fs.readFileSync(recordPath, 'utf-8')).toBe('opt-no');
  }, 20000);

  it('M-B2: ACP approval answers with the offered allow-like optionId', async () => {
    const { script, optionsPath, recordPath } = writeAcpAgent([
      { optionId: 'opt-allow', kind: 'allow' },
      { optionId: 'opt-deny', kind: 'deny' },
    ]);
    const res = await forwardAcpHarness(
      acpUpstream(script, optionsPath, recordPath, 'auto-approve-readonly', ['read_file']),
      { model: 'harness/acp', messages: [{ role: 'user', content: 'hi' }] },
      10000
    );
    expect(res.status).toBe(200);
    expect(fs.readFileSync(recordPath, 'utf-8')).toBe('opt-allow');
  }, 20000);

  it('M-B2: ACP approval with no allow-like option denies via the offered reject-like option (safe direction)', async () => {
    const { script, optionsPath, recordPath } = writeAcpAgent([
      { optionId: 'opt-yes', kind: 'proceed' },
      { optionId: 'opt-no', kind: 'reject' },
    ]);
    const res = await forwardAcpHarness(
      acpUpstream(script, optionsPath, recordPath, 'auto-approve-readonly', ['read_file']),
      { model: 'harness/acp', messages: [{ role: 'user', content: 'hi' }] },
      10000
    );
    expect(res.status).toBe(200);
    expect(fs.readFileSync(recordPath, 'utf-8')).toBe('opt-no');
  }, 20000);

  it('L-B1: embedded session transcripts are capped (oldest trimmed first)', () => {
    expect(MAX_EMBEDDED_SESSION_TRANSCRIPT).toBe(20);
    const entries: number[] = [];
    for (let i = 0; i < 25; i++) appendCappedTranscript(entries, i);
    expect(entries).toHaveLength(20);
    expect(entries[0]).toBe(5);
    expect(entries[19]).toBe(24);
  });

  it('L-B2: OpenViking remember does not count a server-rejected write toward auto-commit', async () => {
    let commitCount = 0;
    const srv = await startMockServer((req, _body, res) => {
      if (req.url?.endsWith('/commit')) {
        commitCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // Messages write rejected by the server.
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    });
    try {
      const provider = new OpenVikingContextProvider({
        endpoint: srv.url,
        autoCommitTurns: 1,
      });
      await provider.remember(
        { user: { role: 'user', content: 'hello' }, assistant: 'world' },
        { userId: 'alice', sessionId: 'sess-1', origin: 'client' }
      );
      expect(commitCount).toBe(0);
    } finally {
      await srv.close();
    }
  }, 10000);

  it('L-B2 control: OpenViking remember counts a successful write toward auto-commit', async () => {
    let commitCount = 0;
    const srv = await startMockServer((req, _body, res) => {
      if (req.url?.endsWith('/commit')) {
        commitCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const provider = new OpenVikingContextProvider({
        endpoint: srv.url,
        autoCommitTurns: 1,
      });
      await provider.remember(
        { user: { role: 'user', content: 'hello' }, assistant: 'world' },
        { userId: 'alice', sessionId: 'sess-1', origin: 'client' }
      );
      expect(commitCount).toBe(1);
    } finally {
      await srv.close();
    }
  }, 10000);

  it('L-B3: builtin recall fallback URI uses the defaulted userId, never "undefined"', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO memory_items (user_id, session_id, uri, level, content, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('default', null, null, 'L1', 'the quick brown fox jumps', null);
    const provider = new BuiltinContextProvider();
    return provider
      .recall('quick', { origin: 'client' } as never, 800)
      .then((result) => {
        expect(result.blocks.length).toBeGreaterThan(0);
        expect(result.blocks[0].uri).toMatch(/^viking:\/\/user\/default\/memories\/\d+$/);
        expect(result.blocks[0].uri).not.toContain('undefined');
      });
  });

  it("L-B4 (negative control): without ELUVIX_ALLOW_TEST_AGENTS, a node ACP agent is denied even under NODE_ENV=test", async () => {
    expect(process.env.NODE_ENV).toBe('test');
    const saved = process.env.ELUVIX_ALLOW_TEST_AGENTS;
    delete process.env.ELUVIX_ALLOW_TEST_AGENTS;
    try {
      const dir = mkTmpDir();
      const script = path.join(dir, 'noop.mjs');
      fs.writeFileSync(script, '/* noop */\n', 'utf-8');
      await expect(
        forwardAcpHarness(
          {
            id: 'acp',
            name: 'Mock ACP',
            type: 'harness',
            endpoint: 'acp://node',
            priority: 50,
            models: ['harness/acp'],
            harness: { kind: 'acp', command: process.execPath, args: [script] },
          },
          { model: 'harness/acp', messages: [{ role: 'user', content: 'hi' }] },
          10000
        )
      ).rejects.toThrow(/not an authorized CLI binary/);
    } finally {
      if (saved === undefined) delete process.env.ELUVIX_ALLOW_TEST_AGENTS;
      else process.env.ELUVIX_ALLOW_TEST_AGENTS = saved;
    }
  }, 20000);
});
