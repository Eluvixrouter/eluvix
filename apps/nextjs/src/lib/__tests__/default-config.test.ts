import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { Eluvix } from '@eluvix/router-core';
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

  it('matches the pinned snapshot (any defaults change is a deliberate, reviewed edit)', () => {
    expect(JSON.parse(JSON.stringify(DEFAULT_CONFIG))).toMatchSnapshot();
  });
});

describe('DEFAULT_CONFIG routing behavior', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('routes an image request to a local vision-capable upstream under local-only egress (no dead-end, no cloud)', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'a cat' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    const router = new Eluvix(structuredClone(DEFAULT_CONFIG));
    const res = await router.routeChatCompletion({
      model: 'auto',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this picture?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
        ]
      }]
    });
    expect(res.status).toBe(200);
    // Both local-lemonade (explicit vision capability) and claude-code-agent
    // (localhost, vision-capable, higher complexity cap) are valid local
    // winners depending on ranking; the guarantees that matter are that the
    // request is served at all and never leaves the machine.
    expect(['local-lemonade', 'claude-code-agent']).toContain(res.headers.get('x-eluvix-upstream'));
  });
});
