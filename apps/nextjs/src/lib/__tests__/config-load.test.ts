import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { sanitizeLoadedConfig } from '../router';
import { DEFAULT_CONFIG } from '../default-config';

const GOOD_UPSTREAM = {
  id: 'local-lemonade',
  name: 'Lemonade Router',
  type: 'lemonade',
  endpoint: 'http://localhost:13305',
  priority: 30,
  models: ['llama3.2-1b-FLM', '*']
};

describe('sanitizeLoadedConfig', () => {
  it('passes a valid config through untouched', () => {
    const input = { egressPolicy: 'allow-egress', upstreams: [structuredClone(GOOD_UPSTREAM)] };
    const { config, warnings, changed, recognizable } = sanitizeLoadedConfig(input);
    expect(changed).toBe(false);
    expect(warnings).toEqual([]);
    expect(recognizable).toBe(true);
    expect(config).toEqual(input);
  });

  it('drops an invalid egressPolicy instead of letting it reach the router', () => {
    const { config, warnings, changed } = sanitizeLoadedConfig({
      egressPolicy: 'cloud-please',
      upstreams: [structuredClone(GOOD_UPSTREAM)]
    });
    expect(changed).toBe(true);
    expect(config.egressPolicy).toBeUndefined();
    expect(config.upstreams).toHaveLength(1);
    expect(warnings.some(w => w.includes('egressPolicy'))).toBe(true);
  });

  it('drops an upstream missing its endpoint and keeps the valid sibling', () => {
    const broken = { id: 'broken', name: 'Broken', type: 'ollama', priority: 1, models: ['*'] };
    const { config, warnings, changed } = sanitizeLoadedConfig({
      upstreams: [structuredClone(GOOD_UPSTREAM), broken]
    });
    expect(changed).toBe(true);
    expect(config.upstreams.map(u => u.id)).toEqual(['local-lemonade']);
    expect(warnings.some(w => w.includes('"broken"') && w.includes('"endpoint"'))).toBe(true);
  });

  it('drops an antigravity upstream with an unsafe cliPath', () => {
    const unsafe = {
      id: 'evil-agy',
      name: 'Evil AGY',
      type: 'antigravity',
      endpoint: 'cli://agy',
      priority: 1,
      models: ['*'],
      antigravity: { cliPath: '/tmp/evil; rm -rf /' }
    };
    const { config, warnings } = sanitizeLoadedConfig({
      upstreams: [structuredClone(GOOD_UPSTREAM), unsafe]
    });
    expect(config.upstreams.map(u => u.id)).toEqual(['local-lemonade']);
    expect(warnings.some(w => w.includes('cliPath'))).toBe(true);
  });

  it('drops non-object upstream entries', () => {
    const { config } = sanitizeLoadedConfig({ upstreams: [structuredClone(GOOD_UPSTREAM), 42, null] });
    expect(config.upstreams.map(u => u.id)).toEqual(['local-lemonade']);
  });

  it('falls back to the shipped defaults when no upstream is valid', () => {
    const { config, warnings, recognizable } = sanitizeLoadedConfig({ upstreams: [{ id: 'x' }] });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(recognizable).toBe(true);
    expect(warnings.some(w => w.includes('no valid upstreams'))).toBe(true);
  });

  it('falls back to the shipped defaults for an unrecognizable saved value', () => {
    for (const raw of [42, null, 'nope', { noUpstreams: true }]) {
      const { config, recognizable } = sanitizeLoadedConfig(raw);
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(recognizable).toBe(false);
    }
  });

  it('still migrates stale lemonade placeholder models', () => {
    const stale = { ...structuredClone(GOOD_UPSTREAM), models: ['lemonade-general', 'lemonade-code'] };
    const { config, warnings, changed } = sanitizeLoadedConfig({ upstreams: [stale] });
    expect(changed).toBe(true);
    expect(config.upstreams[0].models).toEqual(['llama3.2-1b-FLM', 'Qwen3.5-4B-MTP-GGUF', '*']);
    expect(warnings.some(w => w.includes('placeholder'))).toBe(true);
  });

  it('drops invalid memory.cloudMode while keeping valid filter or strip modes', () => {
    const invalid = sanitizeLoadedConfig({
      upstreams: [structuredClone(GOOD_UPSTREAM)],
      memory: { enabled: true, endpoint: 'http://localhost:1933', cloudMode: 'invalid-mode' }
    });
    expect(invalid.changed).toBe(true);
    expect(invalid.config.memory?.cloudMode).toBe('filter');
    expect(invalid.warnings.some(w => w.includes('memory.cloudMode'))).toBe(true);

    const valid = sanitizeLoadedConfig({
      upstreams: [structuredClone(GOOD_UPSTREAM)],
      memory: { enabled: true, endpoint: 'http://localhost:1933', cloudMode: 'strip' }
    });
    expect(valid.changed).toBe(false);
    expect(valid.config.memory?.cloudMode).toBe('strip');
  });
});

describe('loadConfig applies sanitization to the on-disk config', () => {
  let testDir: string;
  const originalConfig = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `eluvix-load-vitest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
  });

  afterEach(() => {
    process.env.XDG_CONFIG_HOME = originalConfig;
    vi.resetModules();
    try {
      if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it('repairs a saved config with an invalid egressPolicy and a broken upstream, and persists the repair', async () => {
    const configDir = path.join(testDir, 'config', 'eluvix');
    fs.mkdirSync(configDir, { recursive: true });
    const configFile = path.join(configDir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({
      egressPolicy: 'cloud-please',
      upstreams: [
        structuredClone(GOOD_UPSTREAM),
        { id: 'broken', name: 'Broken', type: 'ollama', priority: 1, models: ['*'] }
      ]
    }, null, 2));

    vi.resetModules();
    const router = await import('../router');
    const loaded = router.getConfig();

    expect(loaded.egressPolicy).toBeUndefined();
    expect(loaded.upstreams.map(u => u.id)).toEqual(['local-lemonade']);

    const persisted = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(persisted.egressPolicy).toBeUndefined();
    expect(persisted.upstreams.map((u: any) => u.id)).toEqual(['local-lemonade']);
  });

  it('keeps a harness upstream with an acp:// endpoint and no harness block (kind is inferred as ACP)', () => {
    const acpNoBlock = {
      id: 'acp-agent',
      name: 'ACP Agent',
      type: 'harness',
      endpoint: 'acp://goose',
      priority: 40,
      models: ['harness/acp']
    };
    const { config, warnings, changed } = sanitizeLoadedConfig({
      upstreams: [structuredClone(GOOD_UPSTREAM), acpNoBlock]
    });
    expect(changed).toBe(false);
    expect(warnings).toEqual([]);
    expect(config.upstreams.map((u: any) => u.id)).toEqual(['local-lemonade', 'acp-agent']);
  });

  it('still drops a harness upstream whose harness.kind is invalid', () => {
    const badKind = {
      id: 'bad-harness',
      name: 'Bad Harness',
      type: 'harness',
      endpoint: 'http://127.0.0.1:8790',
      priority: 40,
      models: ['*'],
      harness: { kind: 'carrier-pigeon' }
    };
    const { config, warnings, changed } = sanitizeLoadedConfig({
      upstreams: [structuredClone(GOOD_UPSTREAM), badKind]
    });
    expect(changed).toBe(true);
    expect(config.upstreams.map((u: any) => u.id)).toEqual(['local-lemonade']);
    expect(warnings.some(w => w.includes('invalid harness.kind'))).toBe(true);
  });
});
