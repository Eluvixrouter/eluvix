import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateRandomLetters, getOrCreateAuthConfig } from '../auth.js';

describe('Authentication & XDG Directory Generation', () => {
  const testDir = path.join(os.tmpdir(), `eluvix-test-${Date.now()}`);
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
    process.env.XDG_DATA_HOME = path.join(testDir, 'data');
    delete process.env.ADMIN_PASSWORD;
    delete process.env.NEXTAUTH_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('generates a random 8-letter alphabetical password when specified', () => {
    const password = generateRandomLetters(8);
    expect(password).toHaveLength(8);
    expect(/^[a-zA-Z]{8}$/.test(password)).toBe(true);
  });

  it('generates XDG config directory and auth.json if not present', () => {
    const result = getOrCreateAuthConfig('eluvix-test');
    expect(result.isNew).toBe(true);
    expect(fs.existsSync(result.configDir)).toBe(true);
    expect(fs.existsSync(result.authFile)).toBe(true);
    expect(result.adminPassword).toHaveLength(24);
    expect(/^[a-zA-Z]{24}$/.test(result.adminPassword)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(result.authFile, 'utf8'));
    expect(saved.adminPassword).toBe(result.adminPassword);
    expect(saved.nextAuthSecret).toBe(result.nextAuthSecret);
  });

  it('persists and reloads the generated password on subsequent calls', () => {
    const firstResult = getOrCreateAuthConfig('eluvix-test');
    const secondResult = getOrCreateAuthConfig('eluvix-test');

    expect(secondResult.isNew).toBe(false);
    expect(secondResult.adminPassword).toBe(firstResult.adminPassword);
    expect(secondResult.nextAuthSecret).toBe(firstResult.nextAuthSecret);
  });

  it('respects environment overrides if ADMIN_PASSWORD is set', () => {
    process.env.ADMIN_PASSWORD = 'custom_override';
    const result = getOrCreateAuthConfig('eluvix-test');
    expect(result.adminPassword).toBe('custom_override');
  });
});
