import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createNamedApiKey,
  resolveBearerToken,
  clearApiKeysCache,
} from '../auth.js';
import { logRequest } from '../db.js';
import {
  getOrCreateDesktopToken,
  isAllowedLocalHost,
} from '../local-request-guard.js';

/**
 * Regression tests for the Eluvix deep-dive bug hunt #3 (2026-11-23),
 * Slice C, router-core findings:
 *
 *   C-M2  per-key daily spend caps were dead code (no production caller
 *         passed currentDailySpendUsd; resolveBearerToken now reads the
 *         key owner's rolling 24h spend from the request logs itself).
 *   C-L19 empty pre-existing token file kept loose 0644.
 *   C-L20 Host `127.0.0.1:PORT@evil.com` passed the allowlist.
 *
 * Each guard has a negative control proving the legitimate path still works.
 */
describe('hunt3 slice C router-core regressions', () => {
  const testDir = path.join(os.tmpdir(), `eluvix-hunt3-c-${Date.now()}-${process.pid}`);
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
    process.env.XDG_DATA_HOME = path.join(testDir, 'data');
    delete process.env.ADMIN_PASSWORD;
    delete process.env.NEXTAUTH_SECRET;
    try {
      clearApiKeysCache();
    } catch {
      // No cache hook in this build; keys are re-read from disk.
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('C-M2: a capped key is rejected once the owner\'s logged 24h spend reaches the cap', () => {
    const userId = `hunt3-c-m2-${Date.now()}`;
    const created = createNamedApiKey({
      label: 'hunt3 c-m2 capped',
      userId,
      role: 'operator',
      maxDailySpendUsd: 0.001,
    });
    // Negative control: no spend logged yet — the key resolves.
    expect(resolveBearerToken(created.key).valid).toBe(true);

    logRequest({
      model: 'test-model',
      upstream_id: 'test-upstream',
      status: 200,
      duration_ms: 10,
      prompt_tokens: 100,
      completion_tokens: 100,
      cost_usd: 0.002,
      user_id: userId,
    });

    const resolved = resolveBearerToken(created.key);
    expect(resolved.valid).toBe(false);
    expect(resolved.reason).toBe('budget-exceeded');
  });

  it('C-M2: an uncapped key is unaffected by logged spend, and an explicit spend argument still wins', () => {
    const userId = `hunt3-c-m2-uncapped-${Date.now()}`;
    const uncapped = createNamedApiKey({ label: 'hunt3 c-m2 uncapped', userId, role: 'operator' });
    logRequest({
      model: 'test-model',
      upstream_id: 'test-upstream',
      status: 200,
      duration_ms: 10,
      cost_usd: 999,
      user_id: userId,
    });
    expect(resolveBearerToken(uncapped.key).valid).toBe(true);

    const capped = createNamedApiKey({
      label: 'hunt3 c-m2 explicit',
      userId: `hunt3-c-m2-explicit-${Date.now()}`,
      role: 'operator',
      maxDailySpendUsd: 1,
    });
    // Explicit caller-supplied spend still drives the check (pre-fix API preserved).
    expect(resolveBearerToken(capped.key, undefined, 'eluvix', { currentDailySpendUsd: 5 }).valid).toBe(false);
    expect(resolveBearerToken(capped.key, undefined, 'eluvix', { currentDailySpendUsd: 5 }).reason).toBe(
      'budget-exceeded'
    );
    expect(resolveBearerToken(capped.key, undefined, 'eluvix', { currentDailySpendUsd: 0 }).valid).toBe(true);
  });

  it('C-L19: a pre-existing empty 0644 token file is tightened to 0600 after the token is written', () => {
    const configDir = path.join(testDir, 'config', 'eluvix');
    fs.mkdirSync(configDir, { recursive: true });
    const tokenFile = path.join(configDir, 'desktop-token');
    fs.writeFileSync(tokenFile, '', { encoding: 'utf8' });
    fs.chmodSync(tokenFile, 0o644); // force loose mode regardless of umask
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o644);

    const result = getOrCreateDesktopToken();
    expect(result.isNew).toBe(true);
    expect(result.token).toHaveLength(64);
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    // Negative control: the token survives a reload.
    expect(getOrCreateDesktopToken().token).toBe(result.token);
  });

  it('C-L20: a Host with userinfo is rejected even when it starts with a local host', () => {
    expect(isAllowedLocalHost('127.0.0.1:34699@evil.com')).toBe(false);
    expect(isAllowedLocalHost('localhost:3001@evil.com')).toBe(false);
    expect(isAllowedLocalHost('127.0.0.1@evil.com')).toBe(false);
    // Negative controls: plain local hosts still pass, remote hosts still fail.
    expect(isAllowedLocalHost('127.0.0.1:3001')).toBe(true);
    expect(isAllowedLocalHost('localhost')).toBe(true);
    expect(isAllowedLocalHost('[::1]:3001')).toBe(true);
    expect(isAllowedLocalHost('evil.com')).toBe(false);
    expect(isAllowedLocalHost('127.0.0.1%09')).toBe(false);
  });
});
