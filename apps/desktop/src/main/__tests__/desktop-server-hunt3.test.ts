/**
 * Hunt-3 slice C desktop regressions (C-M9, C-M10, C-L16, C-L17, C-L18,
 * C-L21, C-L22, C-L23).
 *
 * Spins up the real DesktopRouterServer against a stub OpenAI-compatible
 * upstream and fires HTTP requests through it with the chat token, the
 * admin token, and no token. XDG_CONFIG_HOME / XDG_DATA_HOME point at an
 * isolated mkdtemp dir so the per-install tokens and SQLite state never
 * touch the real home. No live network: every hop is loopback.
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
  getDesktopAdminToken: () => string;
  on: (event: string, listener: (e: any) => void) => void;
};
type DesktopRouterServerCtor = new (port?: number) => DesktopRouterServerInstance;

let DesktopRouterServer: DesktopRouterServerCtor;
let isDesktopAdminRoute: (pathname: string, method: string) => boolean;
let saveChatMessage: (sessionId: string, role: string, content: any, userId?: string) => void;
let server: DesktopRouterServerInstance;
let stub: http.Server;
let stubPort: number;
let base: string;
let chatToken: string;
let adminToken: string;
let tmpBase: string;
const savedEnv: Record<string, string | undefined> = {};
const loggedEvents: any[] = [];

beforeAll(async () => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-desktop-hunt3-'));
  for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    savedEnv[k] = process.env[k];
    process.env[k] = path.join(tmpBase, k === 'XDG_CONFIG_HOME' ? 'config' : 'data');
    fs.mkdirSync(process.env[k] as string, { recursive: true });
  }

  // Stub upstream: 'stub-json' always answers JSON; 'stub-fail' answers 500.
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
      if (body.model === 'stub-fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub upstream exploded', type: 'api_error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-stub-3',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'stub json reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
  const addr = stub.address();
  if (!addr || typeof addr === 'string') throw new Error('stub failed to bind');
  stubPort = addr.port;

  // Import after the XDG vars are set: the constructor mints both
  // per-install tokens into the config dir on first run.
  ({ DesktopRouterServer, isDesktopAdminRoute } = (await import('../server.js')) as unknown as {
    DesktopRouterServer: DesktopRouterServerCtor;
    isDesktopAdminRoute: (pathname: string, method: string) => boolean;
  });
  ({ saveChatMessage } = (await import('@eluvix/router-core')) as unknown as {
    saveChatMessage: (sessionId: string, role: string, content: any, userId?: string) => void;
  });
  server = new DesktopRouterServer(18102);
  server.updateConfig({
    fallbackStrategy: 'priority',
    upstreams: [{
      id: 'stub',
      name: 'Stub Upstream',
      type: 'openai-compatible',
      endpoint: `http://127.0.0.1:${stubPort}/v1`,
      priority: 1,
      models: ['stub-json', 'stub-fail'],
    }],
  });
  server.on('request-logged', (e) => loggedEvents.push(e));
  const port = await server.start();
  base = `http://127.0.0.1:${port}`;
  chatToken = server.getDesktopToken();
  adminToken = server.getDesktopAdminToken();
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

function chatHeaders() {
  return { Authorization: `Bearer ${chatToken}`, 'Content-Type': 'application/json' };
}

function adminHeaders() {
  return { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
}

describe('hunt3 slice C desktop: C-M9 token split', () => {
  it('mints two distinct tokens in two 0600 files', () => {
    expect(chatToken).toBeTruthy();
    expect(adminToken).toBeTruthy();
    expect(adminToken).not.toBe(chatToken);
    const configDir = path.join(tmpBase, 'config', 'eluvix');
    for (const name of ['desktop-token', 'desktop-admin-token']) {
      const file = path.join(configDir, name);
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(path.join(configDir, 'desktop-token'), 'utf8').trim()).toBe(chatToken);
    expect(fs.readFileSync(path.join(configDir, 'desktop-admin-token'), 'utf8').trim()).toBe(adminToken);
  });

  it('isDesktopAdminRoute: chat routes are open to the chat token, everything else is admin', () => {
    expect(isDesktopAdminRoute('/v1/chat/completions', 'POST')).toBe(false);
    expect(isDesktopAdminRoute('/v1/models', 'GET')).toBe(false);
    expect(isDesktopAdminRoute('/v1/messages', 'POST')).toBe(false);
    expect(isDesktopAdminRoute('/v1/embeddings', 'POST')).toBe(false);
    expect(isDesktopAdminRoute('/v1/paperclip/whoami', 'GET')).toBe(false);
    expect(isDesktopAdminRoute('/api/config', 'GET')).toBe(true);
    expect(isDesktopAdminRoute('/api/config', 'POST')).toBe(true);
    expect(isDesktopAdminRoute('/api/provider/status', 'GET')).toBe(true);
    expect(isDesktopAdminRoute('/v1/keys', 'GET')).toBe(true);
    expect(isDesktopAdminRoute('/v1/export', 'GET')).toBe(true);
    expect(isDesktopAdminRoute('/v1/webhooks', 'GET')).toBe(true);
    expect(isDesktopAdminRoute('/v1/mcp', 'POST')).toBe(true);
    expect(isDesktopAdminRoute('/v1/evals/run', 'POST')).toBe(true);
    expect(isDesktopAdminRoute('/v1/unknown-route', 'GET')).toBe(true);
  });

  it('chat token gets 403 on admin routes, admin token gets 200', async () => {
    for (const [path, method] of [
      ['/api/config', 'GET'],
      ['/api/provider/status', 'GET'],
      ['/v1/export?format=chat', 'GET'],
    ] as const) {
      const denied = await fetch(`${base}${path}`, { method, headers: chatHeaders() });
      expect(denied.status).toBe(403);
      const allowed = await fetch(`${base}${path}`, { method, headers: adminHeaders() });
      expect(allowed.status).toBe(200);
    }
  });

  it('chat token still works on inference routes; admin token works there too', async () => {
    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({ model: 'stub-json', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    expect(chat.status).toBe(200);
    const admin = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ model: 'stub-json', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    expect(admin.status).toBe(200);
    const models = await fetch(`${base}/v1/models`, { headers: chatHeaders() });
    expect(models.status).toBe(200);
  });

  it('no token is still 401', async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(401);
  });
});

describe('hunt3 slice C desktop: C-M10 provider settings redaction', () => {
  it('provider status/config never return node_token, only node_token_configured', async () => {
    // Store a token first, via the admin-only config route.
    const saved = await fetch(`${base}/api/provider/config`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ nodeToken: 'blm_test_token_value' }),
    });
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as any;
    expect(JSON.stringify(savedBody)).not.toContain('blm_test_token_value');
    expect(savedBody.settings.node_token_configured).toBe(true);
    expect('node_token' in (savedBody.settings ?? {})).toBe(false);

    const status = await fetch(`${base}/api/provider/status`, { headers: adminHeaders() });
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as any;
    expect(JSON.stringify(statusBody)).not.toContain('blm_test_token_value');
    expect(statusBody.settings.node_token_configured).toBe(true);
    expect('node_token' in (statusBody.settings ?? {})).toBe(false);
  });
});

describe('hunt3 slice C desktop: C-L18 config validation + deep merge', () => {
  it('rejects a [null] upstream and a non-numeric priority with 400', async () => {
    const nullUpstream = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ upstreams: [null] }),
    });
    expect(nullUpstream.status).toBe(400);

    const badPriority = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        upstreams: [{
          id: 'x', name: 'X', type: 'ollama', endpoint: 'http://localhost:11434',
          priority: 'high', models: [],
        }],
      }),
    });
    expect(badPriority.status).toBe(400);

    const unknownField = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        upstreams: [{
          id: 'x', name: 'X', type: 'ollama', endpoint: 'http://localhost:11434',
          priority: 1, models: [], typoField: true,
        }],
      }),
    });
    expect(unknownField.status).toBe(400);
  });

  it('deep-merges nested sections instead of replacing them wholesale', async () => {
    const first = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ memory: { provider: 'builtin', cloudMode: 'filter' } }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ memory: { provider: 'mem0' } }),
    });
    expect(second.status).toBe(200);
    const cfg = await fetch(`${base}/api/config`, { headers: adminHeaders() });
    const body = (await cfg.json()) as any;
    expect(body.memory.provider).toBe('mem0');
    expect(body.memory.cloudMode).toBe('filter');
  });
});

describe('hunt3 slice C desktop: C-L21 export cap, C-L22 JSON + failure log', () => {
  it('chat export honors limit like sft/dpo (default 1000, max 5000)', async () => {
    for (const session of ['hunt3-a', 'hunt3-b', 'hunt3-c']) {
      saveChatMessage(session, 'user', 'hello', 'default');
      saveChatMessage(session, 'assistant', 'hi', 'default');
    }
    const limited = await fetch(`${base}/v1/export?format=chat&limit=2`, { headers: adminHeaders() });
    expect(limited.status).toBe(200);
    const limitedLines = (await limited.text()).split('\n').filter(Boolean);
    expect(limitedLines).toHaveLength(2);
    const one = await fetch(`${base}/v1/export?format=chat&limit=1`, { headers: adminHeaders() });
    expect((await one.text()).split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('malformed JSON on config POST is a 400, not a 500', async () => {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('a failed chat still emits a request log with an error status', async () => {
    const before = loggedEvents.length;
    // Unknown model: no upstream can serve it, so routeChatCompletion throws.
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }], stream: false }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const fresh = loggedEvents.slice(before);
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh[0].status).toBeGreaterThanOrEqual(400);
    expect(fresh[0].model).toBe('no-such-model');
  });
});

describe('hunt3 slice C desktop: C-L16 renderer escaping, C-L17 CSP, C-L23 sandbox', () => {
  it('C-L16: renderer escapes priority and job numerics before innerHTML', () => {
    const appJs = fs.readFileSync(path.resolve(__dirname, '../../renderer/app.js'), 'utf8');
    expect(appJs).toContain('value="${escapeHtml(String(upstream.priority))}"');
    expect(appJs).toContain('${escapeHtml(String(tokens))}');
    expect(appJs).toContain('${escapeHtml(String(j.duration_ms))}ms');
    expect(appJs).toContain('+$${escapeHtml(earned)}');
  });

  it('C-L17: CSP connect-src includes https loopback origins', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../../renderer/index.html'), 'utf8');
    expect(html).toContain('https://127.0.0.1:*');
    expect(html).toContain('https://localhost:*');
  });

  it('C-L23: BrowserWindow is sandboxed; preload uses only contextBridge/ipcRenderer', () => {
    const indexTs = fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8');
    expect(indexTs).toMatch(/webPreferences:\s*\{[^}]*sandbox:\s*true/s);
    const preload = fs.readFileSync(path.resolve(__dirname, '../preload.ts'), 'utf8');
    expect(preload).toContain("from 'electron'");
    expect(preload).toMatch(/import\s*\{\s*contextBridge,\s*ipcRenderer\s*\}\s*from\s*'electron'/);
    expect(preload).not.toContain('node:');
  });
});
