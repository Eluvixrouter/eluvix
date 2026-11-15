import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createNamedApiKey,
  listNamedApiKeys,
  revokeNamedApiKey,
  resolveBearerToken,
  getOrCreateAuthConfig,
  hashApiKey,
  clearApiKeysCache
} from '../auth.js';
import { getOrCreateLocalCert, validateLocalCertPair } from '../tls.js';
import { getProviderSettings, getRedactedProviderSettings, saveProviderSettings } from '../db.js';
import { EluvixProviderAgent, validateProviderServerUrl } from '../provider.js';
import { getAppPaths } from '../paths.js';

/**
 * Security remediation Tier 4 (credential hygiene & transport):
 * named keys hashed at rest (M-14/D7), mode re-assertion (S-4/M-17),
 * provider token/URL rules (H-10/S-5), settings redaction (M-29),
 * TLS pair validation (M-16).
 */

const testDir = path.join(os.tmpdir(), `eluvix-t4-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
const originalEnv = { ...process.env };
const originalPath = process.env.PATH;

function fileMode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
  process.env.XDG_DATA_HOME = path.join(testDir, 'data');
  delete process.env.ADMIN_PASSWORD;
  delete process.env.NEXTAUTH_SECRET;
  delete process.env.LEGACY_ADMIN_PASSWORD;
  // New main caches keys.json by mtime; tests in this file share one
  // config dir, so drop the cache between tests (a direct file rewrite
  // in the same millisecond would otherwise read stale).
  clearApiKeysCache();
});

afterEach(() => {
  process.env = { ...originalEnv };
  if (originalPath) process.env.PATH = originalPath;
  vi.unstubAllGlobals();
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

describe('named API keys hashed at rest (M-14, D7)', () => {
  it('stores only a SHA-256 hash in keys.json; the plaintext is returned once at creation', () => {
    const created = createNamedApiKey({ label: 'hash-check', userId: 'alice' });
    expect(created.key).toMatch(/^elx_[A-Za-z]{32}$/);

    const { configDir } = getAppPaths('eluvix');
    const keysFile = path.join(configDir, 'keys.json');
    const raw = fs.readFileSync(keysFile, 'utf8');
    expect(raw).not.toContain(created.key);
    const entries = JSON.parse(raw);
    const entry = entries.find((e: any) => e.id === created.id);
    expect(entry).toBeTruthy();
    // New main's on-disk shape (v1.2): the plaintext is gone, but the
    // record keeps the SHA-256 hash plus a masked `key` (`${prefix}...`)
    // as the display hint — T4's keyPreview field was superseded by it.
    expect(entry.key).toBe(`${created.key.slice(0, 8)}...`);
    expect(entry.key).not.toBe(created.key);
    expect(entry.keyHash).toBe(hashApiKey(created.key));
    expect(entry.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fileMode(keysFile)).toBe(0o600);
  });

  it('listNamedApiKeys returns metadata only — masked key and hash, never the plaintext', () => {
    const created = createNamedApiKey({ label: 'list-check', userId: 'bob' });
    const listed = listNamedApiKeys().find(k => k.id === created.id);
    expect(listed).toBeTruthy();
    // The masked key (`${prefix}...`) and the hash are the display /
    // verification material new main exposes; the plaintext is nowhere.
    expect(listed!.key).toBe(`${created.key.slice(0, 8)}...`);
    expect(listed!.key).not.toBe(created.key);
    expect(listed!.keyHash).toBe(hashApiKey(created.key));
    expect(listed!.keyPrefix).toBe(created.key.slice(0, 8));
    expect(listed!.label).toBe('list-check');
  });

  it('resolveBearerToken validates a hashed key, rejects a wrong one, and still honors the admin password', () => {
    const created = createNamedApiKey({ label: 'resolve-check', userId: 'carol' });
    const ok = resolveBearerToken(created.key);
    expect(ok.valid).toBe(true);
    expect(ok.userId).toBe('carol');
    expect(ok.isAdmin).toBe(false);

    const bad = resolveBearerToken(`elx_${'Z'.repeat(32)}`);
    expect(bad.valid).toBe(false);

    const { adminPassword } = getOrCreateAuthConfig();
    const admin = resolveBearerToken(adminPassword);
    expect(admin.valid).toBe(true);
    expect(admin.isAdmin).toBe(true);
  });

  it('transparently migrates legacy plaintext keys.json entries on load and tightens the file mode', () => {
    const { configDir } = getAppPaths('eluvix');
    fs.mkdirSync(configDir, { recursive: true });
    const keysFile = path.join(configDir, 'keys.json');
    const legacyKey = `elx_${'L'.repeat(32)}`;
    fs.writeFileSync(
      keysFile,
      JSON.stringify([
        {
          id: 'key_legacy1',
          key: legacyKey,
          label: 'legacy',
          origin: 'client',
          userId: 'dave',
          createdAt: new Date().toISOString()
        }
      ]),
      { mode: 0o644 }
    );
    // (The sandbox umask may mask the created mode down further — what
    // matters is that it starts looser than 0o600.)
    expect(fileMode(keysFile)).not.toBe(0o600);

    // Any load path triggers the migration.
    const listed = listNamedApiKeys();
    expect(listed.map(k => k.id)).toContain('key_legacy1');

    const raw = fs.readFileSync(keysFile, 'utf8');
    expect(raw).not.toContain(legacyKey);
    const entries = JSON.parse(raw);
    // Migrated in place: masked key + hash (new main's shape).
    expect(entries[0].key).toBe('elx_LLLL...');
    expect(entries[0].keyHash).toBe(hashApiKey(legacyKey));
    expect(entries[0].keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fileMode(keysFile)).toBe(0o600);

    // The migrated key still authenticates.
    const resolved = resolveBearerToken(legacyKey);
    expect(resolved.valid).toBe(true);
    expect(resolved.userId).toBe('dave');
  });

  it('revocation still works against hashed entries', () => {
    const created = createNamedApiKey({ label: 'revoke-check', userId: 'erin' });
    expect(resolveBearerToken(created.key).valid).toBe(true);
    expect(revokeNamedApiKey(created.id)).toBe(true);
    expect(resolveBearerToken(created.key).valid).toBe(false);
  });
});

describe('credential file modes re-asserted (S-4, M-17)', () => {
  it('getOrCreateAuthConfig tightens a pre-existing loose auth.json to 0o600', () => {
    const { configDir } = getAppPaths('eluvix');
    fs.mkdirSync(configDir, { recursive: true });
    const authFile = path.join(configDir, 'auth.json');
    fs.writeFileSync(
      authFile,
      JSON.stringify({ adminPassword: 'a'.repeat(24), nextAuthSecret: 'b'.repeat(64) }),
      { mode: 0o644 }
    );
    expect(fileMode(authFile)).not.toBe(0o600);
    getOrCreateAuthConfig();
    expect(fileMode(authFile)).toBe(0o600);
  });

  it('the SQLite database file is 0o600 after first open', () => {
    // Earlier tests in this file open the DB via audit events
    // (createNamedApiKey -> recordAuditEvent -> getDb), and afterEach
    // deletes testDir under the cached singleton, so the first-open
    // path must be exercised against a fresh data dir the live
    // connection has never seen.
    process.env.XDG_DATA_HOME = path.join(testDir, 'data-fresh');
    saveProviderSettings({ node_name: 'mode-check' });
    const { dataDir } = getAppPaths('eluvix');
    const dbFile = path.join(dataDir, 'eluvix.db');
    expect(fs.existsSync(dbFile)).toBe(true);
    expect(fileMode(dbFile)).toBe(0o600);
  });
});

describe('provider settings redaction (M-29)', () => {
  it('getRedactedProviderSettings hides the node token behind a boolean flag; the internal getter keeps it', () => {
    saveProviderSettings({ node_token: 'blm_node_secret_value' });
    const redacted = getRedactedProviderSettings();
    expect(redacted).toBeTruthy();
    expect((redacted as any).node_token).toBeUndefined();
    expect(redacted!.node_token_configured).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('blm_node_secret_value');

    const internal = getProviderSettings();
    expect(internal!.node_token).toBe('blm_node_secret_value');
  });
});

describe('provider agent token & URL rules (H-10, S-5)', () => {
  it('validateProviderServerUrl accepts https and loopback http, rejects the rest', () => {
    expect(validateProviderServerUrl('https://api.billama.dev')).toBeNull();
    expect(validateProviderServerUrl('http://127.0.0.1:9999')).toBeNull();
    expect(validateProviderServerUrl('http://localhost:9999')).toBeNull();
    expect(validateProviderServerUrl('http://[::1]:9999')).toBeNull();
    expect(validateProviderServerUrl('http://192.168.1.10:9999')).toMatch(/https/);
    expect(validateProviderServerUrl('http://billama.example.com')).toMatch(/https/);
    expect(validateProviderServerUrl('ftp://example.com')).toMatch(/https/);
    expect(validateProviderServerUrl('not a url')).toMatch(/not a valid URL/);
  });

  it('updateConfig and saveProviderSettings refuse a non-loopback http server URL', () => {
    const agent = new EluvixProviderAgent({ nodeToken: 'tok' });
    expect(() => agent.updateConfig({ serverUrl: 'http://192.168.1.10:9999' })).toThrow(/https/);
    expect(() => saveProviderSettings({ server_url: 'http://192.168.1.10:9999' })).toThrow(/https/);
    // https and loopback remain fine.
    agent.updateConfig({ serverUrl: 'https://api.billama.dev' });
    agent.updateConfig({ serverUrl: 'http://127.0.0.1:9999' });
  });

  it('with no node token, start() skips registration entirely — no fetch, no throw, status OFFLINE', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch must not be called without a token');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const agent = new EluvixProviderAgent({
      nodeToken: undefined,
      serverUrl: 'https://billama.test',
      engineUrl: 'http://127.0.0.1:9'
    });
    await expect(agent.start()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    const status = await agent.getStatus();
    expect(status.status).toBe('OFFLINE');
  });

  it('with a token but a plaintext non-loopback server URL, start() fails loudly and never fetches', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('fetch must not be called with an invalid URL');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const agent = new EluvixProviderAgent({
      nodeToken: 'tok',
      serverUrl: 'http://192.168.1.10:9999',
      engineUrl: 'http://127.0.0.1:9'
    });
    await expect(agent.start()).rejects.toThrow(/https/);
    expect(fetchSpy).not.toHaveBeenCalled();
    const status = await agent.getStatus();
    expect(status.status).toBe('ERROR');
  });
});

describe('TLS certificate pair validation (M-16)', () => {
  const certDir = path.join(testDir, 'certs');

  function makeCertPair(
    name: string,
    sans: string,
    days: number
  ): { cert: Buffer; key: Buffer } {
    fs.mkdirSync(certDir, { recursive: true });
    const certPath = path.join(certDir, `${name}.pem`);
    const keyPath = path.join(certDir, `${name}-key.pem`);
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', keyPath, '-out', certPath,
        '-days', String(days), '-nodes',
        '-subj', '/CN=eluvix-test',
        '-addext', `subjectAltName=${sans}`
      ],
      { stdio: 'ignore' }
    );
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  }

  it('accepts a valid pair whose SANs cover the requested domains', () => {
    const pair = makeCertPair('good', 'DNS:localhost,IP:127.0.0.1,IP:::1', 365);
    expect(validateLocalCertPair(pair.cert, pair.key, ['localhost', '127.0.0.1', '::1'])).toBe(true);
  });

  it('rejects a pair whose SANs do not cover a requested domain', () => {
    const pair = makeCertPair('wrongsan', 'DNS:other.example,IP:127.0.0.1', 365);
    expect(validateLocalCertPair(pair.cert, pair.key, ['localhost', '127.0.0.1'])).toBe(false);
  });

  it('rejects a mismatched key', () => {
    const a = makeCertPair('a', 'DNS:localhost', 365);
    const b = makeCertPair('b', 'DNS:localhost', 365);
    expect(validateLocalCertPair(a.cert, b.key, ['localhost'])).toBe(false);
  });

  it('rejects an expired certificate', () => {
    // A 1-day cert evaluated two days from now exercises the same expiry
    // branch an actually-expired cert hits (openssl cannot mint an
    // already-expired cert without a full CA setup).
    const pair = makeCertPair('expired', 'DNS:localhost', 1);
    const twoDaysHence = Date.now() + 2 * 24 * 60 * 60 * 1000;
    expect(validateLocalCertPair(pair.cert, pair.key, ['localhost'], twoDaysHence)).toBe(false);
    // …and the same pair is accepted at the current time.
    expect(validateLocalCertPair(pair.cert, pair.key, ['localhost'])).toBe(true);
  });

  it('getOrCreateLocalCert reuses a valid pair and regenerates an invalid one (fake mkcert)', () => {
    // Fake mkcert that actually produces openssl certs for the requested domains.
    const binDir = path.join(testDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const fakeMkcert = path.join(binDir, 'mkcert');
    fs.writeFileSync(
      fakeMkcert,
      [
        '#!/usr/bin/env bash',
        'if [[ "$1" == "-version" ]]; then echo "v1.4.4-fake"; exit 0; fi',
        'if [[ "$1" == "-install" ]]; then exit 0; fi',
        'cert=""; key=""; sans=""',
        'while [[ $# -gt 0 ]]; do',
        '  case "$1" in',
        '    -cert-file) cert="$2"; shift 2;;',
        '    -key-file) key="$2"; shift 2;;',
        '    *) d="$1"; if [[ "$d" =~ ^[0-9.]+$ || "$d" == *":"* ]]; then sans="${sans}IP:${d},"; else sans="${sans}DNS:${d},"; fi; shift;;',
        '  esac',
        'done',
        'sans="${sans%,}"',
        'openssl req -x509 -newkey rsa:2048 -keyout "$key" -out "$cert" -days 365 -nodes -subj "/CN=fake-mkcert" -addext "subjectAltName=${sans}" >/dev/null 2>&1'
      ].join('\n'),
      { mode: 0o755 }
    );
    process.env.PATH = `${binDir}:${originalPath}`;

    const { configDir } = getAppPaths('eluvix');
    const tlsDir = path.join(configDir, 'tls');
    fs.mkdirSync(tlsDir, { recursive: true });
    const certPath = path.join(tlsDir, 'eluvix.pem');
    const keyPath = path.join(tlsDir, 'eluvix-key.pem');

    // 1. A pair for the WRONG domains must be regenerated, not reused.
    const wrong = makeCertPair('preplaced-wrong', 'DNS:wrong.example', 365);
    fs.writeFileSync(certPath, wrong.cert);
    fs.writeFileSync(keyPath, wrong.key);
    const regenerated = getOrCreateLocalCert(['localhost', '127.0.0.1']);
    expect(regenerated).not.toBeNull();
    expect(regenerated!.cert.equals(wrong.cert)).toBe(false);
    expect(validateLocalCertPair(regenerated!.cert, regenerated!.key, ['localhost', '127.0.0.1'])).toBe(true);
    expect(fileMode(keyPath)).toBe(0o600);

    // 2. The now-valid pair must be reused byte-for-byte.
    const before = fs.readFileSync(certPath);
    const reused = getOrCreateLocalCert(['localhost', '127.0.0.1']);
    expect(reused).not.toBeNull();
    expect(reused!.cert.equals(before)).toBe(true);
  });
});
