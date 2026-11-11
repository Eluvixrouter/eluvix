import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { NextRequest } from 'next/server';
import type { Node, Edge } from '@xyflow/react';
import {
  createNamedApiKey,
  logRequest,
  DESKTOP_TOKEN_HEADER,
} from '@eluvix/router-core';
import { saveConfig } from '@/lib/router';
import { isBlockedHost } from '@/lib/api-helpers';
import { compileGraph } from '@/lib/orchestration/compiler';
import { decompileConfigToGraph } from '@/lib/orchestration/decompiler';
import { middleware } from '@/middleware';
import { GET as getMetrics } from '@/app/api/v1/metrics/route';
import { DesktopRouterServer } from '../../../../desktop/src/main/server';

describe('Wave 3 — Prometheus /api/v1/metrics, Spend Compiler Round-Trip & Desktop Server Parity', () => {
  let testDir: string;
  const origXdgConfig = process.env.XDG_CONFIG_HOME;
  const origXdgData = process.env.XDG_DATA_HOME;
  const origAdminPwd = process.env.ADMIN_PASSWORD;
  const ADMIN_TOKEN = 'test-wave3-admin-password';

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-wave3-nextjs-'));
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
    process.env.XDG_DATA_HOME = path.join(testDir, 'data');
    process.env.ADMIN_PASSWORD = ADMIN_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origXdgConfig !== undefined) {
      process.env.XDG_CONFIG_HOME = origXdgConfig;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    if (origXdgData !== undefined) {
      process.env.XDG_DATA_HOME = origXdgData;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    if (origAdminPwd !== undefined) {
      process.env.ADMIN_PASSWORD = origAdminPwd;
    } else {
      delete process.env.ADMIN_PASSWORD;
    }
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('allows valid-format Named elx_ API keys through middleware to /api/v1/metrics and serves Prometheus 0.0.4 exposition', async () => {
    const namedKey = createNamedApiKey({
      label: 'Prometheus Scraper',
      origin: 'client',
      userId: 'prom_scraper',
    });

    // 1. Middleware permits elx_ key on /api/v1/metrics
    const mwAllowed = await middleware(
      new NextRequest('http://127.0.0.1:3588/api/v1/metrics', {
        headers: { Authorization: `Bearer ${namedKey.key}` },
      })
    );
    expect(mwAllowed.status).toBe(200);
    expect(mwAllowed.headers.get('x-middleware-next')).toBe('1');

    // 2. Middleware still blocks elx_ key on admin-only /api/v1/config
    const mwBlockedAdmin = await middleware(
      new NextRequest('http://127.0.0.1:3588/api/v1/config', {
        headers: { Authorization: `Bearer ${namedKey.key}` },
      })
    );
    expect(mwBlockedAdmin.status).toBe(401);

    // 3. Configure daily spend cap & seed SQLite request telemetry
    saveConfig({
      strategy: 'cost-complexity',
      switchyard: {
        strategy: 'cost-complexity',
        maxDailySpendUsd: 15.0,
        budgetExhaustedAction: 'prefer-local',
      },
      upstreams: [
        {
          id: 'ramalama-local',
          name: 'Local RamaLama',
          type: 'ramalama',
          endpoint: 'http://localhost:8080',
          priority: 20,
          models: ['qwen2.5-coder:7b'],
        },
        {
          id: 'openai-cloud',
          name: 'OpenAI Cloud',
          type: 'openai-compatible',
          endpoint: 'https://api.openai.com',
          priority: 10,
          costPer1kTokens: 0.01,
          models: ['gpt-4o'],
        },
      ],
    });

    logRequest({
      model: 'gpt-4o',
      upstream_id: 'openai-cloud',
      status: 200,
      duration_ms: 480,
      prompt_tokens: 1200,
      completion_tokens: 600,
      ttft_ms: 140,
      itl_ms: 18.5,
      kv_cache_kb: 256,
      cost_usd: 3.25,
    });

    // 4. Rejects unregistered elx_ key inside GET /api/v1/metrics
    const forgedKey = 'elx_' + 'A'.repeat(32);
    const unauthorizedRes = await getMetrics(
      new Request('http://127.0.0.1:3588/api/v1/metrics', {
        headers: { Authorization: `Bearer ${forgedKey}` },
      })
    );
    expect(unauthorizedRes.status).toBe(401);

    // 5. Serves Prometheus 0.0.4 text format for registered elx_ key
    const promRes = await getMetrics(
      new Request('http://127.0.0.1:3588/api/v1/metrics', {
        headers: { Authorization: `Bearer ${namedKey.key}` },
      })
    );
    expect(promRes.status).toBe(200);
    expect(promRes.headers.get('content-type')).toContain('text/plain; version=0.0.4');

    const promBody = await promRes.text();
    expect(promBody).toContain('# TYPE eluvix_requests_total counter');
    expect(promBody).toContain('eluvix_requests_total{upstream="openai-cloud",model="gpt-4o",status="200"} 1');
    expect(promBody).toContain('eluvix_tokens_total{direction="prompt"} 1200');
    expect(promBody).toContain('eluvix_tokens_total{direction="completion"} 600');
    expect(promBody).toContain(`eluvix_kv_cache_transferred_bytes_total ${256 * 1024}`);
    expect(promBody).toContain('eluvix_rolling_24h_spend_usd 3.250000');
    expect(promBody).toContain('eluvix_daily_spend_cap_usd 15.000000');
    expect(promBody).toContain('eluvix_upstreams_configured_total 2');
    expect(promBody).toContain('eluvix_circuit_breaker_open{upstream="ramalama-local",type="ramalama"} 0');
  });

  it('round-trips maxDailySpendUsd and budgetExhaustedAction cleanly through compileGraph and decompileConfigToGraph', () => {
    const nodes: Node[] = [
      { id: 'in-1', type: 'inputNode', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'sw-1',
        type: 'switchyardNode',
        position: { x: 300, y: 0 },
        data: {
          strategy: 'cost-complexity',
          maxCostPerRequest: 0.05,
          maxDailySpendUsd: 12.5,
          budgetExhaustedAction: 'strict-local',
          mediaIntentRouting: true,
        },
      },
      {
        id: 'rama-1',
        type: 'ramalamaNode',
        position: { x: 650, y: 0 },
        data: {
          endpoint: 'http://localhost:8080',
          modelUri: 'ollama://qwen2.5-coder:7b',
          priority: 20,
        },
      },
    ];
    const edges: Edge[] = [
      { id: 'e1', source: 'in-1', target: 'sw-1' },
      { id: 'e2', source: 'sw-1', sourceHandle: 'tier-1', target: 'rama-1' },
    ];

    const compiled = compileGraph(nodes, edges);
    expect(compiled.rawRouterConfig.switchyard.maxDailySpendUsd).toBe(12.5);
    expect(compiled.rawRouterConfig.switchyard.budgetExhaustedAction).toBe('strict-local');

    const decompiled = decompileConfigToGraph(compiled.rawRouterConfig);
    const swNode = decompiled.nodes.find((n) => n.type === 'switchyardNode');
    expect(swNode).toBeDefined();
    expect(swNode?.data.maxDailySpendUsd).toBe(12.5);
    expect(swNode?.data.budgetExhaustedAction).toBe('strict-local');
  });

  it('delegates Next.js api-helpers isBlockedHost to the unified SSRF guard', () => {
    expect(isBlockedHost('169.254.169.254')).toBe(true);
    expect(isBlockedHost('::ffff:a9fe:a9fe')).toBe(true);
    expect(isBlockedHost('100.100.100.200')).toBe(true);
    expect(isBlockedHost('fd00:ec2::254')).toBe(true);
    expect(isBlockedHost('127.0.0.1')).toBe(true);
    expect(isBlockedHost('metadata.google.internal')).toBe(true);
    expect(isBlockedHost('api.openai.com')).toBe(false);
  });

  it('provides DesktopRouterServer parity: default ramalama/comfyui upstreams, SSRF block on /api/detect-models, /v1/route-explain, and /v1/images/generations', async () => {
    const desktop = new DesktopRouterServer(0);
    const token = desktop.getDesktopToken();
    const cfg = desktop.getConfig();

    expect(cfg.upstreams.some((u) => u.id === 'ramalama' && u.type === 'ramalama')).toBe(true);
    expect(cfg.upstreams.some((u) => u.id === 'comfyui' && u.type === 'comfyui')).toBe(true);

    // Mount handleRequest on an ephemeral plain-HTTP loopback socket to test end-to-end HTTP handling
    const server = http.createServer((req, res) => (desktop as any).handleRequest(req, res));
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });

    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      const headers = {
        'Content-Type': 'application/json',
        [DESKTOP_TOKEN_HEADER]: token,
      };

      // 1. SSRF block on custom probe pointing to AWS/GCP IMDS
      const ssrfRes = await fetch(`${baseUrl}/api/detect-models`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'evil-probe',
          name: 'IMDS Probe',
          type: 'ollama',
          endpoint: 'http://169.254.169.254/latest/meta-data',
          priority: 1,
          models: [],
        }),
      });
      expect(ssrfRes.status).toBe(403);
      const ssrfJson = await ssrfRes.json();
      expect(ssrfJson.code).toBe('ssrf_blocked');

      // 2. Dry-run route simulation via POST /v1/route-explain
      const explainRes = await fetch(`${baseUrl}/v1/route-explain`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'auto',
          messages: [{ role: 'user', content: 'Write a bash one-liner to inspect open sockets.' }],
        }),
      });
      expect(explainRes.status).toBe(200);
      const explainJson = await explainRes.json();
      expect(explainJson.chosenUpstreamId).toBeDefined();
      expect(Array.isArray(explainJson.steps)).toBe(true);

      // 3. Image generation endpoint validation via POST /v1/images/generations
      const badImgRes = await fetch(`${baseUrl}/v1/images/generations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt: '' }),
      });
      expect(badImgRes.status).toBe(400);
      const badImgJson = await badImgRes.json();
      expect(badImgJson.error).toBeDefined();
    } finally {
      await desktop.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
