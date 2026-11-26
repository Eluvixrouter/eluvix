/**
 * DesktopRouterServer as an OpenCode model backend (Multica phase a).
 *
 * Spins up the real DesktopRouterServer against a stub OpenAI-compatible
 * upstream and fires OpenCode-shaped chat-completion requests through it:
 * streaming SSE with tools, non-streaming JSON, model discovery, and the
 * auth envelope. A JSON-only upstream with stream:true must still yield
 * SSE (synthesized, mirroring the Next.js gateway) — that is the
 * regression this suite pins.
 *
 * No live network: every hop is loopback, the upstream is a local stub.
 * XDG_CONFIG_HOME / XDG_DATA_HOME point at an isolated mkdtemp dir so the
 * per-install desktop token and SQLite state never touch the real home.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type DesktopRouterServerInstance = {
  updateConfig: (c: Record<string, unknown>) => void;
  start: () => Promise<number>;
  stop: () => Promise<void>;
  getDesktopToken: () => string;
};
type DesktopRouterServerCtor = new (port?: number) => DesktopRouterServerInstance;

let DesktopRouterServer: DesktopRouterServerCtor;
let server: DesktopRouterServerInstance;
let stub: http.Server;
let stubPort: number;
let base: string;
let token: string;
let lastUpstreamBody: Record<string, any> | null = null;
let tmpBase: string;
const savedEnv: Record<string, string | undefined> = {};

const TOOL_DEF = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};

function sseChunk(id: string, created: number, model: string, delta: unknown, finish: string | null, usage?: unknown) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

beforeAll(async () => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-desktop-multica-'));
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    savedEnv[k] = process.env[k];
    process.env[k] = path.join(tmpBase, k === 'XDG_CONFIG_HOME' ? 'config' : 'data');
    fs.mkdirSync(process.env[k] as string, { recursive: true });
  }

  // Stub upstream: 'stub-stream' honors stream:true with SSE, 'stub-json'
  // always answers JSON — even when the client asked to stream.
  stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
        return;
      }
      const body = JSON.parse(raw || '{}') as Record<string, any>;
      lastUpstreamBody = body;
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (body.model === 'stub-stream' && body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const id = 'chatcmpl-stub-1';
        const created = Math.floor(Date.now() / 1000);
        res.write(`data: ${JSON.stringify(sseChunk(id, created, body.model, { role: 'assistant', content: '' }, null))}\n\n`);
        if (hasTools) {
          res.write(`data: ${JSON.stringify(sseChunk(id, created, body.model, { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' } }] }, null))}\n\n`);
        }
        res.write(`data: ${JSON.stringify(sseChunk(id, created, body.model, { content: 'stub streamed reply' }, null))}\n\n`);
        const usage = body.stream_options?.include_usage
          ? { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
          : undefined;
        res.write(`data: ${JSON.stringify(sseChunk(id, created, body.model, {}, hasTools ? 'tool_calls' : 'stop', usage))}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-stub-2',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'stub json reply' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
  const addr = stub.address();
  if (!addr || typeof addr === 'string') throw new Error('stub failed to bind');
  stubPort = addr.port;

  // Import after the XDG vars are set: the constructor mints the
  // per-install token into the config dir on first run.
  ({ DesktopRouterServer } = (await import('../server.js')) as unknown as {
    DesktopRouterServer: DesktopRouterServerCtor;
  });
  server = new DesktopRouterServer(18101);
  server.updateConfig({
    fallbackStrategy: 'priority',
    upstreams: [{
      id: 'stub',
      name: 'Stub Upstream',
      type: 'openai-compatible',
      endpoint: `http://127.0.0.1:${stubPort}/v1`,
      priority: 1,
      models: ['stub-stream', 'stub-json'],
    }],
  });
  const port = await server.start();
  base = `http://127.0.0.1:${port}`;
  token = server.getDesktopToken();
}, 60000);

afterAll(async () => {
  await server.stop();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra };
}

describe('DesktopRouterServer as an OpenCode model backend', () => {
  it('GET /v1/models lists the configured models plus auto', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map((m) => m.id);
    expect(ids).toContain('stub-stream');
    expect(ids).toContain('stub-json');
    expect(ids).toContain('auto');
  });

  it('GET /v1/models without a token is 401 (negative control: auth is enforced)', async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(401);
  });

  it('GET /v1/models with a wrong token is 401', async () => {
    const res = await fetch(`${base}/v1/models`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('POST /v1/chat/completions streams SSE with tool_calls + usage for an OpenCode-shaped request', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'stub-stream',
        messages: [
          { role: 'system', content: 'You are a coding agent.' },
          { role: 'user', content: 'Read src/index.ts and summarize it.' },
        ],
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.2,
        max_tokens: 512,
        tools: [TOOL_DEF],
        tool_choice: 'auto',
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') || '').toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: [DONE]');
    expect(text).toContain('read_file');
    expect(text).toContain('"usage"');
    // The upstream saw the exact OpenCode-shaped fields.
    expect(lastUpstreamBody?.tools).toHaveLength(1);
    expect(lastUpstreamBody?.stream).toBe(true);
    expect(lastUpstreamBody?.stream_options?.include_usage).toBe(true);
    expect(res.headers.get('x-eluvix-upstream')).toContain('stub');
  });

  it('POST /v1/chat/completions answers non-streaming JSON', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'stub-json',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    expect(body.choices[0].message.content).toBe('stub json reply');
    expect(body.usage.total_tokens).toBe(14);
  });

  it('POST stream:true against a JSON-only upstream still returns SSE (synthesized, gateway parity)', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'stub-json',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') || '').toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('stub json reply');
    expect(text).toContain('data: [DONE]');
  });

  it('POST /v1/chat/completions without a token is 401 (negative control)', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'stub-stream',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(401);
  });

  it('POST an unknown model returns an error envelope, not a 200', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'no-such-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/no-such-model/i);
  });
});
