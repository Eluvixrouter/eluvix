import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createNamedApiKey,
  DESKTOP_TOKEN_HEADER,
  resetVramArbiterStats,
} from '@eluvix/router-core';
import { saveConfig } from '@/lib/router';
import { GET as mcpGet, POST as mcpPost } from '@/app/api/v1/mcp/route';
import { POST as evalsRunPost } from '@/app/api/v1/evals/run/route';
import { GET as metricsGet } from '@/app/api/v1/metrics/route';
import { GET as observabilityGet } from '@/app/api/v1/observability/route';
import { DesktopRouterServer } from '../../../../desktop/src/main/server';

describe('Wave 3 Next.js & Desktop Parity: /api/v1/mcp, /api/v1/evals/run & VRAM Telemetry', () => {
  let tmpDir: string;
  let origConfigHome: string | undefined;
  let origDataHome: string | undefined;
  let origConfigPath: string | undefined;

  beforeEach(() => {
    origConfigHome = process.env.XDG_CONFIG_HOME;
    origDataHome = process.env.XDG_DATA_HOME;
    origConfigPath = process.env.ELUVIX_CONFIG_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-wave6-next-'));
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.ELUVIX_CONFIG_PATH = path.join(tmpDir, 'config', 'config.json');
    resetVramArbiterStats();

    saveConfig({
      egressPolicy: 'allow-egress',
      promptGuard: { enabled: true, action: 'block' },
      privacyGuard: { enabled: true, action: 'anonymize', redactionStyle: 'token' },
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 25,
          models: ['qwen2.5:7b', '*'],
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetVramArbiterStats();
    if (origConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origConfigHome;
    if (origDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origDataHome;
    if (origConfigPath === undefined) delete process.env.ELUVIX_CONFIG_PATH;
    else process.env.ELUVIX_CONFIG_PATH = origConfigPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enforces two-layer elx_ auth and x-eluvix-hops loop guard on /api/v1/mcp and scopes memory to caller userId', async () => {
    const aliceKey = createNamedApiKey({ label: 'Alice MCP', userId: 'alice', role: 'operator' });

    // Reject forged elx_ key not present in keys.json
    const forgedRes = await mcpPost(
      new Request('http://localhost:3588/api/v1/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'elx_ForgedNonexistentSecretKeyAbcd',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
    );
    expect(forgedRes.status).toBe(401);

    // Valid elx_ key succeeds on GET discovery and POST tools/call
    const discRes = await mcpGet(
      new Request('http://localhost:3588/api/v1/mcp', {
        headers: { 'x-api-key': aliceKey.key },
      })
    );
    expect(discRes.status).toBe(200);
    const discJson = await discRes.json();
    expect(discJson.protocolVersion).toBe('2025-06-18');
    expect(discJson.tools.some((t: any) => t.name === 'eluvix_explain_route')).toBe(true);

    const explainRpc = await mcpPost(
      new Request('http://localhost:3588/api/v1/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aliceKey.key}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 42,
          method: 'tools/call',
          params: {
            name: 'eluvix_explain_route',
            arguments: { prompt: 'Write a quick bash alias.' },
          },
        }),
      })
    );
    expect(explainRpc.status).toBe(200);
    expect(explainRpc.headers.get('x-eluvix-hops')).toBe('1');
    const explainBody = await explainRpc.json();
    expect(JSON.parse(explainBody.result.content[0].text).chosenUpstreamId).toBe('local-ollama');

    // Block x-eluvix-hops >= 2 at HTTP gateway
    const loopRes = await mcpPost(
      new Request('http://localhost:3588/api/v1/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': aliceKey.key,
          'x-eluvix-hops': '2',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }),
      })
    );
    expect(loopRes.status).toBe(429);
  });

  it('runs /api/v1/evals/run against configOverride, blocks SSRF IMDS overrides, enforces readonly RBAC, and exposes VRAM metrics', async () => {
    const opKey = createNamedApiKey({ label: 'Operator', userId: 'op', role: 'operator' });
    const roKey = createNamedApiKey({ label: 'Auditor', userId: 'auditor', role: 'readonly' });

    // Dry-run succeeds for both operator and readonly
    const dryRes = await evalsRunPost(
      new Request('http://localhost:3588/api/v1/evals/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': roKey.key,
        },
        body: JSON.stringify({
          suiteId: 'sovereign-safety-and-tiering',
          mode: 'dry-run',
        }),
      })
    );
    expect(dryRes.status).toBe(200);
    expect(dryRes.headers.get('x-eluvix-eval-passed')).toBe('true');

    // Readonly caller is forbidden from executing live network evals
    const roLiveRes = await evalsRunPost(
      new Request('http://localhost:3588/api/v1/evals/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': roKey.key,
        },
        body: JSON.stringify({
          suiteId: 'sovereign-safety-and-tiering',
          mode: 'live',
        }),
      })
    );
    expect(roLiveRes.status).toBe(403);

    // SSRF guard blocks cloud metadata IMDS inside configOverride.upstreams
    const ssrfRes = await evalsRunPost(
      new Request('http://localhost:3588/api/v1/evals/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opKey.key}`,
        },
        body: JSON.stringify({
          suiteId: 'sovereign-safety-and-tiering',
          mode: 'dry-run',
          configOverride: {
            upstreams: [
              {
                id: 'imds-evil',
                name: 'Evil',
                type: 'openai-compatible',
                endpoint: 'http://169.254.169.254/latest/meta-data',
                priority: 10,
                models: ['*'],
              },
            ],
          },
        }),
      })
    );
    expect(ssrfRes.status).toBe(400);

    // Metrics & Observability expose VRAM Arbiter counters
    const metricsRes = await metricsGet(
      new Request('http://localhost:3588/api/v1/metrics', {
        headers: { 'x-api-key': opKey.key },
      })
    );
    expect(metricsRes.status).toBe(200);
    const promText = await metricsRes.text();
    expect(promText).toContain('eluvix_vram_evictions_total{engine="ollama"}');
    expect(promText).toContain('eluvix_vram_active_workloads{workload="llm"}');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const obsRes = await observabilityGet(
      new Request('http://localhost:3588/api/v1/observability', {
        headers: { Authorization: `Bearer ${opKey.key}` },
      })
    );
    expect(obsRes.status).toBe(200);
    const obsJson = await obsRes.json();
    expect(obsJson.data.vramArbiter).toBeDefined();
    expect(Array.isArray(obsJson.data.banditArms)).toBe(true);
  });

  it('maintains DesktopRouterServer parity on /v1/mcp and /v1/evals/run with per-install token auth', async () => {
    // DesktopRouterServer takes only a port: the guarded local-only config
    // goes through updateConfig, the supported injection path (the old
    // two-argument construction never existed — it typechecked nowhere
    // because vitest does not typecheck, and the object was silently
    // dropped at runtime).
    const desktop = new DesktopRouterServer(0);
    desktop.updateConfig({
      egressPolicy: 'local-only',
      promptGuard: { enabled: true, action: 'block' },
      privacyGuard: { enabled: true, action: 'anonymize', redactionStyle: 'token' },
      upstreams: [
        {
          id: 'desktop-ollama',
          name: 'Desktop Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 20,
          models: ['*'],
        },
      ],
    });
    const token = desktop.getDesktopToken();
    const server = http.createServer((req, res) => (desktop as any).handleRequest(req, res));
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    try {
      const mcpRes = await fetch(`http://127.0.0.1:${port}/v1/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [DESKTOP_TOKEN_HEADER]: token,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(mcpRes.status).toBe(200);
      const mcpJson = await mcpRes.json();
      expect(mcpJson.result.tools.length).toBeGreaterThanOrEqual(7);

      const evalRes = await fetch(`http://127.0.0.1:${port}/v1/evals/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [DESKTOP_TOKEN_HEADER]: token,
        },
        body: JSON.stringify({
          suiteId: 'sovereign-safety-and-tiering',
          mode: 'dry-run',
        }),
      });
      expect(evalRes.status).toBe(200);
      const evalJson = await evalRes.json();
      expect(evalJson.passed).toBe(true);
    } finally {
      await desktop.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
