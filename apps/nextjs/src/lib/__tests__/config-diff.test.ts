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

  it('detects harness field changes', () => {
    const tfUpstream: UpstreamConfig = {
      id: 'local-trueforge',
      name: 'TrueForge Harness',
      type: 'harness',
      endpoint: 'http://localhost:8790',
      priority: 17,
      models: ['harness/trueforge'],
      harness: {
        kind: 'trueforge',
        agentId: 'default',
        approvalPolicy: 'auto-approve-readonly'
      }
    };
    const current: RouterConfig = {
      upstreams: [tfUpstream],
      memory: { enabled: true, provider: 'builtin', recallBudgetTokens: 600 }
    };
    const next: RouterConfig = {
      upstreams: [
        {
          ...tfUpstream,
          harness: {
            kind: 'trueforge',
            agentId: 'coder',
            approvalPolicy: 'surface'
          }
        }
      ],
      memory: { enabled: true, provider: 'openviking', recallBudgetTokens: 1200 }
    };
    const diff = diffRouterConfigs(current, next);
    expect(diff.isEmpty).toBe(false);
    expect(diff.changed).toEqual([
      { id: 'local-trueforge', name: 'TrueForge Harness', fields: ['harness'] }
    ]);
    expect(diff.memory).toEqual({
      kind: 'changed',
      fields: ['provider', 'recallBudgetTokens']
    });
  });

  describe('memory section (bug hunt finding 4)', () => {
    const MEMORY_ON: RouterConfig['memory'] = {
      enabled: true,
      provider: 'builtin',
      recallBudgetTokens: 600,
      writeBack: true,
      allowCloudEgress: false,
      cloudMode: 'filter'
    };

    it('reports no memory change for identical memory sections', () => {
      const config: RouterConfig = { upstreams: [LEMONADE], memory: structuredClone(MEMORY_ON) };
      const diff = diffRouterConfigs(structuredClone(config), structuredClone(config));
      expect(diff.memory).toBeUndefined();
      expect(diff.isEmpty).toBe(true);
    });

    it('flags an allowCloudEgress flip that changes nothing else', () => {
      const current: RouterConfig = { upstreams: [LEMONADE], memory: structuredClone(MEMORY_ON) };
      const next: RouterConfig = {
        upstreams: [LEMONADE],
        memory: { ...structuredClone(MEMORY_ON), allowCloudEgress: true }
      };
      const diff = diffRouterConfigs(current, next);
      expect(diff.isEmpty).toBe(false);
      expect(diff.memory).toEqual({ kind: 'changed', fields: ['allowCloudEgress'] });
    });

    it('flags a memory section being added or removed wholesale', () => {
      const bare: RouterConfig = { upstreams: [LEMONADE] };
      const withMemory: RouterConfig = { upstreams: [LEMONADE], memory: structuredClone(MEMORY_ON) };

      const added = diffRouterConfigs(bare, withMemory);
      expect(added.memory?.kind).toBe('added');
      expect(added.memory?.fields).toContain('allowCloudEgress');
      expect(added.isEmpty).toBe(false);

      const removed = diffRouterConfigs(withMemory, bare);
      expect(removed.memory?.kind).toBe('removed');
      expect(removed.memory?.fields).toContain('provider');
      expect(removed.isEmpty).toBe(false);
    });

    it('names every differing memory field, including nested openviking settings', () => {
      const current: RouterConfig = { upstreams: [LEMONADE], memory: structuredClone(MEMORY_ON) };
      const next: RouterConfig = {
        upstreams: [LEMONADE],
        memory: {
          ...structuredClone(MEMORY_ON),
          endpoint: 'http://localhost:1933',
          cloudMode: 'strip',
          recallTimeoutMs: 2500,
          openviking: { readingLevel: 'L2', scopePrefixes: ['viking://user/default'] }
        }
      };
      const diff = diffRouterConfigs(current, next);
      expect(diff.memory).toEqual({
        kind: 'changed',
        fields: ['endpoint', 'recallTimeoutMs', 'cloudMode', 'openviking']
      });
    });

    it('reports an apiKey change by field name only, never by value', () => {
      const current: RouterConfig = {
        upstreams: [LEMONADE],
        memory: { ...structuredClone(MEMORY_ON), apiKey: 'old-memory-secret' }
      };
      const next: RouterConfig = {
        upstreams: [LEMONADE],
        memory: { ...structuredClone(MEMORY_ON), apiKey: 'new-memory-secret' }
      };
      const diff = diffRouterConfigs(current, next);
      expect(diff.memory).toEqual({ kind: 'changed', fields: ['apiKey'] });
      expect(JSON.stringify(diff)).not.toContain('old-memory-secret');
      expect(JSON.stringify(diff)).not.toContain('new-memory-secret');
    });
  });
});

