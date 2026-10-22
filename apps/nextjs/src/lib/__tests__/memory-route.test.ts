import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

/**
 * Per-user scoping of /api/v1/memory (bug hunt finding 2).
 *
 * The route used to treat any request without an elx_ key as valid and to
 * take the target userId from the query string / body, so anyone who could
 * reach the app could read, delete, or wipe another user's memories. These
 * tests exercise the real route handlers against a throwaway config/data
 * dir: identity comes only from a named key, the admin bearer, or the
 * NextAuth session cookie.
 */
describe('/api/v1/memory per-user scoping', () => {
  let route: typeof import('../../app/api/v1/memory/route');
  let core: typeof import('@eluvix/router-core');
  let encodeJwt: typeof import('next-auth/jwt').encode;

  let aliceKey: string;
  let bobKey: string;
  let aliceItemId: number;
  let bobItemId: number;

  const ALICE = `route-alice-${Date.now()}`;
  const BOB = `route-bob-${Date.now()}`;
  const MARKER = `scoping-probe-${Date.now()}`;

  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function req(url: string, init: { method?: string; key?: string; bearer?: string; cookie?: string; body?: any } = {}) {
    const headers = new Headers();
    if (init.key) headers.set('authorization', `Bearer ${init.key}`);
    if (init.bearer) headers.set('authorization', `Bearer ${init.bearer}`);
    if (init.cookie) headers.set('cookie', init.cookie);
    if (init.body) headers.set('content-type', 'application/json');
    return new Request(`http://localhost:3000${url}`, {
      method: init.method || 'GET',
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined
    });
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-memroute-'));
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL', 'ADMIN_PASSWORD', 'LEGACY_ADMIN_PASSWORD']) {
      savedEnv[name] = process.env[name];
    }
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.NEXTAUTH_SECRET = 'memroute-test-secret';
    process.env.NEXTAUTH_URL = 'http://localhost:3000';
    delete process.env.ADMIN_PASSWORD;
    delete process.env.LEGACY_ADMIN_PASSWORD;

    core = await import('@eluvix/router-core');
    route = await import('../../app/api/v1/memory/route');
    encodeJwt = (await import('next-auth/jwt')).encode;

    aliceKey = core.createNamedApiKey({ label: 'Alice key', userId: ALICE }).key;
    bobKey = core.createNamedApiKey({ label: 'Bob key', userId: BOB }).key;

    const aliceItem = core.addMemoryItem({ userId: ALICE, level: 'L1', content: `${MARKER} alice secret preference` });
    const bobItem = core.addMemoryItem({ userId: BOB, level: 'L1', content: `${MARKER} bob secret preference` });
    aliceItemId = aliceItem!.id;
    bobItemId = bobItem!.id;
  });

  afterAll(() => {
    try {
      core?.clearUserMemories(ALICE);
      core?.clearUserMemories(BOB);
    } catch {}
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('rejects requests with no identity at all', async () => {
    const res = await route.GET(req('/api/v1/memory'));
    expect(res.status).toBe(401);
  });

  it("rejects a keyless request that names another user's id — the reported exploit shape", async () => {
    const read = await route.GET(req(`/api/v1/memory?userId=${BOB}`));
    expect(read.status).toBe(401);
    const wipe = await route.DELETE(req(`/api/v1/memory?clearAll=true&userId=${BOB}`, { method: 'DELETE' }));
    expect(wipe.status).toBe(401);
    expect(core.listMemoryItems(BOB, 50).some(i => i.id === bobItemId)).toBe(true);
  });

  it('rejects an invalid elx_ key', async () => {
    const res = await route.GET(req('/api/v1/memory', { key: `elx_${'A'.repeat(32)}` }));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe('invalid_api_key');
  });

  it('rejects a non-admin bearer token', async () => {
    const res = await route.GET(req('/api/v1/memory', { bearer: 'not-the-admin-password' }));
    expect(res.status).toBe(401);
  });

  it("serves only the key owner's memories, ignoring a userId query param naming someone else", async () => {
    const res = await route.GET(req(`/api/v1/memory?userId=${BOB}`, { key: aliceKey }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.userId).toBe(ALICE);
    const contents = (data.items || []).map((i: any) => i.content);
    expect(contents.some((c: string) => c.includes('alice secret preference'))).toBe(true);
    expect(contents.some((c: string) => c.includes('bob secret preference'))).toBe(false);
  });

  it('scopes search to the caller as well', async () => {
    const res = await route.GET(req(`/api/v1/memory?q=${encodeURIComponent(MARKER)}`, { key: bobKey }));
    expect(res.status).toBe(200);
    const data = await res.json();
    const contents = (data.items || []).map((i: any) => i.content);
    expect(contents.some((c: string) => c.includes('bob secret preference'))).toBe(true);
    expect(contents.some((c: string) => c.includes('alice secret preference'))).toBe(false);
  });

  it('writes POSTed memories to the caller, ignoring a body userId naming someone else', async () => {
    const res = await route.POST(
      req('/api/v1/memory', { method: 'POST', key: aliceKey, body: { userId: BOB, content: `${MARKER} alice wrote this` } })
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.item.user_id).toBe(ALICE);
    expect(core.listMemoryItems(BOB, 50).some(i => i.content.includes('alice wrote this'))).toBe(false);
  });

  it("refuses DELETE of another user's item by id, and allows the owner", async () => {
    const asBob = await route.DELETE(req(`/api/v1/memory?id=${aliceItemId}`, { method: 'DELETE', key: bobKey }));
    expect(asBob.status).toBe(200);
    expect((await asBob.json()).success).toBe(false);
    expect(core.listMemoryItems(ALICE, 50).some(i => i.id === aliceItemId)).toBe(true);

    const asAlice = await route.DELETE(req(`/api/v1/memory?id=${aliceItemId}`, { method: 'DELETE', key: aliceKey }));
    expect((await asAlice.json()).success).toBe(true);
    expect(core.listMemoryItems(ALICE, 50).some(i => i.id === aliceItemId)).toBe(false);
  });

  it("clearAll wipes only the caller's memories even when the query names another user", async () => {
    const res = await route.DELETE(req(`/api/v1/memory?clearAll=true&userId=${BOB}`, { method: 'DELETE', key: aliceKey }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.userId).toBe(ALICE);
    expect(core.listMemoryItems(BOB, 50).some(i => i.id === bobItemId)).toBe(true);
    expect(core.listMemoryItems(ALICE, 50)).toHaveLength(0);
  });

  it('accepts the admin bearer and scopes it to the default store', async () => {
    process.env.ADMIN_PASSWORD = 'memroute-admin-pw';
    try {
      const res = await route.GET(req('/api/v1/memory', { bearer: 'memroute-admin-pw' }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.userId).toBe('default');
    } finally {
      delete process.env.ADMIN_PASSWORD;
    }
  });

  it('accepts the NextAuth session cookie and scopes it to the default store', async () => {
    const encodeParams: Record<string, unknown> = { token: { sub: '1', name: 'Admin' }, maxAge: 60 };
    encodeParams['secret'] = 'memroute-test-secret';
    const jwt = await encodeJwt(encodeParams as any);
    // Route handlers receive a NextRequest in production; its parsed
    // cookies are what next-auth's getToken reads.
    const sessionReq = new NextRequest('http://localhost:3000/api/v1/memory', {
      headers: { cookie: `next-auth.session-token=${jwt}` }
    });
    const res = await route.GET(sessionReq);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.userId).toBe('default');
  });
});
