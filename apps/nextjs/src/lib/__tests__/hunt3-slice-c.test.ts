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

describe('hunt3 slice C regressions: C-M4 bifrost mode, C-M5 observability redaction', () => {  it('C-M5: redactConfigForApi strips observability secrets but keeps configured flags', async () => {
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

describe('hunt3 slice C regressions: C-M6 health probe, C-M8 eval override, C-L1 metrics, C-L2 observability, C-L3 docker gate, C-L5 auth status, C-L6 layouts', () => {
  let core: typeof import('@eluvix/router-core');
  let libRouter: typeof import('@/lib/router');

  function req(url: string, init: { key?: string; bearer?: string; body?: any; method?: string } = {}) {
    const headers = new Headers();
    if (init.key) headers.set('authorization', `Bearer ${init.key}`);
    if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return new Request(`http://localhost:3000${url}`, {
      method: init.method || 'POST',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  }

  beforeAll(async () => {
    process.env.ADMIN_PASSWORD = 'hunt3-slice-c-admin-pw';
    delete process.env.LEGACY_ADMIN_PASSWORD;
    core = await import('@eluvix/router-core');
    libRouter = await import('@/lib/router');
    // Seed a config with the Paperclip base URL the health tests probe.
    libRouter.saveConfig({
      strategy: 'lowest-latency',
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 10,
          models: ['llama3.2:latest'],
        },
      ],
      integrations: { paperclip: { paperclipBaseUrl: 'http://127.0.0.1:3100' } },
    } as any);
  }, 60000);

  it('C-M6: a paperclip-scoped key may not probe an arbitrary baseUrl, and the target body is never echoed', async () => {
    const { GET, POST } = await import('../../app/api/v1/paperclip/health/route');
    const stamp = Date.now();
    const paperclipKey = core.createNamedApiKey({
      label: 'hunt3 c-m6 paperclip',
      userId: `hunt3-m6-${stamp}`,
      role: 'operator',
      scopes: ['paperclip'],
    }).key;

    // A different target is refused outright (was: probed + body echoed).
    const refused = await POST(
      req('/api/v1/paperclip/health', {
        key: paperclipKey,
        body: { paperclipBaseUrl: 'http://127.0.0.1:3999' },
      })
    );
    expect(refused.status).toBe(403);

    // The configured target still probes — but the body is not echoed.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'internal-secret-marker' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const ok = await POST(
      req('/api/v1/paperclip/health', {
        key: paperclipKey,
        body: { paperclipBaseUrl: 'http://127.0.0.1:3100' },
      })
    );
    expect(ok.status).toBe(200);
    const okJson: any = await ok.json();
    expect(okJson.ok).toBe(true);
    expect(okJson.details).toBeUndefined();
    expect(JSON.stringify(okJson)).not.toContain('internal-secret-marker');

    // Negative control: an admin caller may still probe a custom target —
    // and still gets no echoed body.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'internal-secret-marker' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const adminOk = await POST(
      req('/api/v1/paperclip/health', {
        bearer: 'hunt3-slice-c-admin-pw',
        body: { paperclipBaseUrl: 'http://127.0.0.1:3999' },
      })
    );
    expect(adminOk.status).toBe(200);
    const adminJson: any = await adminOk.json();
    expect(adminJson.ok).toBe(true);
    expect(adminJson.baseUrl).toBe('http://127.0.0.1:3999');
    expect(adminJson.details).toBeUndefined();
    expect(JSON.stringify(adminJson)).not.toContain('internal-secret-marker');
    vi.restoreAllMocks();
  });

  it('C-M8: a live-eval configOverride that fails validateConfig is rejected in both modes', async () => {
    const { POST } = await import('../../app/api/v1/evals/run/route');
    const stamp = Date.now();
    const operatorKey = core.createNamedApiKey({
      label: 'hunt3 c-m8 operator',
      userId: `hunt3-m8-${stamp}`,
      role: 'operator',
    }).key;
    const badOverride = {
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 10,
          models: ['llama3.2:latest'],
        },
      ],
      // promptGuard.mode 'classifier' was removed (never implemented);
      // validateConfig rejects it on the save path.
      promptGuard: { mode: 'classifier' },
    };
    for (const mode of ['dry-run', 'live']) {
      const res = await POST(
        req('/api/v1/evals/run', { key: operatorKey, body: { mode, configOverride: badOverride } })
      );
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(JSON.stringify(body)).toContain('configOverride failed validation');
    }

    // Negative control: a valid override runs (dry-run is pure explainRoute).
    const goodOverride = {
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 10,
          models: ['llama3.2:latest'],
        },
      ],
    };
    const ok = await POST(
      req('/api/v1/evals/run', { key: operatorKey, body: { mode: 'dry-run', configOverride: goodOverride } })
    );
    expect(ok.status).toBe(200);
  });

  it('C-L1: metrics aggregates are scoped to the caller; only admin sees the global picture', async () => {
    const { GET } = await import('../../app/api/v1/metrics/route');
    const stamp = Date.now();
    const otherUserId = `hunt3-l1-other-${stamp}`;
    core.logRequest({
      model: 'other-users-model-xyz',
      upstream_id: 'local-ollama',
      status: 200,
      duration_ms: 10,
      prompt_tokens: 5,
      completion_tokens: 5,
      cost_usd: 0.5,
      user_id: otherUserId,
    });
    const chatKey = core.createNamedApiKey({
      label: 'hunt3 c-l1 chat-only',
      userId: `hunt3-l1-chat-${stamp}`,
      role: 'operator',
      scopes: ['chat'],
    }).key;
    const scoped = await GET(req('/api/v1/metrics', { key: chatKey, method: 'GET' }));
    expect(scoped.status).toBe(200);
    const scopedText = await scoped.text();
    expect(scopedText).not.toContain('other-users-model-xyz');
    expect(scopedText).not.toContain('eluvix_rolling_24h_spend_usd 0.500000');

    // Negative control: the admin bearer still sees the global aggregates.
    const admin = await GET(req('/api/v1/metrics', { bearer: 'hunt3-slice-c-admin-pw', method: 'GET' }));
    expect(admin.status).toBe(200);
    const adminText = await admin.text();
    expect(adminText).toContain('other-users-model-xyz');
    expect(adminText).toContain('eluvix_rolling_24h_spend_usd 0.500000');
  });

  it('C-L2: non-admin observability callers see no upstream endpoints or model lists', async () => {
    const { GET } = await import('../../app/api/v1/observability/route');
    const stamp = Date.now();
    const operatorKey = core.createNamedApiKey({
      label: 'hunt3 c-l2 operator',
      userId: `hunt3-l2-${stamp}`,
      role: 'operator',
    }).key;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const res = await GET(req('/api/v1/observability', { key: operatorKey, method: 'GET' }));
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(Array.isArray(body.data.upstreams)).toBe(true);
      expect(body.data.upstreams.length).toBeGreaterThan(0);
      for (const u of body.data.upstreams) {
        expect(u.endpoint).toBeUndefined();
        expect(u.models).toBeUndefined();
        expect(u.id).toBeDefined();
        expect(u.status).toBeDefined();
      }

      // Negative control: the admin bearer still sees endpoints + models.
      const admin = await GET(req('/api/v1/observability', { bearer: 'hunt3-slice-c-admin-pw', method: 'GET' }));
      expect(admin.status).toBe(200);
      const adminBody: any = await admin.json();
      expect(adminBody.data.upstreams[0].endpoint).toBe('http://127.0.0.1:11434');
      expect(adminBody.data.upstreams[0].models).toContain('llama3.2:latest');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('C-L3: docker routes refuse credential-less loopback and readonly keys; admin/operator pass the gate', async () => {
    const { isAuthorizedAdminAsync, isAuthorizedAdmin } = await import('@/lib/api-helpers');
    const stamp = Date.now();
    const readonlyKey = core.createNamedApiKey({
      label: 'hunt3 c-l3 readonly',
      userId: `hunt3-l3-ro-${stamp}`,
      role: 'readonly',
    }).key;
    const operatorKey = core.createNamedApiKey({
      label: 'hunt3 c-l3 operator',
      userId: `hunt3-l3-op-${stamp}`,
      role: 'operator',
    }).key;

    // No credentials at all: refused (was: true on loopback in dev).
    expect(
      await isAuthorizedAdminAsync(
        new Request('http://127.0.0.1:3588/api/v1/docker/logs', { headers: { host: '127.0.0.1:3588' } })
      )
    ).toBe(false);
    expect(
      isAuthorizedAdmin(new Request('http://127.0.0.1:3588/api/v1/docker/logs', { headers: { host: '127.0.0.1:3588' } }))
    ).toBe(false);
    // Readonly key: refused.
    expect(
      await isAuthorizedAdminAsync(req('/api/v1/docker/logs', { key: readonlyKey, method: 'GET' }))
    ).toBe(false);
    // Negative controls: admin bearer and operator key pass.
    expect(
      await isAuthorizedAdminAsync(req('/api/v1/docker/logs', { bearer: 'hunt3-slice-c-admin-pw', method: 'GET' }))
    ).toBe(true);
    expect(await isAuthorizedAdminAsync(req('/api/v1/docker/logs', { key: operatorKey, method: 'GET' }))).toBe(
      true
    );

    // Route-level: credential-less loopback GET /api/v1/docker/logs is 401.
    const { GET } = await import('../../app/api/v1/docker/logs/route');
    const res = await GET(new Request('http://127.0.0.1:3588/api/v1/docker/logs?service=router'));
    expect(res.status).toBe(401);
  });

  it('C-L5: unauthenticated auth/status callers do not learn allowLocalBreakGlass', async () => {
    const { GET } = await import('../../app/api/auth/status/route');
    const res = await GET(new Request('http://127.0.0.1:3588/api/auth/status'));
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.data.ldapEnabled).toBe(false);
    expect(body.data.allowLocalBreakGlass).toBeUndefined();
    expect(body.data.baseDn).toBeUndefined();
  });

  it('C-L6: layouts require identity, refuse readonly mutations, and no longer leak the layouts dir', async () => {
    const layoutsRoute = await import('../../app/api/v1/layouts/route');
    const slugRoute = await import('../../app/api/v1/layouts/[slug]/route');
    const stamp = Date.now();
    const readonlyKey = core.createNamedApiKey({
      label: 'hunt3 c-l6 readonly',
      userId: `hunt3-l6-ro-${stamp}`,
      role: 'readonly',
    }).key;
    const operatorKey = core.createNamedApiKey({
      label: 'hunt3 c-l6 operator',
      userId: `hunt3-l6-op-${stamp}`,
      role: 'operator',
    }).key;

    const unauth = await layoutsRoute.GET(new Request('http://127.0.0.1:3588/api/v1/layouts'));
    expect(unauth.status).toBe(401);

    const list = await layoutsRoute.GET(req('/api/v1/layouts', { key: operatorKey, method: 'GET' }));
    expect(list.status).toBe(200);
    const listJson: any = await list.json();
    expect(listJson.layoutsDir).toBeUndefined();

    const slug = `hunt3-c-l6-${stamp}`;
    const denied = await layoutsRoute.POST(
      req('/api/v1/layouts', {
        key: readonlyKey,
        body: { slug, name: 'hunt3', nodes: [], edges: [] },
      })
    );
    expect(denied.status).toBe(403);

    const created = await layoutsRoute.POST(
      req('/api/v1/layouts', {
        key: operatorKey,
        body: { slug, name: 'hunt3', nodes: [], edges: [] },
      })
    );
    expect(created.status).toBe(201);

    const deniedDelete = await slugRoute.DELETE(
      req(`/api/v1/layouts/${slug}`, { key: readonlyKey, method: 'DELETE' }),
      { params: Promise.resolve({ slug }) }
    );
    expect(deniedDelete.status).toBe(403);

    const deleted = await slugRoute.DELETE(
      req(`/api/v1/layouts/${slug}`, { key: operatorKey, method: 'DELETE' }),
      { params: Promise.resolve({ slug }) }
    );
    expect(deleted.status).toBe(200);
  });
});

