// Regression tests for the Eluvix 2026-11-23 deep-dive bug hunt #3, Slice B
// (harness & context/memory). Each test pins one confirmed finding with a
// genuine negative control: it fails on the pre-fix code and passes after.
//
// Findings covered:
//   B-M1  TrueForge/OpenCode approval replies use raw autoApproveTools,
//         dropping the vectorcraft/artcraft additions
//   B-M2  Bare-fetch redirect bounce in 8 harness adapters + all context
//         providers; OpenViking sends its API key twice (Authorization +
//         X-Api-Key)
//   B-M3  H-9 ownership filter missing in graphiti/lightrag/cognee/
//         supermemory (+ knowledge backends)
//   B-M4  No recall timeout in those same providers + knowledge
//   B-M5  Child-env scrub denylist misses BAO/VAULT tokens + paperclip
//         HMAC secrets (+ test-only secrets of the same class)
//   B-L1  ACP unbounded lineBuf/fullText + crash-after-partial returns 200
//   B-L2  remember() ignores non-2xx in mem0/graphiti/lightrag/cognee/
//         supermemory
//   B-L3  (DROPPED on re-verification against cc48c8c: the usage transform
//         already reports the LAST usage frame — reportedUsage is
//         overwritten per frame and emitted once at stream end. The test
//         below locks that behavior in so a later change cannot regress
//         it to first-wins.)
//   B-L4  Embedded OpenCode server: per-request body widens the approval
//         policy/autoApproveTools beyond the server defaults; permId
//         millisecond collision
//   B-L5  No endpoint allowlist on graphiti/lightrag/cognee/supermemory/
//         knowledge
//   B-L6  Provider recall (and a2a) parse the whole response body with
//         unbounded res.json()
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  forwardAcpHarness,
  forwardAiderHarness,
  forwardA2aHarness,
  forwardOpencodeHarness,
  forwardTrueForgeHarness,
  createEluvixOpenCodeServer,
  buildChildEnv,
  transformSseStreamWithUsageCost,
  readCappedJson,
  GraphitiContextProvider,
  LightRagContextProvider,
  CogneeContextProvider,
  SupermemoryContextProvider,
  Mem0ContextProvider,
  OpenVikingContextProvider,
  recallKnowledgeBase,
  type UpstreamConfig,
} from '../index.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-hunt3-b-'));
  tmpDirs.push(dir);
  return dir;
}

const SCOPE = { userId: 'alice', origin: 'client' as const };

