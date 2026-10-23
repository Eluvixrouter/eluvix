import { describe, it, expect } from 'vitest';

import { sanitizeLoadedConfig, validateConfig } from '../router';

/**
 * Security remediation Tier 5 (M-11): promptGuard modes 'classifier' and
 * 'llm-guard' were declared but never implemented. They are removed:
 * validateConfig rejects them on save, and sanitizeLoadedConfig coerces
 * them on load so a hand-edited or legacy config never bricks startup.
 * Both tests fail on pre-fix code (no mode validation/coercion existed).
 */

const GOOD_UPSTREAM = {
  id: 'local-lemonade',
  name: 'Lemonade Router',
  type: 'lemonade',
  endpoint: 'http://localhost:13305',
  priority: 30,
  models: ['llama3.2-1b-FLM', '*']
};

describe('validateConfig: removed promptGuard modes are rejected', () => {
  it("rejects mode 'classifier' with a clear message", () => {
    expect(() =>
      validateConfig({ upstreams: [structuredClone(GOOD_UPSTREAM)], promptGuard: { enabled: true, mode: 'classifier' } })
    ).toThrow(/promptGuard\.mode/);
  });

  it("rejects mode 'llm-guard' with a clear message", () => {
    expect(() =>
      validateConfig({ upstreams: [structuredClone(GOOD_UPSTREAM)], promptGuard: { enabled: true, mode: 'llm-guard' } })
    ).toThrow(/not supported|removed/i);
  });

  it("accepts mode 'heuristic' and a missing mode", () => {
    expect(() =>
      validateConfig({ upstreams: [structuredClone(GOOD_UPSTREAM)], promptGuard: { enabled: true, mode: 'heuristic' } })
    ).not.toThrow();
    expect(() =>
      validateConfig({ upstreams: [structuredClone(GOOD_UPSTREAM)], promptGuard: { enabled: true } })
    ).not.toThrow();
  });
});

describe('sanitizeLoadedConfig: removed promptGuard modes are coerced, not fatal', () => {
  it("coerces mode 'llm-guard' to heuristic + block with a warning", () => {
    const { config, warnings, changed } = sanitizeLoadedConfig({
      upstreams: [structuredClone(GOOD_UPSTREAM)],
      promptGuard: { enabled: true, mode: 'llm-guard' }
    });
    expect(changed).toBe(true);
    expect((config as any).promptGuard.mode).toBe('heuristic');
    expect((config as any).promptGuard.enforcementAction).toBe('block');
    expect(warnings.some((w) => w.includes('promptGuard.mode'))).toBe(true);
  });

  it("coerces mode 'classifier' but preserves an explicit enforcementAction", () => {
    const { config, warnings } = sanitizeLoadedConfig({
      upstreams: [structuredClone(GOOD_UPSTREAM)],
      promptGuard: { enabled: true, mode: 'classifier', enforcementAction: 'warn' }
    });
    expect((config as any).promptGuard.mode).toBe('heuristic');
    expect((config as any).promptGuard.enforcementAction).toBe('warn');
    expect(warnings.some((w) => w.includes('promptGuard.mode'))).toBe(true);
  });

  it('leaves a heuristic-mode guard untouched', () => {
    const input = {
      upstreams: [structuredClone(GOOD_UPSTREAM)],
      promptGuard: { enabled: true, mode: 'heuristic' }
    };
    const { config, warnings, changed } = sanitizeLoadedConfig(input);
    expect(changed).toBe(false);
    expect(warnings).toEqual([]);
    expect(config).toEqual(input);
  });
});
