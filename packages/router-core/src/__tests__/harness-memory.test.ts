import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  Eluvix,
  addMemoryItem,
  clearUserMemories,
  deleteMemoryItem,
  listMemoryItems,
  createNamedApiKey,
  resolveBearerToken,
  revokeNamedApiKey,
  listNamedApiKeys,
  OpenVikingContextProvider
} from '../index.js';

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

describe('Context Providers & Memory Subsystem', () => {
  const testUserA = `test-alice-${Date.now()}`;
  const testUserB = `test-bob-${Date.now()}`;

  beforeEach(() => {
    clearUserMemories(testUserA);
    clearUserMemories(testUserB);
  });

  afterEach(() => {
    clearUserMemories(testUserA);
    clearUserMemories(testUserB);
  });

  it('recalls user-scoped memories from BuiltinContextProvider and injects <eluvix-memory>', async () => {
    addMemoryItem({
      userId: testUserA,
      uri: `viking://user/${testUserA}/memories/pref-1`,
      level: 'L1',
      content: 'Alice prefers Rust and Linux kernel sched_ext development on AMD Ryzen.',
      metadata: { tags: ['rust', 'linux'] }
    });
    addMemoryItem({
      userId: testUserB,
      uri: `viking://user/${testUserB}/memories/pref-2`,
      level: 'L1',
      content: 'Bob prefers Python Django on Windows.',
      metadata: { tags: ['python'] }
    });

    let capturedMessages: any[] = [];
    const mockUpstream = await startMockServer((req, body, res) => {
      const parsed = JSON.parse(body);
      capturedMessages = parsed.messages;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Use Rust with aya/libbpf!' } }],
          usage: { prompt_tokens: 42, completion_tokens: 10, total_tokens: 52 }
        })
      );
    });

    try {
      const router = new Eluvix({
        memory: {
          enabled: true,
          provider: 'builtin',
          recallBudgetTokens: 500,
          writeBack: true
        },
        upstreams: [
          {
            id: 'local-ollama',
            name: 'Local Ollama',
            type: 'ollama',
            endpoint: mockUpstream.url,
            priority: 10,
            models: ['*']
          }
        ]
      });

      const res = await router.routeChatCompletion(
        {
          model: 'auto',
          messages: [{ role: 'user', content: 'What language should I use for my Linux kernel project?' }]
        },
        { scope: { userId: testUserA, origin: 'client' } }
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('x-eluvix-memory')).toContain('builtin:hit');
      expect(capturedMessages[0].role).toBe('system');
      expect(capturedMessages[0].content).toContain('<eluvix-memory>');
      expect(capturedMessages[0].content).toContain('Alice prefers Rust');
      expect(capturedMessages[0].content).not.toContain('Bob prefers Python');

      // Wait briefly for async remember() write-back
      await new Promise((r) => setTimeout(r, 30));
      const aliceMemories = listMemoryItems(testUserA);
      expect(aliceMemories.length).toBeGreaterThanOrEqual(2);
    } finally {
      await mockUpstream.close();
    }
  });

  it('prevents cross-user response cache poisoning when memory is enabled', async () => {
    addMemoryItem({
      userId: testUserA,
      content: 'My secret project codename is Project Hyperion.'
    });
    addMemoryItem({
      userId: testUserB,
      content: 'My secret project codename is Project Obsidian.'
    });

    let callCount = 0;
    const mockUpstream = await startMockServer((req, body, res) => {
      callCount++;
      const parsed = JSON.parse(body);
      const sys = parsed.messages.find((m: any) => m.role === 'system')?.content || '';
      const reply = sys.includes('Hyperion') ? 'Hyperion' : sys.includes('Obsidian') ? 'Obsidian' : 'Unknown';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${callCount}`,
          choices: [{ index: 0, message: { role: 'assistant', content: reply } }]
        })
      );
    });

    try {
      const router = new Eluvix({
        memory: { enabled: true, provider: 'builtin', writeBack: false },
        modelGateway: { caching: { enabled: true, ttlSeconds: 3600 } },
        upstreams: [
          {
            id: 'local-ollama',
            name: 'Local Ollama',
            type: 'ollama',
            endpoint: mockUpstream.url,
            priority: 10,
            models: ['*']
          }
        ]
      });

      const prompt = [{ role: 'user', content: 'What is my secret project codename?' }];
      const resA = await router.routeChatCompletion({ model: 'auto', messages: prompt }, { scope: { userId: testUserA } });
      const dataA = await resA.json();
      expect(dataA.choices[0].message.content).toBe('Hyperion');

      const resB = await router.routeChatCompletion({ model: 'auto', messages: prompt }, { scope: { userId: testUserB } });
      const dataB = await resB.json();
      expect(dataB.choices[0].message.content).toBe('Obsidian');
      expect(resB.headers.get('X-Eluvix-Cache')).toBeNull();
      expect(callCount).toBe(2);
    } finally {
      await mockUpstream.close();
    }
  });

  it('enforces memory-egress guard (filter and strip modes) so recalled memories do not leak to cloud upstreams', async () => {
    addMemoryItem({
      userId: testUserA,
      content: 'Internal architecture note: production database is on 10.42.0.99.'
    });

    const routerFilter = new Eluvix({
      memory: {
        enabled: true,
        provider: 'builtin',
        allowCloudEgress: false,
        cloudMode: 'filter'
      },
      upstreams: [
        {
          id: 'cloud-openai',
          name: 'OpenAI Cloud',
          type: 'openai-compatible',
          endpoint: 'https://api.openai.com/v1',
          priority: 100,
          models: ['*']
        },
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 10,
          models: ['*']
        }
      ]
    });

    const explanation = routerFilter.explainRoute(
      { model: 'auto', messages: [{ role: 'user', content: 'Where is the production database?' }] },
      { scope: { userId: testUserA }, memoryTainted: true }
    );
    expect(explanation.chosenUpstreamId).toBe('local-ollama');
    const egressStep = explanation.steps.find((s) => s.stage === 'memory-egress');
    expect(egressStep?.removed).toContain('cloud-openai');
    expect(egressStep?.kept).toContain('local-ollama');
  });

  it('integrates with OpenViking REST API (/api/v1/search/find, /sessions, /commit) and fails open on error', async () => {
    const requests: Array<{ path: string; body: any }> = [];
    const mockViking = await startMockServer((req, body, res) => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ path: req.url || '', body: parsed });

      if (req.url === '/api/v1/search/find') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            result: {
              memories: [
                {
                  uri: `viking://user/${testUserA}/memories/arch.md`,
                  abstract: 'OpenViking L0/L1 hierarchical context database architecture.',
                  score: 0.94,
                  level: 'L1'
                }
              ]
            }
          })
        );
        return;
      }

      if (req.url?.includes('/messages') || req.url?.includes('/commit')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
    });

    try {
      const provider = new OpenVikingContextProvider({
        enabled: true,
        provider: 'openviking',
        endpoint: mockViking.url,
        autoCommitTurns: 1
      });

      const recall = await provider.recall('What is OpenViking architecture?', { userId: testUserA, origin: 'client' }, 500);
      expect(recall.provider).toBe('openviking');
      expect(recall.blocks).toHaveLength(1);
      expect(recall.blocks[0].uri).toContain(`viking://user/${testUserA}/memories`);
      expect(recall.blocks[0].text).toContain('OpenViking L0/L1');

      await provider.remember(
        {
          user: { role: 'user', content: 'Remember this detail' },
          assistant: 'Stored in OpenViking session'
        },
        { userId: testUserA, sessionId: 'sess-123', origin: 'client' }
      );

      const paths = requests.map((r) => r.path);
      expect(paths).toContain('/api/v1/search/find');
      expect(paths.some((p) => p.includes('/api/v1/sessions/') && p.endsWith('/messages'))).toBe(true);
      expect(paths.some((p) => p.includes('/api/v1/sessions/') && p.endsWith('/commit'))).toBe(true);
    } finally {
      await mockViking.close();
    }
  });
});

