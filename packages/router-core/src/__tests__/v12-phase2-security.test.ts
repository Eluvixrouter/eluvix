import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Eluvix,
  createNamedApiKey,
  listNamedApiKeys,
  revokeNamedApiKey,
  resolveBearerToken,
  clearApiKeysCache,
  hashApiKey,
  resolveUpstreamSecret,
  clearSecretReferenceCache,
  maskSecretOrReferenceForDisplay,
  recordAuditEvent,
  listAuditEvents,
  verifyAuditChain,
  getDb,
} from '../index.js';

describe('v1.2 Phase 2 — Security Hardening (Hashed Scoped Keys, Secret References, Tamper-Evident Audit Chain)', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let prevXdgConfig: string | undefined;
  let prevXdgData: string | undefined;

  beforeEach(() => {
    prevXdgConfig = process.env.XDG_CONFIG_HOME;
    prevXdgData = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-v12-p2-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-v12-p2-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
    clearApiKeysCache();
    clearSecretReferenceCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ELUVIX_TEST_UPSTREAM_SECRET;
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgData;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('2.1 automatically hashes legacy plaintext keys in place and enforces scopes, expiry, daily spend, and RPM', () => {
    const appDir = path.join(tmpConfigDir, 'eluvix');
    fs.mkdirSync(appDir, { recursive: true });
    const keysFile = path.join(appDir, 'keys.json');

    const legacyPlaintextKey = 'elx_LegacyPlaintextKeyValueForAutoMigrationTest';
    fs.writeFileSync(
      keysFile,
      JSON.stringify(
        [
          {
            id: 'key_legacy_1',
            key: legacyPlaintextKey,
            label: 'Legacy Unhashed Key',
            origin: 'client',
            userId: 'alice',
            role: 'operator',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        null,
        2
      ),
      { mode: 0o600 }
    );

    // First load should automatically hash the plaintext key on disk
    const loaded = listNamedApiKeys();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].key).toBe('elx_Lega...');
    expect(loaded[0].keyPrefix).toBe('elx_Lega');
    expect(loaded[0].keyHash).toBe(hashApiKey(legacyPlaintextKey));

    const diskContent = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    expect(diskContent[0].key).toBe('elx_Lega...');
    expect(diskContent[0].keyHash).toBe(hashApiKey(legacyPlaintextKey));
    expect(JSON.stringify(diskContent)).not.toContain(legacyPlaintextKey);

    // Authenticating with the original raw token still succeeds via SHA-256 timingSafeEqual
    const legacyAuth = resolveBearerToken(legacyPlaintextKey);
    expect(legacyAuth.valid).toBe(true);
    expect(legacyAuth.userId).toBe('alice');

    // Create a new scoped, expiring, rate-limited, budget-capped key
    const scopedKey = createNamedApiKey({
      label: 'Scoped Embeddings Key',
      userId: 'bob',
      role: 'operator',
      scopes: ['embeddings', 'rerank'],
      expiresAt: '2026-12-31T23:59:59.000Z',
      maxDailySpendUsd: 5.0,
      rpm: 2,
    });

    expect(scopedKey.key).toMatch(/^elx_[A-Za-z]{32}$/);
    const afterCreateDisk = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    const persistedScoped = afterCreateDisk.find((k: any) => k.id === scopedKey.id);
    expect(persistedScoped.key).toBe(`${scopedKey.keyPrefix}...`);
    expect(persistedScoped.keyHash).toBe(hashApiKey(scopedKey.key));

    // Scope check: embeddings allowed, chat denied
    const okScope = resolveBearerToken(scopedKey.key, undefined, 'eluvix', {
      requiredScope: 'embeddings',
      nowMs: Date.parse('2026-06-01T00:00:00Z'),
      enforceRateLimit: false,
    });
    expect(okScope.valid).toBe(true);

    const deniedScope = resolveBearerToken(scopedKey.key, undefined, 'eluvix', {
      requiredScope: 'chat',
      nowMs: Date.parse('2026-06-01T00:00:00Z'),
      enforceRateLimit: false,
    });
    expect(deniedScope.valid).toBe(false);
    expect(deniedScope.reason).toBe('insufficient-scope');

    // Expiry check
    const expiredRes = resolveBearerToken(scopedKey.key, undefined, 'eluvix', {
      nowMs: Date.parse('2027-01-02T00:00:00Z'),
      enforceRateLimit: false,
    });
    expect(expiredRes.valid).toBe(false);
    expect(expiredRes.reason).toBe('expired');

    // Daily spend cap check
    const overBudgetRes = resolveBearerToken(scopedKey.key, undefined, 'eluvix', {
      nowMs: Date.parse('2026-06-01T00:00:00Z'),
      currentDailySpendUsd: 5.25,
      enforceRateLimit: false,
    });
    expect(overBudgetRes.valid).toBe(false);
    expect(overBudgetRes.reason).toBe('budget-exceeded');

    // Sliding-window RPM check (rpm: 2)
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    expect(resolveBearerToken(scopedKey.key, undefined, 'eluvix', { nowMs: t0 }).valid).toBe(true);
    expect(resolveBearerToken(scopedKey.key, undefined, 'eluvix', { nowMs: t0 + 1000 }).valid).toBe(true);
    const rateLimited = resolveBearerToken(scopedKey.key, undefined, 'eluvix', { nowMs: t0 + 2000 });
    expect(rateLimited.valid).toBe(false);
    expect(rateLimited.reason).toBe('rate-limited');
  });

  it('2.2 resolves env:, file:, bao:, and keychain: secret references at outbound request time without leaking plaintext in config', async () => {
    process.env.ELUVIX_TEST_UPSTREAM_SECRET = 'sk-from-env-secret-999';

    // 1. env: reference
    const envVal = await resolveUpstreamSecret('env:ELUVIX_TEST_UPSTREAM_SECRET');
    expect(envVal).toBe('sk-from-env-secret-999');
    expect(maskSecretOrReferenceForDisplay('env:ELUVIX_TEST_UPSTREAM_SECRET')).toBe(
      'env:ELUVIX_TEST_UPSTREAM_SECRET'
    );
    expect(maskSecretOrReferenceForDisplay('sk-live-1234567890abcdef')).toBe('sk-liv...cdef');

    // 2. file: reference inside configDir + path traversal guard
    const appDir = path.join(tmpConfigDir, 'eluvix');
    fs.mkdirSync(path.join(appDir, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'secrets', 'vllm.token'), '  vllm-file-token-abc  \n', {
      mode: 0o600,
    });
    expect(await resolveUpstreamSecret('file:secrets/vllm.token')).toBe('vllm-file-token-abc');
    expect(await resolveUpstreamSecret('file:../../../etc/passwd')).toBeUndefined();

    // 3. keychain: reference with injected runner
    const kcVal = await resolveUpstreamSecret('keychain:eluvix/anthropic-prod', {
      keychainRunner: (service, account) => `${service}:${account}:keychain-secret`,
    });
    expect(kcVal).toBe('eluvix:anthropic-prod:keychain-secret');

    // 4. bao: (OpenBao / Vault KV v2) reference with SSRF protection & caching
    let baoCalls = 0;
    const mockBaoFetch = vi.fn(async (url: any, init: any) => {
      baoCalls += 1;
      expect(String(url)).toBe('http://127.0.0.1:8200/v1/secret/data/llm/providers');
      expect(init.headers['X-Vault-Token']).toBe('s.root-bao-token');
      return new Response(
        JSON.stringify({
          data: {
            data: {
              openai_key: 'sk-openbao-resolved-key',
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const baoResolved1 = await resolveUpstreamSecret('bao:secret/data/llm/providers#openai_key', {
      baoAddr: 'http://127.0.0.1:8200',
      baoToken: 's.root-bao-token',
      fetchImpl: mockBaoFetch,
    });
    const baoResolved2 = await resolveUpstreamSecret('bao:secret/data/llm/providers#openai_key', {
      baoAddr: 'http://127.0.0.1:8200',
      baoToken: 's.root-bao-token',
      fetchImpl: mockBaoFetch,
    });
    expect(baoResolved1).toBe('sk-openbao-resolved-key');
    expect(baoResolved2).toBe('sk-openbao-resolved-key');
    expect(baoCalls).toBe(1); // Served from TTL cache on second call

    // SSRF guard blocks cloud metadata on baoAddr
    const ssrfBao = await resolveUpstreamSecret('bao:secret/data/llm#k', {
      baoAddr: 'http://169.254.169.254',
      baoToken: 'tok',
      fetchImpl: mockBaoFetch,
    });
    expect(ssrfBao).toBeUndefined();

    // 5. Verify Eluvix forwardRequest resolves env: reference into Authorization header without mutating config
    let capturedAuthHeader = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init?: RequestInit) => {
      const h = (init?.headers || {}) as Record<string, string>;
      capturedAuthHeader = h['Authorization'] || '';
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_sec_1',
          object: 'chat.completion',
          created: 1700000000,
          model: 'qwen3-8b',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const router = new Eluvix({
      strategy: 'priority',
      upstreams: [
        {
          id: 'env-key-upstream',
          name: 'Env Secret Upstream',
          type: 'vllm',
          endpoint: 'http://127.0.0.1:8000',
          apiKey: 'env:ELUVIX_TEST_UPSTREAM_SECRET',
          models: ['qwen3-8b'],
          priority: 1,
        },
      ],
    });

    const res = await router.routeChatCompletion({
      model: 'qwen3-8b',
      messages: [{ role: 'user', content: 'Test secret resolution' }],
    });
    expect(res.status).toBe(200);
    expect(capturedAuthHeader).toBe('Bearer sk-from-env-secret-999');
    expect(router.getConfig().upstreams[0].apiKey).toBe('env:ELUVIX_TEST_UPSTREAM_SECRET');
  });

  it('2.3 maintains a SHA-256 tamper-evident audit hash chain and detects SQLite row tampering', () => {
    const k = createNamedApiKey({ label: 'Audit Test Key', userId: 'sec-ops' });
    revokeNamedApiKey(k.id, 'eluvix', 'sec-ops');
    recordAuditEvent({
      actorId: 'sec-ops',
      actorRole: 'admin',
      action: 'config.update',
      resourceType: 'router_config',
      resourceId: 'switchyard',
      details: { strategy: 'thompson-bandit', egressPolicy: 'local-only' },
    });

    const events = listAuditEvents({ order: 'asc' });
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].prevHash).toBe('0'.repeat(64));
    expect(events[1].prevHash).toBe(events[0].entryHash);
    expect(events[2].prevHash).toBe(events[1].entryHash);

    const verificationOk = verifyAuditChain();
    expect(verificationOk.valid).toBe(true);
    expect(verificationOk.checkedCount).toBe(events.length);

    // Simulate attacker modifying an audit row directly in SQLite
    const db = getDb();
    db.prepare('UPDATE audit_events SET details_json = ? WHERE seq = ?').run(
      '{"tampered":true}',
      events[1].seq
    );

    const verificationTampered = verifyAuditChain();
    expect(verificationTampered.valid).toBe(false);
    expect(verificationTampered.firstTamperedSeq).toBe(events[1].seq);
    expect(verificationTampered.reason).toContain('Tampered payload or entry_hash mismatch');
  });
});
