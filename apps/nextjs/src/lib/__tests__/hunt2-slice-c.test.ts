import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * Regression tests for the Eluvix deep-dive bug hunt (2026-11-04), Slice C
 * (Next.js + desktop): M-C1, M-C2, M-C3 (in orchestrator.test.ts), L-C1,
 * L-C2, L-C3, L-C4. Each guard has a negative control proving the
 * legitimate path still works.
 *
 * Runs against real route handlers with an isolated per-worker XDG tree
 * (see src/test-setup.ts) and real named keys — no route is mocked, only
 * the router's upstream call is stubbed where the test must not touch the
 * network (chat/completions operator pass-through, observability ping).
 */
describe('hunt2 slice C regressions', () => {
  let core: typeof import('@eluvix/router-core');
  let chatRoute: typeof import('../../app/api/v1/chat/route');
  let completionsRoute: typeof import('../../app/api/v1/chat/completions/route');
  let providerConfigRoute: typeof import('../../app/api/v1/provider/config/route');
  let configRoute: typeof import('../../app/api/v1/config/route');
  let authStatusRoute: typeof import('../../app/api/auth/status/route');
  let observabilityRoute: typeof import('../../app/api/v1/observability/route');
  let middleware: typeof import('../../middleware');
  let libRouter: typeof import('@/lib/router');

  const ADMIN_PW = 'hunt2-slice-c-admin-pw';
  let readonlyKey: string;
  let operatorKey: string;
  let operatorUserId: string;

  function req(url: string, init: { key?: string; bearer?: string; body?: any; method?: string } = {}) {
    const headers = new Headers();
    if (init.key) headers.set('authorization', `Bearer ${init.key}`);
    if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return new Request(`http://localhost:3000${url}`, {
      method: init.method || 'POST',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    });
  }

  function getReq(url: string, init: { key?: string; bearer?: string } = {}) {
    const headers = new Headers();
    if (init.key) headers.set('authorization', `Bearer ${init.key}`);
    if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
    return new Request(`http://localhost:3000${url}`, { method: 'GET', headers });
  }

  beforeAll(async () => {
    process.env.ADMIN_PASSWORD = ADMIN_PW;
    delete process.env.LEGACY_ADMIN_PASSWORD;
    core = await import('@eluvix/router-core');
    chatRoute = await import('../../app/api/v1/chat/route');
    completionsRoute = await import('../../app/api/v1/chat/completions/route');
    providerConfigRoute = await import('../../app/api/v1/provider/config/route');
    configRoute = await import('../../app/api/v1/config/route');
    authStatusRoute = await import('../../app/api/auth/status/route');
    observabilityRoute = await import('../../app/api/v1/observability/route');
    middleware = await import('../../middleware');
    libRouter = await import('@/lib/router');

    const stamp = Date.now();
    operatorUserId = `hunt2-op-${stamp}`;
    readonlyKey = core.createNamedApiKey({
      label: 'hunt2 readonly',
      userId: `hunt2-ro-${stamp}`,
      role: 'readonly'
    }).key;
    operatorKey = core.createNamedApiKey({
      label: 'hunt2 operator',
      userId: operatorUserId,
      role: 'operator'
    }).key;
  });

  it('M-C1: middleware blocklist covers chat routes but not read-only routes', () => {
    expect(middleware.isProtectedMutationPath('/api/v1/chat')).toBe(true);
    expect(middleware.isProtectedMutationPath('/api/v1/chat/completions')).toBe(true);
    expect(middleware.isProtectedMutationPath('/api/v1/memory')).toBe(true);
    // Negative controls: read-mostly routes stay off the mutation list.
    expect(middleware.isProtectedMutationPath('/api/v1/models')).toBe(false);
    expect(middleware.isProtectedMutationPath('/api/v1/route-explain')).toBe(false);
  });

  it('M-C1: readonly elx_ key cannot POST chat; operator key passes the guard', async () => {
    const router = libRouter.getRouter();
    const spy = vi.spyOn(router, 'routeChatCompletion').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    try {
      const blocked = await chatRoute.POST(
        req('/api/v1/chat', {
          key: readonlyKey,
          body: { messages: [{ role: 'user', content: 'hello' }], model: 'auto' }
        })
      );
      expect(blocked.status).toBe(403);
      expect(spy).not.toHaveBeenCalled();

      const allowed = await chatRoute.POST(
        req('/api/v1/chat', {
          key: operatorKey,
          body: { messages: [{ role: 'user', content: 'hello' }], model: 'auto' }
        })
      );
      expect(allowed.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('M-C1: readonly elx_ key cannot POST chat completions; operator key passes', async () => {
    const router = libRouter.getRouter();
    const spy = vi.spyOn(router, 'routeChatCompletion').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    try {
      const blocked = await completionsRoute.POST(
        req('/api/v1/chat/completions', {
          key: readonlyKey,
          body: { messages: [{ role: 'user', content: 'hello' }], model: 'auto' }
        })
      );
      expect(blocked.status).toBe(403);
      const blockedBody = await blocked.json();
      expect(blockedBody.error.code).toBe('forbidden_readonly_user');
      expect(spy).not.toHaveBeenCalled();

      const allowed = await completionsRoute.POST(
        req('/api/v1/chat/completions', {
          key: operatorKey,
          body: { messages: [{ role: 'user', content: 'hello' }], model: 'auto' }
        })
      );
      expect(allowed.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('M-C2: provider config POST redacts node_token for operators, shows it to admins', async () => {
    const asOperator = await providerConfigRoute.POST(
      req('/api/v1/provider/config', {
        key: operatorKey,
        body: { nodeToken: 'hunt2-probe-node-token', nodeName: 'hunt2-node' }
      })
    );
    const operatorBody = await asOperator.json();
    expect(asOperator.status).toBe(200);
    expect(operatorBody.settings.node_token).toBe('[REDACTED]');

    // Negative control: the admin read-back still carries the real token.
    // (The admin POST re-sends the token because updateConfig overwrites
    // nodeToken even when the field is absent — pre-existing agent
    // behavior, not something this fix changes.)
    const asAdmin = await providerConfigRoute.POST(
      req('/api/v1/provider/config', {
        bearer: ADMIN_PW,
        body: { nodeToken: 'hunt2-probe-node-token', nodeName: 'hunt2-node' }
      })
    );
    const adminBody = await asAdmin.json();
    expect(asAdmin.status).toBe(200);
    expect(adminBody.settings.node_token).toBe('hunt2-probe-node-token');
  });

  it('L-C1: partial config POST merges instead of dropping egressPolicy/memory', async () => {
    const full = {
      upstreams: [
        { id: 'hunt2-a', name: 'A', type: 'ollama', endpoint: 'http://localhost:11434', models: ['m1'] }
      ],
      egressPolicy: 'local-only',
      memory: { provider: 'builtin', enabled: false }
    };
    const fullRes = await configRoute.POST(req('/api/v1/config', { bearer: ADMIN_PW, body: full }));
    expect(fullRes.status).toBe(200);

    const partialRes = await configRoute.POST(
      req('/api/v1/config', {
        bearer: ADMIN_PW,
        body: {
          upstreams: [
            { id: 'hunt2-b', name: 'B', type: 'ollama', endpoint: 'http://localhost:11434', models: ['m2'] }
          ]
        }
      })
    );
    expect(partialRes.status).toBe(200);
    const partialBody = await partialRes.json();
    expect(partialBody.config.upstreams.map((u: any) => u.id)).toEqual(['hunt2-b']);
    expect(partialBody.config.egressPolicy).toBe('local-only');
    expect(partialBody.config.memory.provider).toBe('builtin');

    // Negative control: a full POST still replaces (explicit values win).
    const replacedRes = await configRoute.POST(
      req('/api/v1/config', { bearer: ADMIN_PW, body: { ...full, egressPolicy: 'allow-egress' } })
    );
    const replacedBody = await replacedRes.json();
    expect(replacedBody.config.egressPolicy).toBe('allow-egress');
  });

  it('L-C2: unauthenticated auth-status learns only ldapEnabled, never baseDn/break-glass', async () => {
    const anon = await authStatusRoute.GET(getReq('/api/auth/status'));
    const anonBody = await anon.json();
    expect(anon.status).toBe(200);
    expect(anonBody.success).toBe(true);
    expect(typeof anonBody.data.ldapEnabled).toBe('boolean');
    expect('baseDn' in anonBody.data).toBe(false);
    expect('allowLocalBreakGlass' in anonBody.data).toBe(false);
    expect('url' in anonBody.data).toBe(false);

    // Negative control: authenticated admins still see the directory fields.
    const admin = await authStatusRoute.GET(getReq('/api/auth/status', { bearer: ADMIN_PW }));
    const adminBody = await admin.json();
    expect('baseDn' in adminBody.data).toBe(true);
    expect('allowLocalBreakGlass' in adminBody.data).toBe(true);
  });

  it('L-C3: observability DELETE requires admin; operators get 403', async () => {
    const asOperator = await observabilityRoute.DELETE(
      req('/api/v1/observability', { key: operatorKey, method: 'DELETE' })
    );
    expect(asOperator.status).toBe(403);

    const asAdmin = await observabilityRoute.DELETE(
      req('/api/v1/observability', { bearer: ADMIN_PW, method: 'DELETE' })
    );
    expect(asAdmin.status).toBe(200);
    const adminBody = await asAdmin.json();
    expect(adminBody.success).toBe(true);
  });

  it('L-C4: observability health ping is attributed to its caller, not default', async () => {
    const router = libRouter.getRouter();
    const spy = vi.spyOn(router, 'routeChatCompletion').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    try {
      const res = await observabilityRoute.POST(req('/api/v1/observability', { key: operatorKey }));
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls[0][1] as any)?.scope?.userId).toBe(operatorUserId);

      // Negative control: admin bearer callers still resolve to 'default'.
      const adminRes = await observabilityRoute.POST(req('/api/v1/observability', { bearer: ADMIN_PW }));
      expect(adminRes.status).toBe(200);
      expect((spy.mock.calls[1][1] as any)?.scope?.userId).toBe('default');
    } finally {
      spy.mockRestore();
    }
  });
});
