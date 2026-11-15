import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loginLockoutRemainingMs,
  recordLoginFailure,
  recordLoginSuccess,
  getLoginThrottleKey,
  __resetLoginThrottleForTests
} from '../login-throttle';

/**
 * Security remediation Tier 4 (credential hygiene & transport), app side:
 * login throttling (L-3), legacy credential migration (L-4/D6), config
 * and provider-settings redaction at the API boundary (M-29/L-1),
 * save-back preservation of redacted secrets, the models-route named-key
 * check behind the new middleware passthrough, and the Configurator
 * writing scoped keys at 0o600 (H-11).
 */

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};

let core: typeof import('@eluvix/router-core');
let libRouter: typeof import('../router');
let configRoute: typeof import('../../app/api/v1/config/route');
let providerStatusRoute: typeof import('../../app/api/v1/provider/status/route');
let configuratorApplyRoute: typeof import('../../app/api/v1/configurator/apply/route');
let configuratorDataRoute: typeof import('../../app/api/v1/configurator/data/route');
let modelsRoute: typeof import('../../app/api/v1/models/route');
let legacyCredential: typeof import('../legacy-credential');

function jsonReq(url: string, body: any, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

function fileMode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-t4-next-'));
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HOME', 'ADMIN_PASSWORD', 'LEGACY_ADMIN_PASSWORD', 'NEXTAUTH_SECRET']) {
    savedEnv[name] = process.env[name];
  }
  process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
  process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  process.env.HOME = tmpDir;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.LEGACY_ADMIN_PASSWORD;

  core = await import('@eluvix/router-core');
  libRouter = await import('../router');
  configRoute = await import('../../app/api/v1/config/route');
  providerStatusRoute = await import('../../app/api/v1/provider/status/route');
  configuratorApplyRoute = await import('../../app/api/v1/configurator/apply/route');
  configuratorDataRoute = await import('../../app/api/v1/configurator/data/route');
  modelsRoute = await import('../../app/api/v1/models/route');
  legacyCredential = await import('../legacy-credential');
});

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe('login throttling (L-3)', () => {
  beforeEach(() => {
    __resetLoginThrottleForTests();
  });

  it('allows the first few failures, then locks out with escalating windows', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) {
      const r = recordLoginFailure('ip-a', t0 + i);
      expect(r.lockoutMs).toBe(0);
    }
    expect(loginLockoutRemainingMs('ip-a', t0 + 10)).toBe(0);

    const fifth = recordLoginFailure('ip-a', t0 + 20);
    expect(fifth.lockoutMs).toBe(30_000);
    expect(loginLockoutRemainingMs('ip-a', t0 + 20)).toBe(30_000);
    expect(loginLockoutRemainingMs('ip-a', t0 + 20 + 29_999)).toBe(1);
    expect(loginLockoutRemainingMs('ip-a', t0 + 20 + 30_000)).toBe(0);

    const sixth = recordLoginFailure('ip-a', t0 + 20 + 30_000);
    expect(sixth.lockoutMs).toBe(60_000);
  });

  it('caps the lockout at 15 minutes and isolates counters per key', () => {
    const t0 = 2_000_000;
    let last = { failures: 0, lockoutMs: 0 };
    for (let i = 0; i < 30; i++) {
      last = recordLoginFailure('ip-b', t0 + i * 1000);
    }
    expect(last.lockoutMs).toBe(15 * 60_000);
    expect(loginLockoutRemainingMs('ip-c', t0)).toBe(0);
  });

  it('a successful login clears the counter', () => {
    const t0 = 3_000_000;
    for (let i = 0; i < 6; i++) recordLoginFailure('ip-d', t0 + i);
    expect(loginLockoutRemainingMs('ip-d', t0 + 10)).toBeGreaterThan(0);
    recordLoginSuccess('ip-d');
    expect(loginLockoutRemainingMs('ip-d', t0 + 10)).toBe(0);
    const again = recordLoginFailure('ip-d', t0 + 11);
    expect(again.failures).toBe(1);
    expect(again.lockoutMs).toBe(0);
  });

  it('derives the throttle key from the first forwarded IP, falling back to a shared bucket', () => {
    expect(getLoginThrottleKey({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } })).toBe('203.0.113.7');
    expect(getLoginThrottleKey({ headers: {} })).toBe('unknown');
    expect(getLoginThrottleKey(undefined)).toBe('unknown');
  });
});

