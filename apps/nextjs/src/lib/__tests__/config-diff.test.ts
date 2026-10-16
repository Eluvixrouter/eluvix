import { describe, it, expect } from 'vitest';
import type { RouterConfig, UpstreamConfig } from '@eluvix/router-core';
import { diffRouterConfigs } from '../config-diff';

const LEMONADE: UpstreamConfig = {
  id: 'local-lemonade',
  name: 'Lemonade Router',
  type: 'lemonade',
  endpoint: 'http://localhost:13305',
  priority: 30,
  models: ['llama3.2-1b-FLM', '*']
};
const OLLAMA: UpstreamConfig = {
  id: 'local-ollama',
  name: 'Local Ollama',
  type: 'ollama',
  endpoint: 'http://localhost:11434',
  priority: 22,
  models: ['llama3']
};
const AGY: UpstreamConfig = {
  id: 'antigravity-agent',
  name: 'Antigravity Agent',
  type: 'antigravity',
  endpoint: 'cli://agy',
  priority: 28,
  models: ['gemini-4-argon', '*']
};

describe('diffRouterConfigs', () => {
  it('reports an empty diff for identical configs', () => {
    const config: RouterConfig = { egressPolicy: 'local-only', upstreams: [LEMONADE, OLLAMA] };
    const diff = diffRouterConfigs(structuredClone(config), structuredClone(config));
    expect(diff.isEmpty).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it('names the upstreams an authoritative apply would remove — the PR #1 scenario', () => {
    const current: RouterConfig = { egressPolicy: 'local-only', upstreams: [LEMONADE, AGY] };
    const next: RouterConfig = { egressPolicy: 'local-only', upstreams: [LEMONADE] };
    const diff = diffRouterConfigs(current, next);
    expect(diff.isEmpty).toBe(false);
    expect(diff.removed.map(u => u.id)).toEqual(['antigravity-agent']);
    expect(diff.added).toEqual([]);
  });

  it('reports additions and field-level changes without leaking values', () => {
    const current: RouterConfig = { upstreams: [LEMONADE] };
    const next: RouterConfig = {
      upstreams: [
        { ...LEMONADE, priority: 5, apiKey: 'secret-key-value', models: ['other-model'] },
        OLLAMA
      ]
    };
    const diff = diffRouterConfigs(current, next);
    expect(diff.added.map(u => u.id)).toEqual(['local-ollama']);
    expect(diff.changed).toEqual([{ id: 'local-lemonade', name: 'Lemonade Router', fields: ['priority', 'models', 'apiKey'] }]);
    expect(JSON.stringify(diff)).not.toContain('secret-key-value');
  });

  it('flags an egress policy change', () => {
    const current: RouterConfig = { egressPolicy: 'local-only', upstreams: [LEMONADE] };
    const next: RouterConfig = { egressPolicy: 'allow-egress', upstreams: [LEMONADE] };
    const diff = diffRouterConfigs(current, next);
    expect(diff.egressPolicy).toEqual({ from: 'local-only', to: 'allow-egress' });
    expect(diff.isEmpty).toBe(false);
  });

  it('treats a null current config as all-additions', () => {
    const diff = diffRouterConfigs(null, { upstreams: [LEMONADE, OLLAMA] });
    expect(diff.added.map(u => u.id)).toEqual(['local-lemonade', 'local-ollama']);
    expect(diff.removed).toEqual([]);
  });
});
