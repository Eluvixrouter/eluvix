import { describe, it, expect, vi } from 'vitest';
import { Eluvix, UpstreamConfig, isLocalUpstream } from '../index.js';

// Mock DB interactions (same as p2-routing.test.ts)
vi.mock('../db.js', () => ({
  logRequest: vi.fn(),
  getRequestLogs: vi.fn().mockReturnValue([])
}));

const BASE: UpstreamConfig = {
  id: 'h',
  name: 'Harness',
  type: 'harness',
  endpoint: 'http://localhost:8790',
  priority: 30,
  models: ['harness/trueforge', '*']
};

function harness(overrides: Partial<UpstreamConfig>): UpstreamConfig {
  return { ...BASE, ...overrides };
}

describe('isLocalUpstream harness locality (bug hunt finding 1)', () => {
  it('honors an explicit providerIsLocal declaration either way', () => {
    // Explicit true wins even over a remote endpoint (operator vouches for it).
    expect(
      isLocalUpstream(harness({ endpoint: 'https://harness.example.com:8790', harness: { kind: 'trueforge', providerIsLocal: true } }))
    ).toBe(true);
    expect(
      isLocalUpstream(harness({ endpoint: 'acp://goose', harness: { kind: 'acp', providerIsLocal: true } }))
    ).toBe(true);
    // Explicit false wins even over a localhost endpoint.
    expect(
      isLocalUpstream(harness({ endpoint: 'http://localhost:8790', harness: { kind: 'trueforge', providerIsLocal: false } }))
    ).toBe(false);
  });

  it('derives locality from the endpoint when providerIsLocal is absent', () => {
    // Process wrappers front external services — the antigravity rule.
    expect(isLocalUpstream(harness({ endpoint: 'acp://goose', harness: { kind: 'acp' } }))).toBe(false);
    expect(isLocalUpstream(harness({ endpoint: 'cli://agent', harness: { kind: 'acp' } }))).toBe(false);
    // http(s) endpoints are judged by host, whatever the harness kind.
    expect(isLocalUpstream(harness({ endpoint: 'http://localhost:4096', harness: { kind: 'acp' } }))).toBe(true);
    expect(isLocalUpstream(harness({ endpoint: 'http://192.168.1.20:8790', harness: { kind: 'trueforge' } }))).toBe(true);
    expect(isLocalUpstream(harness({ endpoint: 'https://harness.example.com:8790', harness: { kind: 'trueforge' } }))).toBe(false);
    // No harness block at all: same endpoint derivation.
    expect(isLocalUpstream(harness({ endpoint: 'acp://goose', harness: undefined }))).toBe(false);
    expect(isLocalUpstream(harness({ endpoint: 'http://localhost:8790', harness: undefined }))).toBe(true);
  });

  it('leaves non-harness locality unchanged', () => {
    expect(
      isLocalUpstream({ id: 'o', name: 'Ollama', type: 'ollama', endpoint: 'http://localhost:11434', priority: 1, models: ['*'] })
    ).toBe(true);
    expect(
      isLocalUpstream({ id: 'a', name: 'AGY', type: 'antigravity', endpoint: 'cli://agy', priority: 1, models: ['*'] })
    ).toBe(false);
    expect(
      isLocalUpstream({ id: 'c', name: 'Cloud', type: 'openai-compatible', endpoint: 'https://api.openai.com/v1', priority: 1, models: ['*'] })
    ).toBe(false);
  });
});

const LEMONADE: UpstreamConfig = {
  id: 'local-lemonade',
  name: 'Lemonade Router',
  type: 'lemonade',
  endpoint: 'http://localhost:13305',
  priority: 25,
  models: ['llama3.2-1b-FLM', '*'],
  maxComplexityScore: 3
};

const ACP_HARNESS_NO_FLAG: UpstreamConfig = {
  id: 'acp-harness',
  name: 'ACP Harness',
  type: 'harness',
  endpoint: 'acp://goose',
  priority: 30,
  models: ['harness/acp', '*'],
  maxComplexityScore: 4,
  harness: { kind: 'acp' }
};

describe('local-only routing with an undeclared harness (bug hunt finding 1)', () => {
  it('excludes an acp:// harness with no providerIsLocal under egressPolicy local-only', () => {
    const router = new Eluvix({
      strategy: 'cost-complexity',
      egressPolicy: 'local-only',
      upstreams: [structuredClone(LEMONADE), structuredClone(ACP_HARNESS_NO_FLAG)]
    });
    const explanation = router.explainRoute({
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }]
    });
    const egressStep = explanation.steps.find(s => s.stage === 'egress-policy');
    expect(egressStep?.removed).toContain('acp-harness');
    expect(explanation.chosenUpstreamId).toBe('local-lemonade');
  });

  it('keeps recalled memories off an undeclared acp:// harness (memory-egress filter)', () => {
    const router = new Eluvix({
      strategy: 'cost-complexity',
      egressPolicy: 'allow-egress',
      memory: { enabled: true, allowCloudEgress: false },
      upstreams: [structuredClone(LEMONADE), structuredClone(ACP_HARNESS_NO_FLAG)]
    });
    const explanation = router.explainRoute(
      { model: 'auto', messages: [{ role: 'user', content: 'hello' }] },
      { memoryTainted: true }
    );
    const memoryStep = explanation.steps.find(s => s.stage === 'memory-egress');
    expect(memoryStep?.removed).toContain('acp-harness');
    expect(explanation.chosenUpstreamId).toBe('local-lemonade');
  });
});