describe('config API redaction + save-back preservation (M-29)', () => {
  it('GET /api/v1/config returns apiKeyConfigured flags, never the keys', async () => {
    const base = JSON.parse(JSON.stringify(libRouter.getConfig()));
    base.upstreams = [
      {
        id: 'billama-cloud',
        name: 'Billama',
        type: 'billama',
        endpoint: 'https://api.billama.dev',
        apiKey: 'sk-secret-upstream-key',
        priority: 1,
        models: ['auto']
      }
    ];
    base.memory = { ...(base.memory || {}), provider: 'mem0', apiKey: 'mem0-secret-key' };
    libRouter.saveConfig(base);

    const res = await configRoute.GET(new Request('http://localhost:3000/api/v1/config'));
    const data = await res.json();
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('sk-secret-upstream-key');
    expect(serialized).not.toContain('mem0-secret-key');
    const upstream = data.upstreams.find((u: any) => u.id === 'billama-cloud');
    expect(upstream.apiKey).toBeUndefined();
    expect(upstream.apiKeyConfigured).toBe(true);
    expect(data.memory.apiKey).toBeUndefined();
    expect(data.memory.apiKeyConfigured).toBe(true);

    // The internal getter is untouched for server-side use.
    expect(libRouter.getConfig().upstreams.find(u => u.id === 'billama-cloud')?.apiKey).toBe('sk-secret-upstream-key');
  });

  it('POSTing the redacted config back preserves the stored keys; posting a new key replaces it', async () => {
    const getRes = await configRoute.GET(new Request('http://localhost:3000/api/v1/config'));
    const redacted = await getRes.json();

    const postRes = await configRoute.POST(jsonReq('/api/v1/config', redacted));
    expect(postRes.status).toBe(200);
    expect(libRouter.getConfig().upstreams.find(u => u.id === 'billama-cloud')?.apiKey).toBe('sk-secret-upstream-key');
    expect((libRouter.getConfig() as any).memory?.apiKey).toBe('mem0-secret-key');

    const withNewKey = JSON.parse(JSON.stringify(redacted));
    withNewKey.upstreams.find((u: any) => u.id === 'billama-cloud').apiKey = 'sk-rotated-key';
    const rotateRes = await configRoute.POST(jsonReq('/api/v1/config', withNewKey));
    expect(rotateRes.status).toBe(200);
    expect(libRouter.getConfig().upstreams.find(u => u.id === 'billama-cloud')?.apiKey).toBe('sk-rotated-key');
  });
});

describe('provider status redaction (M-29)', () => {
  it('GET /api/v1/provider/status exposes node_token_configured, never the token', async () => {
    core.saveProviderSettings({ node_token: 'blm_node_top_secret' });
    const res = await providerStatusRoute.GET();
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(JSON.stringify(data)).not.toContain('blm_node_top_secret');
    expect(data.settings.node_token).toBeUndefined();
    expect(data.settings.node_token_configured).toBe(true);
  });
});

