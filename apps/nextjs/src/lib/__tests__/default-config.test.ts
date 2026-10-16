import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_CONFIG } from '../default-config';
import { validateConfig } from '../router';

describe('DEFAULT_CONFIG single source of truth', () => {
  it('the checked-in .eluvix-config.json mirror matches the canonical defaults exactly', () => {
    const mirrorPath = path.join(__dirname, '..', '..', '..', '.eluvix-config.json');
    const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf-8'));
    expect(mirror).toEqual(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  });

  it('the canonical defaults pass the same validation saveConfig enforces', () => {
    expect(() => validateConfig(structuredClone(DEFAULT_CONFIG))).not.toThrow();
  });

  it('ships no antigravity upstream and stays local-only (PR #1 / P0 invariants)', () => {
    expect(DEFAULT_CONFIG.egressPolicy).toBe('local-only');
    expect(DEFAULT_CONFIG.upstreams.some(u => u.type === 'antigravity' || u.id === 'antigravity-agent')).toBe(false);
  });
});
