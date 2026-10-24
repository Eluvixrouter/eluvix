import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Security remediation Tier 3 — chat history & export scoping (L-2/S-1).
 *
 * The history and export routes used to serve the whole chat_history
 * table to any authenticated caller. They now resolve the caller's
 * proven identity (named elx_ key) and serve only that identity's
 * partition — so two users sharing one session_id cannot read each
 * other's messages, and an export never contains another user's data.
 *
 * Like memory-route.test.ts, this points XDG dirs at a throwaway home
 * BEFORE importing anything (router-core resolves its data dir from the
 * environment at module load), drives routes with real named keys, and
 * seeds history through router-core's own saveChatMessage.
 */

const ALICE = 'alice';
const BOB = 'bob';
const MARKER = `t3hist${Date.now()}`;
const SHARED_SESSION = `shared-${MARKER}`;
const ALICE_SESSION = `alice-only-${MARKER}`;

let core: typeof import('@eluvix/router-core');
let historyRoute: typeof import('../../app/api/v1/chat/history/route');
let exportRoute: typeof import('../../app/api/v1/export/route');
let aliceKey = '';
let bobKey = '';

const savedEnv: Record<string, string | undefined> = {};
let tmpRoot = '';

function req(url: string, key?: string): Request {
  const headers: Record<string, string> = {};
  if (key) headers['Authorization'] = `Bearer ${key}`;
  return new Request(url, { method: 'GET', headers });
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-t3-history-'));
  for (const name of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'NEXTAUTH_SECRET', 'ADMIN_PASSWORD', 'ELUVIX_ADMIN_PASSWORD']) {
    savedEnv[name] = process.env[name];
  }
  process.env.XDG_DATA_HOME = path.join(tmpRoot, 'data');
  process.env.XDG_CONFIG_HOME = path.join(tmpRoot, 'config');
  process.env.NEXTAUTH_SECRET = `sec-t3-history-secret-${MARKER}`;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ELUVIX_ADMIN_PASSWORD;

  core = await import('@eluvix/router-core');
  historyRoute = await import('../../app/api/v1/chat/history/route');
  exportRoute = await import('../../app/api/v1/export/route');

  aliceKey = core.createNamedApiKey({ userId: ALICE }).key;
  bobKey = core.createNamedApiKey({ userId: BOB }).key;

  // Both users write into the SAME session_id, plus alice has her own.
  core.saveChatMessage(SHARED_SESSION, 'user', `${MARKER} alice words`, ALICE);
  core.saveChatMessage(SHARED_SESSION, 'user', `${MARKER} bob words`, BOB);
  core.saveChatMessage(ALICE_SESSION, 'user', `${MARKER} alice private`, ALICE);
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('GET /api/v1/chat/history', () => {
  it('returns only the caller’s rows for a shared session_id (S-1)', async () => {
    const aliceRes = await historyRoute.GET(req(`http://localhost/api/v1/chat/history?session_id=${SHARED_SESSION}`, aliceKey));
    expect(aliceRes.status).toBe(200);
    const aliceBody = await aliceRes.json();
    expect(aliceBody.data.map((r: any) => r.content)).toEqual([`${MARKER} alice words`]);

    const bobRes = await historyRoute.GET(req(`http://localhost/api/v1/chat/history?session_id=${SHARED_SESSION}`, bobKey));
    expect(bobRes.status).toBe(200);
    const bobBody = await bobRes.json();
    expect(bobBody.data.map((r: any) => r.content)).toEqual([`${MARKER} bob words`]);
  });

  it('lists only the caller’s sessions', async () => {
    const aliceRes = await historyRoute.GET(req('http://localhost/api/v1/chat/history', aliceKey));
    const aliceBody = await aliceRes.json();
    const aliceIds = aliceBody.data.map((s: any) => s.session_id);
    expect(aliceIds).toContain(SHARED_SESSION);
    expect(aliceIds).toContain(ALICE_SESSION);

    const bobRes = await historyRoute.GET(req('http://localhost/api/v1/chat/history', bobKey));
    const bobBody = await bobRes.json();
    const bobIds = bobBody.data.map((s: any) => s.session_id);
    expect(bobIds).toContain(SHARED_SESSION);
    expect(bobIds).not.toContain(ALICE_SESSION);
  });

  it('rejects callers with no proven identity', async () => {
    const res = await historyRoute.GET(req(`http://localhost/api/v1/chat/history?session_id=${SHARED_SESSION}`));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/export', () => {
  it('exports only the caller’s partition', async () => {
    const aliceRes = await exportRoute.GET(req('http://localhost/api/v1/export', aliceKey));
    expect(aliceRes.status).toBe(200);
    const aliceText = await aliceRes.text();
    expect(aliceText).toContain('alice words');
    expect(aliceText).toContain('alice private');
    expect(aliceText).not.toContain('bob words');

    const bobRes = await exportRoute.GET(req('http://localhost/api/v1/export', bobKey));
    const bobText = await bobRes.text();
    expect(bobText).toContain('bob words');
    expect(bobText).not.toContain('alice words');
    expect(bobText).not.toContain('alice private');
  });

  it('rejects callers with no proven identity', async () => {
    const res = await exportRoute.GET(req('http://localhost/api/v1/export'));
    expect(res.status).toBe(401);
  });
});