describe('configurator (H-11, L-1)', () => {
  it('data GET no longer returns the admin password', async () => {
    const res = await configuratorDataRoute.GET();
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.auth.adminPassword).toBeUndefined();
    expect(typeof data.data.auth.authFile).toBe('string');
  });

  it('apply writes a scoped elx_ key (not the admin password) into opencode.json at 0o600, with a 0o600 backup', async () => {
    const opencodeDir = path.join(tmpDir, 'config', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    const opencodePath = path.join(opencodeDir, 'opencode.json');
    fs.writeFileSync(opencodePath, JSON.stringify({ provider: { Other: { options: { apiKey: 'other-provider-key' } } } }), {
      mode: 0o644
    });

    const { adminPassword } = core.getOrCreateAuthConfig();
    // New main's apply route requires an admin caller (resolveCallerIdentity);
    // the test authenticates with the admin password as a bearer token.
    const adminHeaders = { Authorization: `Bearer ${adminPassword}` };
    const res = await configuratorApplyRoute.POST(
      jsonReq('/api/v1/configurator/apply', {
        client: 'opencode',
        protocol: 'https',
        models: [{ id: 'auto', name: 'Auto', contextLimit: 32768, outputLimit: 4096 }]
      }, adminHeaders)
    );
    const data = await res.json();
    expect(data.success).toBe(true);

    const written = JSON.parse(fs.readFileSync(opencodePath, 'utf8'));
    const key = written.provider.Eluvix.options.apiKey;
    expect(key).toMatch(/^elx_[A-Za-z]{32}$/);
    expect(key).not.toBe(adminPassword);
    expect(JSON.stringify(written)).not.toContain(adminPassword);
    // The minted key resolves to the client's own identity.
    const resolved = core.resolveBearerToken(key);
    expect(resolved.valid).toBe(true);
    expect(resolved.userId).toBe('client-opencode');
    expect(fileMode(opencodePath)).toBe(0o600);

    // The backup of the previous config exists and is also owner-only.
    const backups = fs.readdirSync(opencodeDir).filter(f => f.startsWith('opencode.json.bak-'));
    expect(backups.length).toBe(1);
    expect(fileMode(path.join(opencodeDir, backups[0]))).toBe(0o600);
    expect(fs.readFileSync(path.join(opencodeDir, backups[0]), 'utf8')).toContain('other-provider-key');

    // Re-applying rotates the key and revokes the previous one.
    const res2 = await configuratorApplyRoute.POST(
      jsonReq('/api/v1/configurator/apply', {
        client: 'opencode',
        protocol: 'https',
        models: [{ id: 'auto', name: 'Auto', contextLimit: 32768, outputLimit: 4096 }]
      }, adminHeaders)
    );
    expect((await res2.json()).success).toBe(true);
    const rewritten = JSON.parse(fs.readFileSync(opencodePath, 'utf8'));
    const newKey = rewritten.provider.Eluvix.options.apiKey;
    expect(newKey).not.toBe(key);
    expect(core.resolveBearerToken(key).valid).toBe(false);
    expect(core.resolveBearerToken(newKey).valid).toBe(true);
  });
});

describe('models route named-key verification (middleware passthrough companion)', () => {
  it('serves the list with no elx_ bearer (admin/session path) and with a valid key; 401s a forged key', async () => {
    const noAuth = await modelsRoute.GET(new Request('http://localhost:3000/api/v1/models'));
    expect(noAuth.status).toBe(200);

    const forged = await modelsRoute.GET(
      new Request('http://localhost:3000/api/v1/models', {
        headers: { authorization: `Bearer elx_${'F'.repeat(32)}` }
      })
    );
    expect(forged.status).toBe(401);

    const created = core.createNamedApiKey({ label: 'models-check', userId: 'client-opencode' });
    const valid = await modelsRoute.GET(
      new Request('http://localhost:3000/api/v1/models', {
        headers: { authorization: `Bearer ${created.key}` }
      })
    );
    expect(valid.status).toBe(200);
    const body = await valid.json();
    expect(body.object).toBe('list');
  });
});

describe('legacy credential migration (L-4, D6)', () => {
  it('moves the legacy password into the current auth config and renames the legacy file aside', () => {
    const enclavixDir = path.join(tmpDir, '.config', 'enclavix');
    fs.mkdirSync(enclavixDir, { recursive: true });
    const legacyFile = path.join(enclavixDir, 'auth.json');
    fs.writeFileSync(legacyFile, JSON.stringify({ adminPassword: 'legacy-password-123' }));

    const eluvixDir = path.join(tmpDir, 'config', 'eluvix');
    fs.mkdirSync(eluvixDir, { recursive: true });
    fs.writeFileSync(
      path.join(eluvixDir, 'auth.json'),
      JSON.stringify({ adminPassword: 'current-password-456', nextAuthSecret: 'c'.repeat(64) })
    );

    process.env.LEGACY_ADMIN_PASSWORD = 'legacy-password-123';
    const result = legacyCredential.migrateLegacyCredential('legacy-password-123');

    expect(result.retired).toBe(true);
    const current = JSON.parse(fs.readFileSync(path.join(eluvixDir, 'auth.json'), 'utf8'));
    expect(current.adminPassword).toBe('legacy-password-123');
    expect(current.nextAuthSecret).toBe('c'.repeat(64));
    expect(fileMode(path.join(eluvixDir, 'auth.json'))).toBe(0o600);
    expect(fs.existsSync(legacyFile)).toBe(false);
    expect(fs.existsSync(`${legacyFile}.migrated`)).toBe(true);
    expect(process.env.LEGACY_ADMIN_PASSWORD).toBeUndefined();
    expect(process.env.ADMIN_PASSWORD).toBe('legacy-password-123');

    delete process.env.ADMIN_PASSWORD;
  });
});