describe('compileGraph harnessNode & memoryNode compilation', () => {
  it('preserves TrueForge profile models, approvalPolicy alias, and emits harness gateway into bifrostYaml', async () => {
    const { compileGraph } = await import('../orchestration/compiler');
    const nodes: any[] = [
      {
        id: 'router-1',
        type: 'routerNode',
        position: { x: 0, y: 0 },
        data: { strategy: 'cost-complexity', egressPolicy: 'local-only' }
      },
      {
        id: 'harness-tf',
        type: 'harnessNode',
        position: { x: 200, y: 0 },
        data: {
          label: 'TrueForge Harness',
          kind: 'trueforge',
          endpoint: 'http://localhost:8790',
          priority: 17,
          agentId: 'coder',
          approvalPolicy: 'surface'
        }
      }
    ];
    const edges: any[] = [
      { id: 'e1', source: 'router-1', target: 'harness-tf' }
    ];
    const compiled = compileGraph(nodes, edges);
    const upstream = compiled.rawRouterConfig.upstreams[0];
    expect(upstream.models).toContain('harness/trueforge');
    expect(upstream.models).toContain('trueforge/default');
    expect(upstream.models).toContain('trueforge/coder');
    expect(upstream.models).toContain('trueforge/researcher');
    expect(upstream.harness.approvalPolicy).toBe('surface');
    expect(compiled.bifrostYaml).toContain('type: harness');
    expect(compiled.bifrostYaml).toContain('harness_kind: trueforge');
    expect(compiled.bifrostYaml).toContain('http://localhost:8790');
  });

  it('compiles knowledgeBaseNode, semanticCacheNode, sandboxNode, consensusNode, and fallbackChainNode into rawRouterConfig', async () => {
    const { compileGraph } = await import('../orchestration/compiler');
    const nodes: any[] = [
      {
        id: 'kb-1',
        type: 'knowledgeBaseNode',
        position: { x: 100, y: 0 },
        data: { backend: 'lightrag', endpoint: 'http://localhost:9621', collectionUri: 'viking://resources/docs', topK: 4 }
      },
      {
        id: 'cache-1',
        type: 'semanticCacheNode',
        position: { x: 100, y: 100 },
        data: { backend: 'sqlite-fts', similarityThreshold: 0.96, ttlSeconds: 1800 }
      },
      {
        id: 'sandbox-1',
        type: 'sandboxNode',
        position: { x: 400, y: 200 },
        data: { sandboxType: 'docker-exec', endpoint: 'http://localhost:8910', memoryLimitMb: 1024 }
      },
      {
        id: 'harness-oh',
        type: 'harnessNode',
        position: { x: 200, y: 200 },
        data: { kind: 'openhands', agentId: 'codeact' }
      },
      {
        id: 'consensus-1',
        type: 'consensusNode',
        position: { x: 200, y: 300 },
        data: { mode: 'judge', candidateCount: 2 }
      },
      {
        id: 'fallback-1',
        type: 'fallbackChainNode',
        position: { x: 200, y: 400 },
        data: { failureThreshold: 4, cooldownSeconds: 45, hedgeDelayMs: 1200 }
      },
      {
        id: 'lem-1',
        type: 'lemonadeNode',
        position: { x: 500, y: 300 },
        data: { endpoint: 'http://localhost:13305' }
      },
      {
        id: 'oll-1',
        type: 'ollamaNode',
        position: { x: 500, y: 400 },
        data: { endpoint: 'http://localhost:11434' }
      }
    ];
    const edges: any[] = [
      { id: 'e-oh-sb', source: 'harness-oh', sourceHandle: 'tools', target: 'sandbox-1' },
      { id: 'e-con-1', source: 'consensus-1', sourceHandle: 'candidate-1', target: 'lem-1' },
      { id: 'e-con-2', source: 'consensus-1', sourceHandle: 'candidate-2', target: 'oll-1' },
      { id: 'e-fb-1', source: 'fallback-1', sourceHandle: 'primary', target: 'lem-1' },
      { id: 'e-fb-2', source: 'fallback-1', sourceHandle: 'secondary', target: 'oll-1' }
    ];

    const compiled = compileGraph(nodes, edges);
    const cfg = compiled.rawRouterConfig;

    expect(cfg.knowledge).toMatchObject({
      enabled: true,
      backend: 'lightrag',
      endpoint: 'http://localhost:9621',
      topK: 4
    });
    expect(cfg.cache).toMatchObject({
      enabled: true,
      backend: 'sqlite-fts',
      similarityThreshold: 0.96,
      ttlSeconds: 1800
    });
    expect(cfg.sandbox).toMatchObject({
      enabled: true,
      sandboxType: 'docker-exec',
      endpoint: 'http://localhost:8910',
      memoryLimitMb: 1024
    });

    const ohUpstream = cfg.upstreams.find((u: any) => u.id === 'harness-oh');
    expect(ohUpstream.harness.kind).toBe('openhands');
    expect(ohUpstream.harness.sandboxEndpoint).toBe('http://localhost:8910');
    expect(ohUpstream.harness.sandboxType).toBe('docker-exec');

    expect(cfg.consensusGroups).toHaveLength(1);
    expect(cfg.consensusGroups[0].candidateUpstreamIds).toEqual(['lem-1', 'oll-1']);

    expect(cfg.fallbackChains).toHaveLength(1);
    expect(cfg.fallbackChains[0]).toMatchObject({
      primaryUpstreamId: 'lem-1',
      secondaryUpstreamId: 'oll-1',
      failureThreshold: 4,
      cooldownSeconds: 45,
      hedgeDelayMs: 1200
    });
  });
});