describe('hunt-3 slice B regressions', () => {
  it('B-M1 (TrueForge): vectorcraft draw_shape is approved without an explicit list', async () => {
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
          `data: ${JSON.stringify({ type: 'approval-required', turnId: 't1', approvalId: 'a1', toolName: 'draw_shape' })}\n\n`
        );
        await approvalPromise;
        res.write(`data: ${JSON.stringify({ type: 'text-delta', delta: 'done' })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const upstream: UpstreamConfig = {
        id: 'tf',
        name: 'TrueForge',
        type: 'harness',
        endpoint: srv.url,
        priority: 100,
        models: ['*'],
        vectorcraft: { enabled: true },
        harness: { kind: 'trueforge', approvals: 'auto-approve-readonly' },
      };
      const res = await forwardTrueForgeHarness(
        upstream,
        { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
        5000
      );
      expect(res.status).toBe(200);
      expect(approvalBody).not.toBeNull();
      // Pre-fix: the reply carried the raw (empty) list, so draw_shape
      // was denied even though the session was told Eluvix can use it.
      expect(approvalBody.approved).toBe(true);
    } finally {
      await srv.close();
    }
  }, 10000);

  it('B-M1 (OpenCode): vectorcraft draw_shape is approved without an explicit list', async () => {
    let replyBody: any = null;
    const srv = await startMockServer((req, body, res) => {
      if (req.method === 'POST' && req.url === '/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'oc-1' }));
        return;
      }
      if (req.url?.includes('/permission/')) {
        replyBody = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url?.includes('/message')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            parts: [{ type: 'permission_request', id: 'perm-1', tool: 'draw_shape' }],
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const upstream: UpstreamConfig = {
        id: 'oc',
        name: 'OpenCode',
        type: 'harness',
        endpoint: srv.url,
        priority: 100,
        models: ['*'],
        vectorcraft: { enabled: true },
        harness: { kind: 'opencode', approvals: 'auto-approve-readonly' },
      };
      const res = await forwardOpencodeHarness(
        upstream,
        { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
        5000
      );
      expect(res.status).toBe(200);
      expect(replyBody).not.toBeNull();
      // Pre-fix: the reply carried the raw (empty) list -> 'reject'.
      expect(replyBody.response).toBe('once');
    } finally {
      await srv.close();
    }
  }, 10000);

  it('B-M2 (aider): a 307 to another origin is refused and the body never crosses', async () => {
    let internalHits = 0;
    let internalBody = '';
    const internal = await startMockServer((_req, body, res) => {
      internalHits += 1;
      internalBody = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'pwned' } }] }));
    });
    const srv = await startMockServer((_req, _body, res) => {
      res.writeHead(307, { Location: `${internal.url}/v1/chat/completions` });
      res.end();
    });
    try {
      const upstream: UpstreamConfig = {
        id: 'aider',
        name: 'Aider',
        type: 'harness',
        endpoint: srv.url,
        priority: 100,
        models: ['*'],
        harness: { kind: 'aider' },
      };
      await expect(
        forwardAiderHarness(
          upstream,
          { model: 'test-model', messages: [{ role: 'user', content: 'SECRET-PROMPT-A' }] },
          5000
        )
      ).rejects.toThrow(/Refused cross-origin redirect/);
      expect(internalHits).toBe(0);
      expect(internalBody).not.toContain('SECRET-PROMPT-A');
    } finally {
      await srv.close();
      await internal.close();
    }
  }, 10000);

  it('B-M2 (graphiti): a 307 to another origin is refused and the recall body never crosses', async () => {
    let internalHits = 0;
    const internal = await startMockServer((_req, _body, res) => {
      internalHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ facts: [{ fact: 'internal fact', user_id: 'alice' }] }));
    });
    const srv = await startMockServer((_req, _body, res) => {
      res.writeHead(307, { Location: `${internal.url}/search` });
      res.end();
    });
    try {
      const provider = new GraphitiContextProvider({ endpoint: srv.url });
      const result = await provider.recall('SECRET-QUERY-B', SCOPE, 500);
      expect(result.blocks).toHaveLength(0);
      expect(internalHits).toBe(0);
    } finally {
      await srv.close();
      await internal.close();
    }
  }, 10000);

  it('B-M2 (OpenViking): the API key is sent once, as Authorization only', async () => {
    let seenHeaders: Record<string, string> = {};
    const srv = await startMockServer((req, _body, res) => {
      seenHeaders = req.headers as Record<string, string>;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    try {
      const provider = new OpenVikingContextProvider({ endpoint: srv.url, apiKey: 'ov-key-123' });
      expect(await provider.health()).toBe(true);
      expect(seenHeaders['authorization']).toBe('Bearer ov-key-123');
      // Pre-fix: the same key also rode along as X-Api-Key, and fetch
      // does NOT strip custom headers on cross-origin redirects.
      expect(seenHeaders['x-api-key']).toBeUndefined();
    } finally {
      await srv.close();
    }
  }, 10000);

  it('B-M3: foreign-owned results are dropped, own + unattributed results kept (graphiti)', async () => {
    const srv = await startMockServer((_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          facts: [
            { fact: 'SECRET-OF-BOB: bob ssn 123-45-6789', user_id: 'bob' },
            { fact: 'alice own fact', user_id: 'alice' },
            { fact: 'unattributed fact' },
          ],
        })
      );
    });
    try {
      const provider = new GraphitiContextProvider({ endpoint: srv.url });
      const result = await provider.recall('facts', SCOPE, 500);
      const text = result.blocks.map((b) => b.text).join('\n');
      expect(text).not.toContain('SECRET-OF-BOB');
      expect(text).toContain('alice own fact');
      // Documented deviation (mirrors mem0): entries with no owner
      // field are kept but counted/logged, never silently trusted.
      expect(text).toContain('unattributed fact');
    } finally {
      await srv.close();
    }
  }, 10000);

  it('B-M3: foreign-owned results are dropped (lightrag, cognee, supermemory, knowledge)', async () => {
    const srv = await startMockServer((req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/query') {
        res.end(
          JSON.stringify({
            results: [
              { text: 'SECRET-OF-BOB-LR', user_id: 'bob' },
              { text: 'alice own lightrag', user_id: 'alice' },
            ],
          })
        );
        return;
      }
      if (req.url === '/api/v1/search') {
        res.end(
          JSON.stringify({
            results: [
              { text: 'SECRET-OF-BOB-COG', user_id: 'bob' },
              { text: 'alice own cognee', user_id: 'alice' },
            ],
          })
        );
        return;
      }
      if (req.url === '/v3/search') {
        res.end(
          JSON.stringify({
            results: [
              { chunks: [{ content: 'SECRET-OF-BOB-SM' }], user_id: 'bob' },
              { chunks: [{ content: 'alice own supermemory' }], user_id: 'alice' },
            ],
          })
        );
        return;
      }
      if (req.url === '/api/v1/search/find') {
        res.end(
          JSON.stringify({
            result: {
              memories: [
                { overview: 'SECRET-OF-BOB-KB', user_id: 'bob' },
                { overview: 'alice own doc', user_id: 'alice' },
              ],
            },
          })
        );
        return;
      }
      res.end(JSON.stringify({}));
    });
    try {
      const lr = await new LightRagContextProvider({ endpoint: srv.url }).recall('q', SCOPE, 500);
      expect(lr.blocks.map((b) => b.text).join('\n')).not.toContain('SECRET-OF-BOB-LR');
      expect(lr.blocks.map((b) => b.text).join('\n')).toContain('alice own lightrag');

      const cog = await new CogneeContextProvider({ endpoint: srv.url }).recall('q', SCOPE, 500);
      expect(cog.blocks.map((b) => b.text).join('\n')).not.toContain('SECRET-OF-BOB-COG');
      expect(cog.blocks.map((b) => b.text).join('\n')).toContain('alice own cognee');

      const sm = await new SupermemoryContextProvider({ endpoint: srv.url }).recall('q', SCOPE, 500);
      expect(sm.blocks.map((b) => b.text).join('\n')).not.toContain('SECRET-OF-BOB-SM');
      expect(sm.blocks.map((b) => b.text).join('\n')).toContain('alice own supermemory');

      const kb = await recallKnowledgeBase(
        'q',
        { enabled: true, backend: 'openviking-resources', endpoint: srv.url },
        SCOPE
      );
      expect(kb.blocks.map((b) => b.text).join('\n')).not.toContain('SECRET-OF-BOB-KB');
      expect(kb.blocks.map((b) => b.text).join('\n')).toContain('alice own doc');
    } finally {
      await srv.close();
    }
  }, 10000);

  it('B-M4: a hung memory server does not stall recall past recallTimeoutMs (graphiti)', async () => {
    // Never-responding server: the handler simply never answers.
    const srv = await startMockServer((_req, _body, _res) => {});
    try {
      const provider = new GraphitiContextProvider({ endpoint: srv.url, recallTimeoutMs: 150 });
      const start = Date.now();
      const result = await provider.recall('q', SCOPE, 500);
      expect(result.blocks).toHaveLength(0);
      // Pre-fix: no timeout mechanism exists, so this await never
      // resolves and the test itself times out.
      expect(Date.now() - start).toBeLessThan(3000);
    } finally {
      await srv.close();
    }
  }, 10000);

  it('B-M4: health() and remember() are time-boxed on a hung server (lightrag)', async () => {
    const srv = await startMockServer((_req, _body, _res) => {});
    try {
      const provider = new LightRagContextProvider({ endpoint: srv.url, recallTimeoutMs: 150 });
      const start = Date.now();
      expect(await provider.health()).toBe(false);
      await provider.remember(
        { user: { role: 'user', content: 'hi' }, assistant: 'hello' },
        SCOPE
      );
      expect(Date.now() - start).toBeLessThan(8000);
    } finally {
      await srv.close();
    }
  }, 15000);

  it('B-M4: knowledge recall is time-boxed on a hung server', async () => {
    const srv = await startMockServer((_req, _body, _res) => {});
    try {
      const start = Date.now();
      const result = await recallKnowledgeBase(
        'q',
        { enabled: true, backend: 'lightrag', endpoint: srv.url, recallTimeoutMs: 150 },
        SCOPE
      );
      expect(result.blocks).toHaveLength(0);
      expect(Date.now() - start).toBeLessThan(3000);
    } finally {
      await srv.close();
    }
  }, 10000);

  it('B-M5: spawned agents do not inherit vault/paperclip secrets', () => {
    const keys = [
      'BAO_TOKEN',
      'VAULT_TOKEN',
      'PAPERCLIP_ELUVIX_HMAC_SECRET',
      'ELUVIX_PAPERCLIP_HMAC_SECRET',
      'ELUVIX_PC_TEST_HMAC_SECRET',
      'ELUVIX_TEST_UPSTREAM_SECRET',
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      process.env[k] = `secret-${k}`;
    }
    try {
      const env = buildChildEnv();
      for (const k of keys) {
        // Pre-fix: all six leak through to the child.
        expect(env[k]).toBeUndefined();
      }
      // A caller cannot re-introduce a denied key through `extra`.
      const env2 = buildChildEnv({ BAO_TOKEN: 'smuggled', VAULT_TOKEN: 'smuggled' });
      expect(env2['BAO_TOKEN']).toBeUndefined();
      expect(env2['VAULT_TOKEN']).toBeUndefined();
      // Benign environment still passes through.
      expect(env['PATH']).toBe(process.env['PATH']);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('B-L1: an ACP agent that emits text then crashes does NOT return 200 (non-stream)', async () => {
    const dir = mkTmpDir();
    const script = path.join(dir, 'crash-agent.mjs');
    fs.writeFileSync(
      script,
      `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-sess-1' } }) + '\\n');
  } else if (msg.method === 'session/prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { content: { text: 'PARTIAL-ANSWER-BEFORE-CRASH' } } } }) + '\\n');
    setTimeout(() => process.exit(1), 50);
  }
});
`,
      'utf-8'
    );
    const upstream: UpstreamConfig = {
      id: 'acp',
      name: 'Mock ACP',
      type: 'harness',
      endpoint: 'acp://node',
      priority: 50,
      models: ['harness/acp'],
      harness: {
        kind: 'acp',
        command: process.execPath,
        args: [script],
        approvals: 'auto-deny',
      },
    };
    // Pre-fix: resolves 200 with the partial text as a 'stop' turn.
    await expect(
      forwardAcpHarness(
        upstream,
        { model: 'harness/acp', messages: [{ role: 'user', content: 'hi' }] },
        10000
      )
    ).rejects.toThrow(/exited with code 1/);
  }, 20000);

  it('B-L1: an ACP agent that emits text then crashes does NOT end the stream with [DONE]', async () => {
    const dir = mkTmpDir();
    const script = path.join(dir, 'crash-agent.mjs');
    fs.writeFileSync(
      script,
      `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-sess-1' } }) + '\\n');
  } else if (msg.method === 'session/prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { content: { text: 'PARTIAL-ANSWER-BEFORE-CRASH' } } } }) + '\\n');
    setTimeout(() => process.exit(1), 50);
  }
});
`,
      'utf-8'
    );
    const upstream: UpstreamConfig = {
      id: 'acp',
      name: 'Mock ACP',
      type: 'harness',
      endpoint: 'acp://node',
      priority: 50,
      models: ['harness/acp'],
      harness: {
        kind: 'acp',
        command: process.execPath,
        args: [script],
        approvals: 'auto-deny',
      },
    };
    const res = await forwardAcpHarness(
      upstream,
      { model: 'harness/acp', messages: [{ role: 'user', content: 'hi' }], stream: true },
      10000
    );
    expect(res.status).toBe(200);
    // The stream errors on the crash (no clean close); read it to the
    // error and assert the partial output was never terminated with
    // [DONE].
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let errored = false;
    for (;;) {
      try {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) text += decoder.decode(value, { stream: true });
      } catch {
        errored = true;
        break;
      }
    }
    expect(errored).toBe(true);
    // Pre-fix: the stream ended with 'data: [DONE]', so the memory
    // tee's M-21 gate treated the partial turn as completed.
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(false);
    expect(text).toContain('PARTIAL-ANSWER-BEFORE-CRASH');
  }, 20000);

  it('B-L1: ACP fullText is bounded when one agent delta is enormous', async () => {
    const dir = mkTmpDir();
    const script = path.join(dir, 'huge-agent.mjs');
    fs.writeFileSync(
      script,
      `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n');
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-sess-1' } }) + '\\n');
  } else if (msg.method === 'session/prompt') {
    const big = 'x'.repeat(1500000);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { content: { text: big } } } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { text: '' } }) + '\\n');
  }
});
`,
      'utf-8'
    );
    const upstream: UpstreamConfig = {
      id: 'acp',
      name: 'Mock ACP',
      type: 'harness',
      endpoint: 'acp://node',
      priority: 50,
      models: ['harness/acp'],
      harness: {
        kind: 'acp',
        command: process.execPath,
        args: [script],
        approvals: 'auto-deny',
      },
    };
    const res = await forwardAcpHarness(
      upstream,
      { model: 'harness/acp', messages: [{ role: 'user', content: 'hi' }] },
      10000
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const content = String(json.choices[0].message.content);
    // Pre-fix: the 1.5MB delta was retained verbatim.
    expect(content.length).toBeLessThanOrEqual(1024 * 1024);
  }, 20000);

  it('B-L2: remember() surfaces a server-rejected write instead of swallowing it', async () => {
    const srv = await startMockServer((_req, _body, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const turn = { user: { role: 'user' as const, content: 'hi' }, assistant: 'hello' };
      await new Mem0ContextProvider({ endpoint: srv.url }).remember(turn, SCOPE);
      await new GraphitiContextProvider({ endpoint: srv.url }).remember(turn, SCOPE);
      await new LightRagContextProvider({ endpoint: srv.url }).remember(turn, SCOPE);
      await new CogneeContextProvider({ endpoint: srv.url }).remember(turn, SCOPE);
      await new SupermemoryContextProvider({ endpoint: srv.url }).remember(turn, SCOPE);
      // Pre-fix: no warning at all — the operator believes memory is
      // being stored while the server rejects every write.
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toMatch(/Mem0.*500|500/);
      expect(warned).toMatch(/Graphiti/);
      expect(warned).toMatch(/LightRag/);
      expect(warned).toMatch(/Cognee/);
      expect(warned).toMatch(/Supermemory/);
    } finally {
      warnSpy.mockRestore();
      await srv.close();
    }
  }, 10000);

  it('B-L3 (guard): the usage transform reports the LAST usage frame, not the first', async () => {
    const enc = new TextEncoder();
    const chunks = [
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":50,"total_tokens":60}}\n\n',
      'data: [DONE]\n\n',
    ];
    let i = 0;
    const src = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (i < chunks.length) ctrl.enqueue(enc.encode(chunks[i++]));
        else ctrl.close();
      },
    });
    const seen: Array<{ promptTokens: number; completionTokens: number }> = [];
    const out = transformSseStreamWithUsageCost(src, {
      fallbackModel: 'm',
      fallbackPromptTokens: 10,
      computeCostUsd: (pt, ct) => (pt + ct) * 0.001,
      onUsage: (u) => seen.push(u),
    });
    const reader = out.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0].completionTokens).toBe(50);
    expect(seen[0].promptTokens).toBe(10);
  });

  it('B-L4: a per-request body cannot widen approval beyond the server defaults', async () => {
    const ocServer = createEluvixOpenCodeServer({
      defaultApprovalPolicy: 'auto-approve-readonly',
      defaultAutoApproveTools: ['safe_tool'],
      toolExecutor: async (toolName) => `ran ${toolName}`,
    });
    const { url } = await ocServer.listen(0, '127.0.0.1');
    try {
      const sessionRes = await fetch(`${url}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const session = (await sessionRes.json()) as { id: string };

      // The body asks for a tool the server operator never approved.
      const res = await fetch(`${url}/session/${session.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: 'run danger_tool' }],
          tools: [{ type: 'function', function: { name: 'danger_tool' } }],
          eluvix: {
            approvalPolicy: 'auto-approve-readonly',
            autoApproveTools: ['danger_tool'],
          },
        }),
      });
      const data = (await res.json()) as { parts: Array<{ type: string; tool?: string }> };
      // Pre-fix: danger_tool executed (a 'tool' part, no permission ask).
      expect(data.parts.some((p) => p.type === 'permission_request' && p.tool === 'danger_tool')).toBe(true);
      expect(data.parts.some((p) => p.type === 'tool' && p.tool === 'danger_tool')).toBe(false);

      // A tool inside the server defaults still executes, even when the
      // body also lists an out-of-defaults tool.
      const res2 = await fetch(`${url}/session/${session.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: 'run safe_tool' }],
          tools: [{ type: 'function', function: { name: 'safe_tool' } }],
          eluvix: {
            approvalPolicy: 'auto-approve-readonly',
            autoApproveTools: ['safe_tool', 'danger_tool'],
          },
        }),
      });
      const data2 = (await res2.json()) as { parts: Array<{ type: string; tool?: string }> };
      expect(data2.parts.some((p) => p.type === 'tool' && p.tool === 'safe_tool')).toBe(true);
    } finally {
      await ocServer.close();
    }
  }, 10000);

  it('B-L4: a per-request policy cannot widen a deny-by-default server', async () => {
    const ocServer = createEluvixOpenCodeServer({
      defaultApprovalPolicy: 'never',
      defaultAutoApproveTools: [],
      toolExecutor: async (toolName) => `ran ${toolName}`,
    });
    const { url } = await ocServer.listen(0, '127.0.0.1');
    try {
      const sessionRes = await fetch(`${url}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const session = (await sessionRes.json()) as { id: string };
      const res = await fetch(`${url}/session/${session.id}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: 'run x_tool' }],
          tools: [{ type: 'function', function: { name: 'x_tool' } }],
          eluvix: {
            approvalPolicy: 'auto-approve-readonly',
            autoApproveTools: ['x_tool'],
          },
        }),
      });
      const data = (await res.json()) as { parts: Array<{ type: string; tool?: string }> };
      expect(data.parts.some((p) => p.type === 'permission_request' && p.tool === 'x_tool')).toBe(true);
      expect(data.parts.some((p) => p.type === 'tool' && p.tool === 'x_tool')).toBe(false);
    } finally {
      await ocServer.close();
    }
  }, 10000);

  it('B-L4: permIds are unique even when two messages land in the same millisecond', async () => {
    const ocServer = createEluvixOpenCodeServer({
      defaultApprovalPolicy: 'never',
      defaultAutoApproveTools: [],
    });
    const { url } = await ocServer.listen(0, '127.0.0.1');
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1799999999999);
    try {
      const sessionRes = await fetch(`${url}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const session = (await sessionRes.json()) as { id: string };
      const ids: string[] = [];
      for (let n = 0; n < 2; n++) {
        const res = await fetch(`${url}/session/${session.id}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parts: [{ type: 'text', text: 'run same_tool' }],
            tools: [{ type: 'function', function: { name: 'same_tool' } }],
          }),
        });
        const data = (await res.json()) as { parts: Array<{ type: string; id?: string }> };
        for (const p of data.parts) {
          if (p.type === 'permission_request' && p.id) ids.push(p.id);
        }
      }
      expect(ids).toHaveLength(2);
      // Pre-fix: both ids are `perm_<same-ms>_0` — the second message
      // overwrote the first message's pending permission record.
      expect(new Set(ids).size).toBe(2);
      expect(ocServer.sessions.get(session.id)?.permissions.size).toBe(2);
    } finally {
      nowSpy.mockRestore();
      await ocServer.close();
    }
  }, 10000);

  it('B-L5: remote plaintext endpoints are refused at construction (and by knowledge recall)', async () => {
    const bad = 'http://203.0.113.7:8004';
    expect(() => new GraphitiContextProvider({ endpoint: bad })).toThrow(/https/);
    expect(() => new LightRagContextProvider({ endpoint: bad })).toThrow(/https/);
    expect(() => new CogneeContextProvider({ endpoint: bad })).toThrow(/https/);
    expect(() => new SupermemoryContextProvider({ endpoint: bad })).toThrow(/https/);
    await expect(
      recallKnowledgeBase('q', { enabled: true, backend: 'lightrag', endpoint: bad }, SCOPE)
    ).rejects.toThrow(/https/);
    await expect(
      recallKnowledgeBase('q', { enabled: true, backend: 'openviking-resources', endpoint: bad }, SCOPE)
    ).rejects.toThrow(/https/);
  });

  it('B-L6: readCappedJson refuses a body over the cap and parses one under it', async () => {
    const over = new Response('x'.repeat(101), { headers: { 'Content-Type': 'application/json' } });
    await expect(readCappedJson(over, 100)).rejects.toThrow(/exceeds/);
    const ok = new Response(JSON.stringify({ a: 1 }), { headers: { 'Content-Type': 'application/json' } });
    await expect(readCappedJson(ok, 100)).resolves.toEqual({ a: 1 });
  });

  it('B-L6: a >10MB provider recall body is refused instead of parsed', async () => {
    const big = 'x'.repeat(10 * 1024 * 1024 + 1024);
    const srv = await startMockServer((_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ facts: [{ fact: big, user_id: 'alice' }] }));
    });
    try {
      const provider = new GraphitiContextProvider({ endpoint: srv.url });
      const result = await provider.recall('q', SCOPE, 500);
      // Pre-fix: res.json() parsed the whole 10MB+ body and returned a
      // (token-sliced) block for it.
      expect(result.blocks).toHaveLength(0);
    } finally {
      await srv.close();
    }
  }, 20000);

  it('B-L6: a >10MB a2a response body is refused instead of parsed', async () => {
    const big = 'x'.repeat(10 * 1024 * 1024 + 1024);
    const srv = await startMockServer((_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          result: { status: { message: { parts: [{ type: 'text', text: big }] } } },
        })
      );
    });
    try {
      const upstream: UpstreamConfig = {
        id: 'a2a',
        name: 'A2A',
        type: 'harness',
        endpoint: srv.url,
        priority: 100,
        models: ['*'],
        harness: { kind: 'a2a' },
      };
      await expect(
        forwardA2aHarness(
          upstream,
          { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
          5000
        )
      ).rejects.toThrow(/exceeds/);
    } finally {
      await srv.close();
    }
  }, 20000);
});