describe('Agent Harness Upstreams (TrueForge, opencode, ACP) & Loop Guard', () => {
  it('routes to TrueForge harness via REST + SSE turns and handles tool approval policies', async () => {
    const eventsPosted: any[] = [];
    const mockTrueForge = await startMockServer((req, body, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/sessions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'tf-session-1' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v1/sessions/tf-session-1/turns') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'turn_started', turnId: 'turn-99' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'permission_request', turnId: 'turn-99', requestId: 'perm-1', toolName: 'Read' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'text_delta', delta: 'Analyzed repository ' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'text_delta', delta: 'with TrueForge.' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'turn_complete', usage: { inputTokens: 25, outputTokens: 12 } })}\n\n`);
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/api/v1/sessions/tf-session-1/turns/turn-99/events') {
        eventsPosted.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const router = new Eluvix({
        upstreams: [
          {
            id: 'tf-harness',
            name: 'TrueForge Harness',
            type: 'harness',
            endpoint: mockTrueForge.url,
            priority: 50,
            models: ['harness/trueforge', '*'],
            harness: {
              kind: 'trueforge',
              approvalPolicy: 'read-only',
              // M-4: auto-approval is by explicit allowlist only — a
              // read-only-looking tool name ('Read') is no longer enough.
              autoApproveTools: ['Read'],
              sessionMode: 'per-conversation'
            }
          }
        ]
      });

      const res = await router.routeChatCompletion({
        model: 'harness/trueforge',
        messages: [{ role: 'user', content: 'Inspect the codebase' }]
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('x-eluvix-harness')).toBe('trueforge');
      const json = await res.json();
      expect(json.choices[0].message.content).toBe('Analyzed repository with TrueForge.');
      expect(eventsPosted.length).toBe(1);
      expect(eventsPosted[0].approved).toBe(true);
    } finally {
      await mockTrueForge.close();
    }
  });

  it('routes to ACP (Agent Client Protocol) stdio harness and handles session/update + permissions', async () => {
    const tmpScript = path.join(os.tmpdir(), `mock-acp-agent-${Date.now()}.mjs`);
    fs.writeFileSync(
      tmpScript,
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
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from ACP ' } } }
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'agent!' } } }
    }) + '\\n');
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { stopReason: 'end_turn' }
    }) + '\\n');
  }
});
`,
      'utf-8'
    );

    try {
      const router = new Eluvix({
        upstreams: [
          {
            id: 'acp-agent',
            name: 'Mock ACP Agent',
            type: 'harness',
            endpoint: 'acp://node',
            priority: 50,
            models: ['harness/acp'],
            harness: {
              kind: 'acp',
              command: process.execPath,
              args: [tmpScript],
              approvalPolicy: 'read-only'
            }
          }
        ]
      });

      const res = await router.routeChatCompletion({
        model: 'harness/acp',
        messages: [{ role: 'user', content: 'Ping ACP' }]
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-eluvix-harness')).toBe('acp');
      const data = await res.json();
      expect(data.choices[0].message.content).toBe('Hello from ACP agent!');
    } finally {
      try {
        fs.unlinkSync(tmpScript);
      } catch {}
    }
  });

  it('enforces loop-guard when origin=harness or hops > 0 and rejects hops >= 2', async () => {
    const router = new Eluvix({
      upstreams: [
        {
          id: 'tf-harness',
          name: 'TrueForge Harness',
          type: 'harness',
          endpoint: 'http://127.0.0.1:8790',
          priority: 100,
          models: ['*'],
          harness: { kind: 'trueforge' }
        },
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 10,
          models: ['*']
        }
      ]
    });

    // When origin is 'harness', loop-guard must exclude tf-harness and pick local-ollama
    const explained = router.explainRoute(
      { model: 'auto', messages: [{ role: 'user', content: 'Sub-query from harness' }] },
      { scope: { origin: 'harness' }, hops: 1 }
    );
    expect(explained.chosenUpstreamId).toBe('local-ollama');
    const loopStep = explained.steps.find((s) => s.stage === 'loop-guard');
    expect(loopStep?.removed).toContain('tf-harness');
    expect(loopStep?.kept).toContain('local-ollama');

    // When hops >= 2, routeChatCompletion must throw loop error immediately
    await expect(
      router.routeChatCompletion(
        { model: 'auto', messages: [{ role: 'user', content: 'Recursive loop' }] },
        { hops: 2 }
      )
    ).rejects.toThrow(/Routing loop detected/);
  });

  it('manages named API keys and resolves userId and origin accurately', () => {
    const created = createNamedApiKey({
      name: 'TrueForge Internal Key',
      userId: 'system-harness',
      origin: 'harness'
    });
    expect(created.key).toMatch(/^elx_/);

    const resolved = resolveBearerToken(created.key, 'admin-secret');
    expect(resolved.valid).toBe(true);
    expect(resolved.userId).toBe('system-harness');
    expect(resolved.origin).toBe('harness');

    const adminResolved = resolveBearerToken('admin-secret', 'admin-secret');
    expect(adminResolved.valid).toBe(true);
    expect(adminResolved.isAdmin).toBe(true);

    const keys = listNamedApiKeys();
    expect(keys.some((k) => k.id === created.id)).toBe(true);

    expect(revokeNamedApiKey(created.id)).toBe(true);
    const afterRevoke = resolveBearerToken(created.key, 'admin-secret');
    expect(afterRevoke.valid).toBe(false);
  });

  it('scopes deleteMemoryItem to the owning user when a userId is given (bug hunt finding 2)', () => {
    const owner = `test-delete-owner-${Date.now()}`;
    const other = `test-delete-other-${Date.now()}`;
    const mine = addMemoryItem({
      userId: owner,
      level: 'L1',
      content: 'Owner delete-scope probe'
    });
    expect(mine).not.toBeNull();
    const item = mine!;
    expect(item.id).toBeGreaterThan(0);

    // Another user cannot delete the owner's item by id.
    expect(deleteMemoryItem(item.id, other)).toBe(false);
    expect(listMemoryItems(owner, 50).some(i => i.id === item.id)).toBe(true);

    // The owner can.
    expect(deleteMemoryItem(item.id, owner)).toBe(true);
    expect(listMemoryItems(owner, 50).some(i => i.id === item.id)).toBe(false);

    clearUserMemories(owner);
    clearUserMemories(other);
  });
});
