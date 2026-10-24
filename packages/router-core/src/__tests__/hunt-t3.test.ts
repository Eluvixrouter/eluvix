import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  forwardOpencodeHarness,
  forwardTrueForgeHarness,
  forwardAcpHarness,
  forwardHarnessRequest,
  resolveHarnessKind,
  searchMemoryItems,
  addMemoryItem,
  clearUserMemories,
  teeSseStreamForMemory,
  OpenVikingContextProvider,
  BuiltinContextProvider,
  Mem0ContextProvider
} from '../index.js';
import { setBounded, DEFAULT_MAX_CACHE_ENTRIES } from '../bounded-map.js';
import type { UpstreamConfig } from '../index.js';

function startMockServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        handler(req, body, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r()))
      });
    });
  });
}

const MEMORY_SYSTEM = {
  role: 'system' as const,
  content:
    '<eluvix-memory>\nRelevant context recalled from builtin memory:\n[1] (L1) The user\'s codename is Hyperion.\n</eluvix-memory>\n\nYou are a helpful agent.'
};

/** A mock opencode server whose sessions can be dropped to simulate a restart. */
async function startMockOpencode() {
  const state = {
    sessions: new Set<string>(),
    createCount: 0,
    messageBodies: [] as any[],
    restart() {
      state.sessions.clear();
    }
  };
  const server = await startMockServer((req, body, res) => {
    if (req.method === 'POST' && req.url === '/session') {
      state.createCount += 1;
      const id = `oc-session-${state.createCount}`;
      state.sessions.add(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }
    const m = req.url?.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[1]);
      if (!state.sessions.has(id)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      state.messageBodies.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ parts: [{ type: 'text', text: 'agent reply' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { ...server, state };
}

/** A mock TrueForge server whose sessions can be dropped to simulate a restart. */
async function startMockTrueForge() {
  const state = {
    sessions: new Set<string>(),
    createCount: 0,
    turnBodies: [] as any[],
    restart() {
      state.sessions.clear();
    }
  };
  const server = await startMockServer((req, body, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/sessions') {
      state.createCount += 1;
      const id = `tf-session-${state.createCount}`;
      state.sessions.add(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }
    const m = req.url?.match(/^\/api\/v1\/sessions\/([^/]+)\/turns$/);
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[1]);
      if (!state.sessions.has(id)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      state.turnBodies.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'text_delta', delta: 'tf reply' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'turn_complete' })}\n\n`);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { ...server, state };
}

describe('T3 fix 1: harness session caches recover when the server drops the session', () => {
  it('opencode: evicts the dead cached session, creates a fresh one, retries once', async () => {
    const mock = await startMockOpencode();
    const upstream: UpstreamConfig = {
      id: 'oc-wedge',
      name: 'OpenCode Wedge',
      type: 'harness',
      endpoint: mock.url,
      priority: 50,
      models: ['*'],
      harness: { kind: 'opencode', sessionMode: 'per-eluvix-session' }
    };
    const scope = { userId: 'u-wedge', sessionId: 'sess-wedge', origin: 'client' as const };
    const req = { model: 'auto', messages: [{ role: 'user' as const, content: 'hello' }] };
    try {
      const res1 = await forwardOpencodeHarness(upstream, req, 5000, undefined, scope);
      expect(res1.status).toBe(200);
      expect(mock.state.createCount).toBe(1);

      mock.state.restart();

      const res2 = await forwardOpencodeHarness(upstream, req, 5000, undefined, scope);
      expect(res2.status).toBe(200);
      expect(mock.state.createCount).toBe(2);

      // The fresh session is cached again: no third creation.
      const res3 = await forwardOpencodeHarness(upstream, req, 5000, undefined, scope);
      expect(res3.status).toBe(200);
      expect(mock.state.createCount).toBe(2);
    } finally {
      await mock.close();
    }
  });

  it('trueforge: evicts the dead cached session, creates a fresh one, retries once', async () => {
    const mock = await startMockTrueForge();
    const upstream: UpstreamConfig = {
      id: 'tf-wedge',
      name: 'TrueForge Wedge',
      type: 'harness',
      endpoint: mock.url,
      priority: 50,
      models: ['*'],
      harness: { kind: 'trueforge', sessionMode: 'per-eluvix-session' }
    };
    const scope = { userId: 'u-wedge', sessionId: 'sess-wedge', origin: 'client' as const };
    const req = { model: 'auto', messages: [{ role: 'user' as const, content: 'hello' }] };
    try {
      const res1 = await forwardTrueForgeHarness(upstream, req, 5000, undefined, scope);
      expect(res1.status).toBe(200);
      expect(mock.state.createCount).toBe(1);

      mock.state.restart();

      const res2 = await forwardTrueForgeHarness(upstream, req, 5000, undefined, scope);
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.choices[0].message.content).toBe('tf reply');
      expect(mock.state.createCount).toBe(2);

      const res3 = await forwardTrueForgeHarness(upstream, req, 5000, undefined, scope);
      expect(res3.status).toBe(200);
      expect(mock.state.createCount).toBe(2);
    } finally {
      await mock.close();
    }
  });
});

describe('T3 fix 5: harness session caches and turn counters are bounded', () => {
  it('setBounded evicts oldest-first and refreshes recency on re-set', () => {
    const map = new Map<string, number>();
    for (let i = 0; i < 5; i++) setBounded(map, `k${i}`, i, 3);
    expect(map.size).toBe(3);
    expect([...map.keys()]).toEqual(['k2', 'k3', 'k4']);
    setBounded(map, 'k3', 33, 3);
    setBounded(map, 'k5', 5, 3);
    expect(map.size).toBe(3);
    expect(map.has('k2')).toBe(false);
    expect(map.get('k3')).toBe(33);
  });

  it(
    'opencode sessionCache evicts the oldest session beyond the cap',
    async () => {
      const mock = await startMockOpencode();
      const upstream: UpstreamConfig = {
        id: 'oc-bounded',
        name: 'OpenCode Bounded',
        type: 'harness',
        endpoint: mock.url,
        priority: 50,
        models: ['*'],
        harness: { kind: 'opencode', sessionMode: 'per-eluvix-session' }
      };
      const req = { model: 'auto', messages: [{ role: 'user' as const, content: 'hi' }] };
      const total = DEFAULT_MAX_CACHE_ENTRIES + 5;
      try {
        for (let i = 0; i < total; i++) {
          const res = await forwardOpencodeHarness(upstream, req, 5000, undefined, {
            userId: 'u-bounded',
            sessionId: `sess-${i}`,
            origin: 'client'
          });
          expect(res.status).toBe(200);
        }
        expect(mock.state.createCount).toBe(total);

        // Oldest session was evicted -> a new server session is created.
        const againOld = await forwardOpencodeHarness(upstream, req, 5000, undefined, {
          userId: 'u-bounded',
          sessionId: 'sess-0',
          origin: 'client'
        });
        expect(againOld.status).toBe(200);
        expect(mock.state.createCount).toBe(total + 1);

        // Newest session is still cached -> no new creation.
        const againNew = await forwardOpencodeHarness(upstream, req, 5000, undefined, {
          userId: 'u-bounded',
          sessionId: `sess-${total - 1}`,
          origin: 'client'
        });
        expect(againNew.status).toBe(200);
        expect(mock.state.createCount).toBe(total + 1);
      } finally {
        await mock.close();
      }
    },
    60000
  );

  it(
    'OpenViking turnCounts stays bounded across many sessions',
    async () => {
      const mock = await startMockServer((req, body, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
      try {
        const provider = new OpenVikingContextProvider({
          endpoint: mock.url,
          autoCommitTurns: 100000
        });
        const total = DEFAULT_MAX_CACHE_ENTRIES + 5;
        for (let i = 0; i < total; i++) {
          await provider.remember(
            { user: { role: 'user', content: 'note' }, assistant: 'ack' },
            { userId: 'u-ov', sessionId: `ov-sess-${i}`, origin: 'client' }
          );
        }
        const counts = (provider as any).turnCounts as Map<string, number>;
        expect(counts.size).toBe(DEFAULT_MAX_CACHE_ENTRIES);
        expect(counts.has('ov-sess-0')).toBe(false);
        expect(counts.has(`ov-sess-${total - 1}`)).toBe(true);
      } finally {
        await mock.close();
      }
    },
    60000
  );
});

describe('T3 fix 2: forwarders deliver system context, history, and handle tools honestly', () => {
  it('opencode per-request mode folds system (incl. <eluvix-memory>) and history into the prompt', async () => {
    const mock = await startMockOpencode();
    const upstream: UpstreamConfig = {
      id: 'oc-prompt',
      name: 'OpenCode Prompt',
      type: 'harness',
      endpoint: mock.url,
      priority: 50,
      models: ['*'],
      harness: { kind: 'opencode', sessionMode: 'per-request' }
    };
    try {
      const res = await forwardOpencodeHarness(
        upstream,
        {
          model: 'auto',
          messages: [
            MEMORY_SYSTEM,
            { role: 'user', content: 'first question' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second question' }
          ]
        },
        5000,
        undefined,
        { userId: 'u-prompt', origin: 'client' }
      );
      expect(res.status).toBe(200);
      const sent = mock.state.messageBodies[0].parts[0].text as string;
      expect(sent).toContain('<eluvix-memory>');
      expect(sent).toContain('Hyperion');
      expect(sent).toContain('first question');
      expect(sent).toContain('first answer');
      expect(sent).toContain('second question');
    } finally {
      await mock.close();
    }
  });

  it('opencode persistent session: fresh session gets history, cached session gets system + latest only', async () => {
    const mock = await startMockOpencode();
    const upstream: UpstreamConfig = {
      id: 'oc-prompt-session',
      name: 'OpenCode Prompt Session',
      type: 'harness',
      endpoint: mock.url,
      priority: 50,
      models: ['*'],
      harness: { kind: 'opencode', sessionMode: 'per-eluvix-session' }
    };
    const scope = { userId: 'u-ps', sessionId: 'sess-ps', origin: 'client' as const };
    try {
      const res1 = await forwardOpencodeHarness(
        upstream,
        {
          model: 'auto',
          messages: [
            MEMORY_SYSTEM,
            { role: 'user', content: 'earlier question' },
            { role: 'assistant', content: 'earlier answer' },
            { role: 'user', content: 'latest question' }
          ]
        },
        5000,
        undefined,
        scope
      );
      expect(res1.status).toBe(200);
      const firstSent = mock.state.messageBodies[0].parts[0].text as string;
      expect(firstSent).toContain('Hyperion');
      expect(firstSent).toContain('earlier question');

      const res2 = await forwardOpencodeHarness(
        upstream,
        {
          model: 'auto',
          messages: [
            MEMORY_SYSTEM,
            { role: 'user', content: 'earlier question' },
            { role: 'assistant', content: 'earlier answer' },
            { role: 'user', content: 'latest question' },
            { role: 'assistant', content: 'latest answer' },
            { role: 'user', content: 'follow-up question' }
          ]
        },
        5000,
        undefined,
        scope
      );
      expect(res2.status).toBe(200);
      expect(mock.state.createCount).toBe(1);
      const secondSent = mock.state.messageBodies[1].parts[0].text as string;
      // System context (and its memory block) rides on every turn...
      expect(secondSent).toContain('<eluvix-memory>');
      expect(secondSent).toContain('follow-up question');
      // ...but history is not re-sent: the persistent session already holds it.
      expect(secondSent).not.toContain('earlier question');
    } finally {
      await mock.close();
    }
  });

  it('opencode refuses tool-bearing requests instead of silently dropping tools', async () => {
    const mock = await startMockOpencode();
    const upstream: UpstreamConfig = {
      id: 'oc-tools',
      name: 'OpenCode Tools',
      type: 'harness',
      endpoint: mock.url,
      priority: 50,
      models: ['*'],
      harness: { kind: 'opencode' }
    };
    try {
      await expect(
        forwardOpencodeHarness(
          upstream,
          {
            model: 'auto',
            messages: [{ role: 'user', content: 'use a tool' }],
            tools: [{ type: 'function', function: { name: 'lookup' } }]
          },
          5000,
          undefined,
          { userId: 'u-tools', origin: 'client' }
        )
      ).rejects.toThrow(/does not support tool calling/);
      expect(mock.state.messageBodies).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});


function writeFakeAcpAgent(name: string, body: string): string {
  const script = path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mjs`);
  fs.writeFileSync(script, body, 'utf-8');
  return script;
}

const ACP_ECHO_AGENT = `
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
    const promptText = msg.params.prompt.map(p => p.text || '').join('\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PROMPT>>>' + promptText + '<<<' } } }
    }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
  }
});
`;

const ACP_STDERR_FLOOD_AGENT = `
import fs from 'node:fs';
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
    // Synchronously write far more than the OS pipe buffer (~64KB) to
    // stderr. The pipe fd is nonblocking for Node children, so emulate a
    // native blocking writer: retry on EAGAIN until every byte is out.
    // If the parent never drains the pipe, this spins forever and the
    // router-side turn times out — the pre-fix behavior.
    const chunk = Buffer.from('x'.repeat(8192) + '\\n');
    const nap = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 64; i++) {
      let off = 0;
      while (off < chunk.length) {
        try {
          off += fs.writeSync(2, chunk, off, chunk.length - off);
        } catch (e) {
          if (e && e.code === 'EAGAIN') {
            Atomics.wait(nap, 0, 0, 5);
            continue;
          }
          throw e;
        }
      }
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'survived the flood' } } }
    }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
  }
});
`;

describe('T3 fixes 2+3: ACP prompt completeness and stderr draining', () => {
  const scripts: string[] = [];
  afterEach(() => {
    while (scripts.length) {
      try {
        fs.unlinkSync(scripts.pop()!);
      } catch {}
    }
  });

  function acpUpstream(script: string, id: string): UpstreamConfig {
    return {
      id,
      name: 'Mock ACP',
      type: 'harness',
      endpoint: 'acp://node',
      priority: 50,
      models: ['harness/acp'],
      harness: { kind: 'acp', command: process.execPath, args: [script] }
    };
  }

  it('ACP folds system (incl. <eluvix-memory>) and history into the session prompt', async () => {
    const script = writeFakeAcpAgent('mock-acp-echo', ACP_ECHO_AGENT);
    scripts.push(script);
    const res = await forwardAcpHarness(
      acpUpstream(script, 'acp-prompt'),
      {
        model: 'harness/acp',
        messages: [
          MEMORY_SYSTEM,
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'second question' }
        ]
      },
      10000
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const content = json.choices[0].message.content as string;
    expect(content).toContain('<eluvix-memory>');
    expect(content).toContain('Hyperion');
    expect(content).toContain('first question');
    expect(content).toContain('first answer');
    expect(content).toContain('second question');
  });

  it('ACP refuses tool-bearing requests instead of silently dropping tools', async () => {
    const script = writeFakeAcpAgent('mock-acp-tools', ACP_ECHO_AGENT);
    scripts.push(script);
    await expect(
      forwardAcpHarness(
        acpUpstream(script, 'acp-tools'),
        {
          model: 'harness/acp',
          messages: [{ role: 'user', content: 'use a tool' }],
          tools: [{ type: 'function', function: { name: 'lookup' } }]
        },
        10000
      )
    ).rejects.toThrow(/does not support client tool calling/);
  });

  it(
    'ACP completes its turn when the agent floods stderr beyond the pipe buffer',
    async () => {
      const script = writeFakeAcpAgent('mock-acp-flood', ACP_STDERR_FLOOD_AGENT);
      scripts.push(script);
      const res = await forwardAcpHarness(
        acpUpstream(script, 'acp-flood'),
        { model: 'harness/acp', messages: [{ role: 'user', content: 'hi' }] },
        15000
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.choices[0].message.content).toBe('survived the flood');
    },
    20000
  );
});

describe('T3 fix 4: stop-word-only memory searches return nothing', () => {
  const user = `t3-stopwords-${Date.now()}`;
  afterEach(() => clearUserMemories(user));

  it('returns [] for "how are you" even when the store has items', () => {
    addMemoryItem({
      userId: user,
      content: 'The user is migrating the production database to Postgres 16 next week.'
    });
    expect(searchMemoryItems('how are you', user)).toEqual([]);
    expect(searchMemoryItems('what is it', user)).toEqual([]);
    // Positive control: a searchable query still finds the item.
    const hits = searchMemoryItems('production database migration', user);
    expect(hits.length).toBe(1);
    expect(hits[0].content).toContain('Postgres 16');
  });
});

describe('T3 fix 6: stream-tee writes back only completed streams', () => {
  const encoder = new TextEncoder();
  const sseChunk = (content: string) =>
    encoder.encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
    );

  it('calls onComplete with the assembled text when the stream completes', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(sseChunk('Hello '));
        ctrl.enqueue(sseChunk('world'));
        ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
        ctrl.close();
      }
    });
    const completed: string[] = [];
    const teed = teeSseStreamForMemory(source, async (text) => {
      completed.push(text);
    });
    const text = await new Response(teed).text();
    expect(text).toContain('Hello ');
    await new Promise((r) => setTimeout(r, 20));
    expect(completed).toEqual(['Hello world']);
  });

  it('does NOT write back when the consumer cancels mid-stream', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(sseChunk('partial reply that never finishes'));
      }
    });
    const completed: string[] = [];
    const teed = teeSseStreamForMemory(source, async (text) => {
      completed.push(text);
    });
    const reader = teed.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel('client disconnected');
    await new Promise((r) => setTimeout(r, 30));
    expect(completed).toEqual([]);
  });
});