describe('hunt3 slice C regressions: C-L4 saveConfig failure, C-L15 deep merge', () => {
  let core: typeof import('@eluvix/router-core');
  let libRouter: typeof import('@/lib/router');

  beforeAll(async () => {
    process.env.ADMIN_PASSWORD = 'hunt3-slice-c-admin-pw';
    delete process.env.LEGACY_ADMIN_PASSWORD;
    core = await import('@eluvix/router-core');
    libRouter = await import('@/lib/router');
  }, 60000);

  it('C-L4: saveConfig throws when persistence fails instead of silently diverging', () => {
    const valid = {
      strategy: 'lowest-latency',
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 10,
          models: ['llama3.2:latest'],
        },
      ],
    } as any;
    // Point persistence at an unwritable location (the hunt's repro).
    const prev = process.env.ELUVIX_CONFIG_PATH;
    process.env.ELUVIX_CONFIG_PATH = '/proc/1/eluvix-hunt3-c-config.json';
    try {
      expect(() => libRouter.saveConfig(valid)).toThrow();
    } finally {
      if (prev === undefined) delete process.env.ELUVIX_CONFIG_PATH;
      else process.env.ELUVIX_CONFIG_PATH = prev;
    }
    // Negative control: with a writable path the same config saves fine
    // and memory + disk agree again.
    const saved = libRouter.saveConfig(valid);
    expect(saved.upstreams[0].id).toBe('local-ollama');
  });

  it('C-L15: config POST deep-merges nested sections instead of replacing them wholesale', async () => {
    const { POST } = await import('../../app/api/v1/config/route');
    const stamp = Date.now();
    const operatorKey = core.createNamedApiKey({
      label: 'hunt3 c-l15 operator',
      userId: `hunt3-l15-${stamp}`,
      role: 'operator',
    }).key;
    libRouter.saveConfig({
      strategy: 'lowest-latency',
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 10,
          models: ['llama3.2:latest'],
        },
      ],
      memory: {
        provider: 'builtin',
        cloudMode: 'filter',
        recallBudgetTokens: 1234,
        writeBack: { enabled: true },
      },
    } as any);

    const res = await POST(
      new Request('http://localhost:3000/api/v1/config', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${operatorKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ memory: { provider: 'mem0' } }),
      })
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    // The partial nested object changed only what it named.
    expect(body.config.memory.provider).toBe('mem0');
    expect(body.config.memory.cloudMode).toBe('filter');
    expect(body.config.memory.recallBudgetTokens).toBe(1234);
    expect(body.config.memory.writeBack.enabled).toBe(true);
    // And the stored config agrees (not just the response).
    expect(libRouter.getConfig().memory.cloudMode).toBe('filter');
  });
});
