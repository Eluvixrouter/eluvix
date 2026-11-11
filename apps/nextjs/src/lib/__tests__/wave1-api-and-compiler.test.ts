import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { saveConfig } from '@/lib/router';
import { compileGraph } from '@/lib/orchestration/compiler';
import { GET as getImageView } from '@/app/api/v1/images/view/route';
import { GET as getComfyStatus } from '@/app/api/v1/comfyui/status/route';

describe('Wave 1 — Next.js Middleware, ComfyUI Media Proxy, Status Route & Compiler', () => {
  let testDir: string;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalAdminPwd = process.env.ADMIN_PASSWORD;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `eluvix-wave1-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
    process.env.ADMIN_PASSWORD = 'test-admin-secret-password';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalXdg !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdg;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    if (originalAdminPwd !== undefined) {
      process.env.ADMIN_PASSWORD = originalAdminPwd;
    } else {
      delete process.env.ADMIN_PASSWORD;
    }
    try {
      if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('allows named elx_ API keys through middleware for /api/v1/images/* while blocking /api/secrets/*', async () => {
    const validElxKey = 'elx_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
    const imgGenReq = new NextRequest('http://localhost:3588/api/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${validElxKey}` },
    });
    const imgGenRes = await middleware(imgGenReq);
    expect(imgGenRes.status).toBe(200);

    const imgViewReq = new NextRequest(
      'http://localhost:3588/api/v1/images/view?upstream=comfy-1&filename=out.png',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${validElxKey}` },
      }
    );
    const imgViewRes = await middleware(imgViewReq);
    expect(imgViewRes.status).toBe(200);

    const secretsReq = new NextRequest('http://localhost:3588/api/secrets/list', {
      method: 'GET',
      headers: { Authorization: `Bearer ${validElxKey}` },
    });
    const secretsRes = await middleware(secretsReq);
    expect(secretsRes.status).toBe(401);
  });

  it('enforces SSRF upstream allowlist, blocks path traversal, and streams safe media on GET /api/v1/images/view', async () => {
    saveConfig({
      strategy: 'priority',
      upstreams: [
        {
          id: 'comfy-main',
          name: 'ComfyUI Main',
          type: 'comfyui',
          endpoint: 'http://127.0.0.1:8188',
          priority: 25,
          models: ['*'],
        },
      ],
    });

    // 1. Path traversal rejected with 400
    const traversalRes = await getImageView(
      new Request(
        'http://localhost:3588/api/v1/images/view?upstream=comfy-main&filename=../../etc/passwd'
      )
    );
    expect(traversalRes.status).toBe(400);

    // 2. Unconfigured upstream ID rejected with 404 (prevents arbitrary SSRF)
    const unknownUpstreamRes = await getImageView(
      new Request(
        'http://localhost:3588/api/v1/images/view?upstream=http://169.254.169.254&filename=out.png'
      )
    );
    expect(unknownUpstreamRes.status).toBe(404);

    // 3. Valid configured upstream streams bytes with nosniff + sandbox CSP
    const pngMagic = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(pngMagic, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      })
    );

    const okRes = await getImageView(
      new Request(
        'http://localhost:3588/api/v1/images/view?upstream=comfy-main&filename=eluvix_0001.png&type=output'
      )
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('content-type')).toBe('image/png');
    expect(okRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(okRes.headers.get('content-security-policy')).toContain('sandbox');
    const buf = new Uint8Array(await okRes.arrayBuffer());
    expect(Array.from(buf)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('blocks cloud metadata endpoints and returns live VRAM/queue stats on GET /api/v1/comfyui/status', async () => {
    const metadataRes = await getComfyStatus(
      new Request('http://localhost:3588/api/v1/comfyui/status?endpoint=http://169.254.169.254:8188', {
        headers: { Authorization: 'Bearer test-admin-secret-password' },
      })
    );
    expect(metadataRes.status).toBe(403);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.endsWith('/system_stats')) {
        return new Response(
          JSON.stringify({
            system: { comfyui_version: '0.3.28' },
            devices: [
              {
                name: 'NVIDIA RTX 4090',
                vram_total: 24 * 1024 ** 3,
                vram_free: 18.5 * 1024 ** 3,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/queue')) {
        return new Response(
          JSON.stringify({
            queue_running: [['job-1']],
            queue_pending: [['job-2'], ['job-3']],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('Not found', { status: 404 });
    });

    const okRes = await getComfyStatus(
      new Request('http://localhost:3588/api/v1/comfyui/status?endpoint=http://127.0.0.1:8188', {
        headers: { Authorization: 'Bearer test-admin-secret-password' },
      })
    );
    expect(okRes.status).toBe(200);
    const json = await okRes.json();
    expect(json.online).toBe(true);
    expect(json.queueRunning).toBe(1);
    expect(json.queuePending).toBe(2);
    expect(json.vramFreeGb).toBe(18.5);
    expect(json.vramTotalGb).toBe(24);
  });

  it('compiles gemini-4-carbon in antigravityNode and mediaIntentRouting in switchyardNode', () => {
    const compiled = compileGraph(
      [
        {
          id: 'input-1',
          type: 'inputNode',
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: 'sw-1',
          type: 'switchyardNode',
          position: { x: 200, y: 0 },
          data: {
            strategy: 'cost-complexity',
            mediaIntentRouting: false,
          },
        },
        {
          id: 'agy-carbon',
          type: 'antigravityNode',
          position: { x: 500, y: 0 },
          data: {
            model: 'gemini-4-carbon',
            effort: 'high',
            executionMode: 'cli',
          },
        },
      ] as any,
      [
        { id: 'e1', source: 'input-1', target: 'sw-1' },
        { id: 'e2', source: 'sw-1', sourceHandle: 'tier-3', target: 'agy-carbon' },
      ] as any
    );

    const routerConfig = JSON.parse(compiled.eluvixJson);
    expect(routerConfig.switchyard?.mediaIntentRouting).toBe(false);
    const agyUpstream = routerConfig.upstreams.find((u: any) => u.id === 'agy-carbon');
    expect(agyUpstream).toBeDefined();
    expect(agyUpstream?.models).toContain('gemini-4-carbon');
    expect(agyUpstream?.antigravity?.model).toBe('gemini-4-carbon');
  });
});