describe('T3 fix 7: harness kind is inferred from the endpoint when the block is absent', () => {
  const scripts: string[] = [];
  afterEach(() => {
    while (scripts.length) {
      try {
        fs.unlinkSync(scripts.pop()!);
      } catch {}
    }
  });

  it('resolveHarnessKind: explicit kind wins; acp:// infers acp; http infers trueforge', () => {
    const base = { id: 'x', name: 'X', type: 'harness' as const, priority: 1, models: ['*'] as string[] };
    expect(
      resolveHarnessKind({ ...base, endpoint: 'acp://goose', harness: { kind: 'opencode' } })
    ).toBe('opencode');
    expect(resolveHarnessKind({ ...base, endpoint: 'acp://goose' })).toBe('acp');
    expect(
      resolveHarnessKind({ ...base, endpoint: 'acp://goose', harness: { approvals: 'auto-deny' } as any })
    ).toBe('acp');
    expect(resolveHarnessKind({ ...base, endpoint: 'https://tf.example.com' })).toBe('trueforge');
    expect(resolveHarnessKind({ ...base, endpoint: 'http://127.0.0.1:8790' })).toBe('trueforge');
  });

  it('an acp:// upstream with no harness.kind dispatches to the ACP forwarder, not TrueForge', async () => {
    const script = writeFakeAcpAgent('mock-acp-dispatch', ACP_ECHO_AGENT);
    scripts.push(script);
    const upstream: UpstreamConfig = {
      id: 'acp-nokind',
      name: 'ACP without kind',
      type: 'harness',
      endpoint: 'acp://node',
      priority: 50,
      models: ['harness/acp'],
      // Harness block present for command/args, but kind deliberately absent.
      harness: { command: process.execPath, args: [script] } as any
    };
    const res = await forwardHarnessRequest(
      upstream,
      { model: 'harness/acp', messages: [{ role: 'user', content: 'ping via dispatch' }] },
      10000
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-harness')).toBe('acp');
    const json = await res.json();
    expect(json.choices[0].message.content).toContain('ping via dispatch');
  });
});

describe('T3 fix 8: dead ContextProvider.isLocal is removed', () => {
  it('no provider exposes isLocal anymore', () => {
    expect('isLocal' in new BuiltinContextProvider()).toBe(false);
    expect('isLocal' in new OpenVikingContextProvider({})).toBe(false);
    expect('isLocal' in new Mem0ContextProvider({})).toBe(false);
  });
});
