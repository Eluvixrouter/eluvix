import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Regression tests for the Eluvix deep-dive bug hunt #3 (2026-11-23),
 * Slice C (Next.js + desktop). Each guard has a negative control proving
 * the legitimate path still works. Runs against real route handlers with
 * an isolated per-worker XDG tree (see src/test-setup.ts) and real named
 * keys — no route is mocked, only the router's upstream call is stubbed
 * where the test must not touch the network.
 *
 * C-M1: readonly + wrongly-scoped named keys got 200s on embeddings,
 * audio, images and MCP (hunt-2 M-C1 was fixed for chat only). The chat
 * pattern (requiredScope + readonly 403) is now applied to all four,
 * and the prefixes join isProtectedMutationPath.
 */
describe('hunt3 slice C regressions: C-M1 inference-route scoping', () => {
  let core: typeof import('@eluvix/router-core');
  let embeddingsRoute: typeof import('../../app/api/v1/embeddings/route');
  let speechRoute: typeof import('../../app/api/v1/audio/speech/route');
  let transcriptionsRoute: typeof import('../../app/api/v1/audio/transcriptions/route');
  let imagesRoute: typeof import('../../app/api/v1/images/generations/route');
  let mcpRoute: typeof import('../../app/api/v1/mcp/route');
  let middleware: typeof import('../../middleware');
  let libRouter: typeof import('@/lib/router');

  const ADMIN_PW = 'hunt3-slice-c-admin-pw';
  let readonlyKey: string;
  let paperclipKey: string;
  let chatOnlyKey: string;
  let embeddingsKey: string;
  let audioKey: string;
  let imagesKey: string;
  let mcpKey: string;
  let operatorKey: string;

  function req(url: string, init: { key?: string; body?: any; method?: string } = {}) {
    const headers = new Headers();
    if (init.key) headers.set('authorization', `Bearer ${init.key}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return new Request(`http://localhost:3000${url}`, {
      method: init.method || 'POST',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  }

  beforeAll(async () => {
    process.env.ADMIN_PASSWORD = ADMIN_PW;
    delete process.env.LEGACY_ADMIN_PASSWORD;
    core = await import('@eluvix/router-core');
    embeddingsRoute = await import('../../app/api/v1/embeddings/route');
    speechRoute = await import('../../app/api/v1/audio/speech/route');
    transcriptionsRoute = await import('../../app/api/v1/audio/transcriptions/route');
    imagesRoute = await import('../../app/api/v1/images/generations/route');
    mcpRoute = await import('../../app/api/v1/mcp/route');
    middleware = await import('../../middleware');
    libRouter = await import('@/lib/router');

    const stamp = Date.now();
    readonlyKey = core.createNamedApiKey({
      label: 'hunt3 readonly',
      userId: `hunt3-ro-${stamp}`,
      role: 'readonly',
    }).key;
    paperclipKey = core.createNamedApiKey({
      label: 'hunt3 paperclip-only',
      userId: `hunt3-pc-${stamp}`,
      role: 'operator',
      scopes: ['paperclip'],
    }).key;
    chatOnlyKey = core.createNamedApiKey({
      label: 'hunt3 chat-only',
      userId: `hunt3-chat-${stamp}`,
      role: 'operator',
      scopes: ['chat'],
    }).key;
    embeddingsKey = core.createNamedApiKey({
      label: 'hunt3 embeddings',
      userId: `hunt3-emb-${stamp}`,
      role: 'operator',
      scopes: ['embeddings'],
    }).key;
    audioKey = core.createNamedApiKey({
      label: 'hunt3 audio',
      userId: `hunt3-aud-${stamp}`,
      role: 'operator',
      scopes: ['audio'],
    }).key;
    imagesKey = core.createNamedApiKey({
      label: 'hunt3 images',
      userId: `hunt3-img-${stamp}`,
      role: 'operator',
      scopes: ['images'],
    }).key;
    mcpKey = core.createNamedApiKey({
      label: 'hunt3 mcp',
      userId: `hunt3-mcp-${stamp}`,
      role: 'operator',
      scopes: ['mcp'],
    }).key;
    operatorKey = core.createNamedApiKey({
      label: 'hunt3 operator',
      userId: `hunt3-op-${stamp}`,
      role: 'operator',
    }).key;
  }, 60000);

  it('C-M1: middleware blocklist covers the inference routes', () => {
    expect(middleware.isProtectedMutationPath('/api/v1/embeddings')).toBe(true);
    expect(middleware.isProtectedMutationPath('/api/v1/audio/speech')).toBe(true);
    expect(middleware.isProtectedMutationPath('/api/v1/audio/transcriptions')).toBe(true);
    expect(middleware.isProtectedMutationPath('/api/v1/images/generations')).toBe(true);
    expect(middleware.isProtectedMutationPath('/api/v1/mcp')).toBe(true);
    // Negative controls: read-mostly routes stay off the mutation list.
    expect(middleware.isProtectedMutationPath('/api/v1/models')).toBe(false);
    expect(middleware.isProtectedMutationPath('/api/v1/route-explain')).toBe(false);
  });

  it('C-M1: readonly and wrongly-scoped keys get 403 on embeddings; scoped operator passes auth', async () => {
    const router = libRouter.getRouter();
    const spy = vi.spyOn(router, 'routeEmbeddings').mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
    );
    try {
      for (const key of [readonlyKey, paperclipKey, chatOnlyKey]) {
        const blocked = await embeddingsRoute.POST(
          req('/api/v1/embeddings', { key, body: { input: 'hello', model: 'auto' } })
        );
        expect(blocked.status).toBe(403);
      }
      expect(spy).not.toHaveBeenCalled();

      const allowed = await embeddingsRoute.POST(
        req('/api/v1/embeddings', { key: embeddingsKey, body: { input: 'hello', model: 'auto' } })
      );
      expect(allowed.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);

      // Unscoped operator key (no scopes array) still works — scoping only
      // binds keys that declare scopes.
      const unscoped = await embeddingsRoute.POST(
        req('/api/v1/embeddings', { key: operatorKey, body: { input: 'hello', model: 'auto' } })
      );
      expect(unscoped.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('C-M1: readonly and wrongly-scoped keys get 403 on audio speech and transcriptions', async () => {
    const router = libRouter.getRouter();
    const speechSpy = vi.spyOn(router, 'routeAudioSpeech').mockImplementation(
      () =>
        Promise.resolve(
          new Response(new ArrayBuffer(4), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
        )
    );
    try {
      for (const key of [readonlyKey, paperclipKey, chatOnlyKey]) {
        const blocked = await speechRoute.POST(
          req('/api/v1/audio/speech', { key, body: { input: 'hello', model: 'auto' } })
        );
        expect(blocked.status).toBe(403);
      }
      expect(speechSpy).not.toHaveBeenCalled();
      const allowed = await speechRoute.POST(
        req('/api/v1/audio/speech', { key: audioKey, body: { input: 'hello', model: 'auto' } })
      );
      expect(allowed.status).toBe(200);
      expect(speechSpy).toHaveBeenCalledTimes(1);
    } finally {
      speechSpy.mockRestore();
    }

    // Transcriptions: auth precedes multipart parsing, so the 403s need no body.
    for (const key of [readonlyKey, paperclipKey, chatOnlyKey]) {
      const blocked = await transcriptionsRoute.POST(req('/api/v1/audio/transcriptions', { key }));
      expect(blocked.status).toBe(403);
    }
    const transcriptionSpy = vi.spyOn(router, 'routeAudioTranscription').mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ text: 'hello' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
    );
    try {
      const form = new FormData();
      form.append('file', new Blob(['fake-audio'], { type: 'audio/wav' }), 'test.wav');
      form.append('model', 'auto');
      const allowed = await transcriptionsRoute.POST(
        new Request('http://localhost:3000/api/v1/audio/transcriptions', {
          method: 'POST',
          headers: { authorization: `Bearer ${audioKey}` },
          body: form,
        })
      );
      expect(allowed.status).toBe(200);
      expect(transcriptionSpy).toHaveBeenCalledTimes(1);
    } finally {
      transcriptionSpy.mockRestore();
    }
  });

  it('C-M1: readonly and wrongly-scoped keys get 403 on images; scoped operator passes auth', async () => {
    const router = libRouter.getRouter();
    const spy = vi.spyOn(router, 'routeImageGeneration').mockImplementation(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ created: 1, data: [{ url: 'http://127.0.0.1:1/x.png' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
    );
    try {
      for (const key of [readonlyKey, paperclipKey, chatOnlyKey]) {
        const blocked = await imagesRoute.POST(
          req('/api/v1/images/generations', { key, body: { prompt: 'a cat', model: 'auto' } })
        );
        expect(blocked.status).toBe(403);
      }
      expect(spy).not.toHaveBeenCalled();
      const allowed = await imagesRoute.POST(
        req('/api/v1/images/generations', { key: imagesKey, body: { prompt: 'a cat', model: 'auto' } })
      );
      expect(allowed.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('C-M1: readonly and wrongly-scoped keys get 403 on MCP POST; mcp-scoped operator lists tools', async () => {
    const listBody = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    for (const key of [readonlyKey, paperclipKey, chatOnlyKey]) {
      const blocked = await mcpRoute.POST(req('/api/v1/mcp', { key, body: listBody }));
      expect(blocked.status).toBe(403);
    }
    const allowed = await mcpRoute.POST(req('/api/v1/mcp', { key: mcpKey, body: listBody }));
    expect(allowed.status).toBe(200);
    const payload: any = await allowed.json();
    expect(Array.isArray(payload?.result?.tools)).toBe(true);
  });
});

describe('hunt3 slice C regressions: C-M4 bifrost mode, C-M5 observability redaction', () => {
  it('C-M5: redactConfigForApi strips observability secrets but keeps configured flags', async () => {
    const { redactConfigForApi } = await import('@/lib/router');
    const redacted = redactConfigForApi({
      strategy: 'lowest-latency',
      upstreams: [],
      observability: {
        enabled: true,
        exporter: 'langfuse',
        langfusePublicKey: 'pk-lf-public',
        langfuseSecretKey: 'sk-lf-repro-secret-12345',
        headers: {
          Authorization: 'Bearer super-secret-token',
          'X-Tenant': 'tenant-1',
        },
      },
    } as any);
    expect(JSON.stringify(redacted)).not.toContain('sk-lf-repro-secret-12345');
    expect(JSON.stringify(redacted)).not.toContain('super-secret-token');
    expect(redacted.observability.langfuseSecretKeyConfigured).toBe(true);
    expect(redacted.observability.authorizationHeaderConfigured).toBe(true);
    // Negative controls: non-secret observability data survives redaction.
    expect(redacted.observability.langfusePublicKey).toBe('pk-lf-public');
    expect(redacted.observability.headers['X-Tenant']).toBe('tenant-1');
    expect(redacted.observability.enabled).toBe(true);
  });

  it('C-M4: writeDockerRuntimeConfigs writes bifrost.yaml 0600', async () => {
    const { orchestratorManager } = await import('../orchestration/manager');
    // Under vitest, getRuntimeConfigDir() points at a tmpdir sandbox dir,
    // not the repo's docker/runtime-config (see manager.ts).
    const runtimeDir = orchestratorManager.getRuntimeConfigDir();
    const preExisting = new Set(fs.existsSync(runtimeDir) ? fs.readdirSync(runtimeDir) : []);
    const logs: string[] = [];
    try {
      orchestratorManager.writeDockerRuntimeConfigs(
        {
          tier: 'local',
          compiledConfigs: {
            bifrostYaml: 'providers:\n  - id: openai-1\n    api_key: "${ELUVIX_UPSTREAM_API_KEY_OPENAI_1}"\n',
            agentRouterJson: '{}',
            agentGatewayJson: '{}',
          },
        } as any,
        { strategy: 'lowest-latency', upstreams: [] },
        logs
      );
      const bifrostPath = path.join(runtimeDir, 'bifrost.yaml');
      expect(fs.existsSync(bifrostPath)).toBe(true);
      expect(fs.statSync(bifrostPath).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(bifrostPath, 'utf-8')).toContain('ELUVIX_UPSTREAM_API_KEY_OPENAI_1');
    } finally {
      // Remove only the artifacts this test created.
      for (const name of ['eluvix.json', 'bifrost.yaml', 'routing.json', 'gateway.json']) {
        if (!preExisting.has(name)) {
          try {
            fs.unlinkSync(path.join(runtimeDir, name));
          } catch {}
        }
      }
    }
  });
});
