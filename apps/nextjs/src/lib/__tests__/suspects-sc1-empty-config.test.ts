import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { getConfigPath, saveConfig, validateConfig, ConfigValidationError } from '../router';

/**
 * Hunt-2 suspect S-C1: the editor's Deploy button was not disabled for a
 * zero-node canvas, and the API path accepted `upstreams: []`. M-C3 fixed
 * only deployLocal (validate before write + explicit empty refusal + .bak);
 * the sibling Apply path — POST /api/v1/config -> saveConfig -> validateConfig
 * — still accepted an empty graph, and validateConfig only required
 * `upstreams` to be an array. Saving that wiped the live router to zero
 * upstreams: a total routing outage reported as success.
 *
 * Fix: validateConfig refuses an empty upstreams array, so every save path
 * rejects it; the editor's Deploy and Apply-to-Router buttons are disabled
 * while the canvas is empty. These tests pin the server-side half.
 */
describe('S-C1: empty-canvas config is refused', () => {
  let testDir: string;
  const originalConfigHome = process.env.XDG_CONFIG_HOME;
  const originalDataHome = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-sc1-'));
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
    process.env.XDG_DATA_HOME = path.join(testDir, 'data');
  });

  afterEach(() => {
    if (originalConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = originalConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    if (originalDataHome !== undefined) {
      process.env.XDG_DATA_HOME = originalDataHome;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  const oneUpstream: any = {
    strategy: 'priority',
    upstreams: [
      {
        id: 'test-node',
        name: 'Test Node',
        type: 'openai-compatible',
        endpoint: 'http://localhost:9000',
        priority: 1,
        models: ['gpt-4o', '*'],
      },
    ],
  };

  it('validateConfig rejects an empty upstreams array', () => {
    expect(() => validateConfig({ upstreams: [] })).toThrowError(ConfigValidationError);
    expect(() => validateConfig({ upstreams: [] })).toThrowError(/at least one upstream/);
  });

  it('saveConfig rejects an empty graph and leaves the previous config file untouched', () => {
    saveConfig(oneUpstream);
    const cfgPath = getConfigPath();
    expect(fs.existsSync(cfgPath)).toBe(true);
    const before = fs.readFileSync(cfgPath, 'utf8');

    expect(() => saveConfig({ strategy: 'priority', upstreams: [] } as any)).toThrowError(
      ConfigValidationError
    );

    // The on-disk live config must be byte-identical: a refused empty apply
    // must not destroy the previous working configuration.
    expect(fs.readFileSync(cfgPath, 'utf8')).toBe(before);
    expect(JSON.parse(before).upstreams).toHaveLength(1);
  });

  it('saveConfig still accepts a one-upstream config (control)', () => {
    expect(() => saveConfig(oneUpstream)).not.toThrow();
    const readBack = JSON.parse(fs.readFileSync(getConfigPath(), 'utf8'));
    expect(readBack.upstreams).toHaveLength(1);
    expect(readBack.upstreams[0].id).toBe('test-node');
  });
});
