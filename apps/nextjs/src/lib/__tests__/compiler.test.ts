import { describe, it, expect } from 'vitest';
import { compileGraph } from '../orchestration/compiler';
import { Node } from '@xyflow/react';

describe('Eluvix Canvas Compiler', () => {
  it('should compile privacy guard node with custom regex, whitelist, and hash redaction', () => {
    const nodes: Node[] = [
      {
        id: 'pg-1',
        type: 'privacyGuardNode',
        position: { x: 0, y: 0 },
        data: {
          action: 'anonymize',
          redactionStyle: 'hash',
          whitelist: ['internal.corp', 'dev-token'],
          detectPii: { apiKey: true, ssn: false },
          customPatterns: [{ name: 'EmployeeID', pattern: 'EMP-\\d{6}' }],
          auditLogging: true,
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.privacyGuardSetup).toContain('redactionStyle: "hash"');
    expect(result.privacyGuardSetup).toContain('"name":"EmployeeID"');
    expect(result.privacyGuardSetup).toContain('EMP-');
    expect(result.eluvixJson).toContain('"redactionStyle": "hash"');
    expect(result.eluvixJson).toContain('"auditLogging": true');
  });

  it('should compile semantic guard node with threat vectors and banned phrases', () => {
    const nodes: Node[] = [
      {
        id: 'sg-1',
        type: 'semanticGuardNode',
        position: { x: 0, y: 0 },
        data: {
          routeName: 'strict-firewall',
          encoder: 'deberta-v3-injection',
          threshold: 0.92,
          enforcementAction: 'divert',
          threatVectors: { instructionOverride: true, danJailbreak: true },
          bannedPhrases: ['secret_token_override', 'bypass_policy'],
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.semanticRouterSetup).toContain('strict-firewall');
    expect(result.semanticRouterSetup).toContain('deberta-v3-injection');
    expect(result.semanticRouterSetup).toContain('secret_token_override');
    expect(result.eluvixJson).toContain('"action": "divert"');
  });

  it('should compile model gateway with caching and rate limits', () => {
    const nodes: Node[] = [
      {
        id: 'mg-1',
        type: 'modelGatewayNode',
        position: { x: 0, y: 0 },
        data: {
          primaryModel: 'llama3:70b',
          fallbackStrategy: 'same-tier',
          cacheEnabled: true,
          cacheTtlSeconds: 7200,
          cacheSimilarityThreshold: 0.98,
          rateLimitRpm: 120,
          rateLimitTpm: 500000,
          systemPromptPrepend: 'You are an internal sovereign assistant.',
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.bifrostYaml).toContain('caching:');
    expect(result.bifrostYaml).toContain('ttl_seconds: 7200');
    expect(result.bifrostYaml).toContain('rate_limits:');
    expect(result.bifrostYaml).toContain('max_rpm: 120');
    expect(result.eluvixJson).toContain('"primaryModel": "llama3:70b"');
  });

  it('should compile task router with classifier engine and routing preference', () => {
    const nodes: Node[] = [
      {
        id: 'tr-1',
        type: 'taskRouterNode',
        position: { x: 0, y: 0 },
        data: {
          classificationEngine: 'fastembed',
          preference: 'cost',
          confidenceThreshold: 0.88,
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.agentRouterJson).toContain('"classificationEngine": "fastembed"');
    expect(result.agentRouterJson).toContain('"preference": "cost"');
    expect(result.agentRouterJson).toContain('"confidenceThreshold": 0.88');
  });

  it('should compile agent gateway with tool filtering', () => {
    const nodes: Node[] = [
      {
        id: 'ag-1',
        type: 'agentGatewayNode',
        position: { x: 0, y: 0 },
        data: {
          accessPolicy: 'restrictive',
          toolFilterMode: 'whitelist',
          toolTimeoutMs: 8000,
          enableNativeTools: false,
          sanitizeToolOutput: true,
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.agentGatewayJson).toContain('"accessPolicy": "restrictive"');
    expect(result.agentGatewayJson).toContain('"toolFilterMode": "whitelist"');
    expect(result.agentGatewayJson).toContain('"toolTimeoutMs": 8000');
    expect(result.agentGatewayJson).toContain('"sanitizeToolOutput": true');
  });

  it('should compile observability node with collector exporter and pii scrubbing', () => {
    const nodes: Node[] = [
      {
        id: 'obs-1',
        type: 'observabilityNode',
        position: { x: 0, y: 0 },
        data: {
          exporter: 'otlp',
          endpointUrl: 'http://otel-collector:4318/v1/traces',
          projectName: 'eluvix-fintech',
          samplingRate: 75,
          scrubPii: true,
          captureInputs: false,
          latencyAlertMs: 3500,
        },
      },
    ];
    const result = compileGraph(nodes, []);
    expect(result.observabilitySetup).toContain('exporter: "otlp"');
    expect(result.observabilitySetup).toContain('http://otel-collector:4318/v1/traces');
    expect(result.observabilitySetup).toContain('scrubPii: true');
    expect(result.observabilitySetup).toContain('latencyAlertMs: 3500');
  });
});

describe('Eluvix Canvas Compiler — tiers, capability, egress', () => {
  const switchyardNode: Node = {
    id: 'sw-1',
    type: 'switchyardNode',
    position: { x: 0, y: 0 },
    data: {
      strategy: 'cost-complexity',
      routes: [
        { id: 'tier-1', name: 'Tier 1: Local Fast' },
        { id: 'tier-3', name: 'Tier 3: Economy Cloud' },
      ],
    },
  };

  it('does not let tier-1 wiring cap a local engine capability, and compiles local-only egress', () => {
    const nodes: Node[] = [
      switchyardNode,
      {
        id: 'lemonade-1',
        type: 'lemonadeNode',
        position: { x: 0, y: 0 },
        data: { label: 'Lemonade Engine', endpoint: 'http://localhost:13305', selectedModel: 'Qwen3.5-4B-MTP-GGUF' },
      },
    ];
    const edges = [{ id: 'e1', source: 'sw-1', target: 'lemonade-1', sourceHandle: 'tier-1' } as any];
    const result = compileGraph(nodes, edges);
    const upstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'lemonade-1');
    expect(upstream.tier).toBe('tier-1');
    expect(upstream.maxComplexityScore).toBe(4);
    expect(result.rawRouterConfig.egressPolicy).toBe('local-only');
  });

  it('respects an explicit per-node capability cap over the engine default', () => {
    const nodes: Node[] = [
      {
        id: 'lemonade-1',
        type: 'lemonadeNode',
        position: { x: 0, y: 0 },
        data: { label: 'Small Lemonade', selectedModel: 'tiny-model', maxComplexityScore: 1 },
      },
    ];
    const result = compileGraph(nodes, []);
    const upstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'lemonade-1');
    expect(upstream.maxComplexityScore).toBe(1);
  });

  it('compiles allow-egress when a cloud node is on the canvas, with full capability and node cost', () => {
    const nodes: Node[] = [
      switchyardNode,
      {
        id: 'billama-1',
        type: 'billamaNode',
        position: { x: 0, y: 0 },
        data: { label: 'Billama Cloud Provider', endpoint: 'https://api.billama.dev', selectedModel: 'llama-3.3-70b', costPer1kTokens: 0.007 },
      },
    ];
    const edges = [{ id: 'e1', source: 'sw-1', target: 'billama-1', sourceHandle: 'tier-3' } as any];
    const result = compileGraph(nodes, edges);
    const upstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'billama-1');
    expect(upstream.tier).toBe('tier-3');
    expect(upstream.maxComplexityScore).toBe(4);
    expect(upstream.costPer1kTokens).toBe(0.007);
    expect(result.rawRouterConfig.egressPolicy).toBe('allow-egress');
  });

  describe('harness locality and memory settings (bug hunt findings 1 & 26)', () => {
    const lemonadeNode: Node = {
      id: 'lemonade-1',
      type: 'lemonadeNode',
      position: { x: 0, y: 0 },
      data: { label: 'Lemonade Engine', endpoint: 'http://localhost:13305', selectedModel: 'Qwen3.5-4B-MTP-GGUF' },
    } as Node;

    function harnessNode(data: Record<string, any>): Node {
      return {
        id: 'harness-1',
        type: 'harnessNode',
        position: { x: 0, y: 0 },
        data: { label: 'Agent Harness', kind: 'trueforge', endpoint: 'http://localhost:8790', ...data },
      } as Node;
    }

    it('does not default providerIsLocal: an undeclared harness omits the flag and opts the layout into egress', () => {
      const result = compileGraph([lemonadeNode, harnessNode({})], []);
      const upstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'harness-1');
      expect(upstream.type).toBe('harness');
      expect(upstream.harness).not.toHaveProperty('providerIsLocal');
      expect(result.rawRouterConfig.egressPolicy).toBe('allow-egress');
    });

    it('emits an explicit providerIsLocal declaration and keeps local-only for a declared-local harness', () => {
      const result = compileGraph([lemonadeNode, harnessNode({ providerIsLocal: true })], []);
      const upstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'harness-1');
      expect(upstream.harness.providerIsLocal).toBe(true);
      expect(result.rawRouterConfig.egressPolicy).toBe('local-only');
    });

    it('emits providerIsLocal: false for a declared-remote harness and opts into egress', () => {
      const result = compileGraph([lemonadeNode, harnessNode({ providerIsLocal: false })], []);
      const upstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'harness-1');
      expect(upstream.harness.providerIsLocal).toBe(false);
      expect(result.rawRouterConfig.egressPolicy).toBe('allow-egress');
    });

    it('emits harness command/args/cwd from node data when present', () => {
      const result = compileGraph(
        [harnessNode({ kind: 'acp', endpoint: 'acp://goose', command: 'goose', args: ['acp', '--stdio'], cwd: '/tmp/agent-home' })],
        []
      );
      const upstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'harness-1');
      expect(upstream.harness.command).toBe('goose');
      expect(upstream.harness.args).toEqual(['acp', '--stdio']);
      expect(upstream.harness.cwd).toBe('/tmp/agent-home');
    });

    it('emits memory apiKey, recallTimeoutMs, autoCommitTurns, and openviking scopePrefixes from node data', () => {
      const nodes: Node[] = [
        {
          id: 'mem-1',
          type: 'memoryNode',
          position: { x: 0, y: 0 },
          data: {
            provider: 'openviking',
            endpoint: 'http://localhost:1933',
            apiKey: 'mem-secret-key',
            recallTimeoutMs: 2500,
            autoCommitTurns: 3,
            readingLevel: 'L1',
            scopePrefixes: ['viking://user/default', 'viking://shared'],
          },
        } as Node,
      ];
      const result = compileGraph(nodes, []);
      const memory = result.rawRouterConfig.memory;
      expect(memory).toBeDefined();
      expect(memory.apiKey).toBe('mem-secret-key');
      expect(memory.recallTimeoutMs).toBe(2500);
      expect(memory.autoCommitTurns).toBe(3);
      expect(memory.openviking).toEqual({
        readingLevel: 'L1',
        scopePrefixes: ['viking://user/default', 'viking://shared']
      });
    });

    it('omits the new memory settings when the node does not carry them', () => {
      const nodes: Node[] = [
        {
          id: 'mem-1',
          type: 'memoryNode',
          position: { x: 0, y: 0 },
          data: { provider: 'builtin' },
        } as Node,
      ];
      const result = compileGraph(nodes, []);
      const memory = result.rawRouterConfig.memory;
      expect(memory).toBeDefined();
      expect(memory).not.toHaveProperty('apiKey');
      expect(memory).not.toHaveProperty('recallTimeoutMs');
      expect(memory).not.toHaveProperty('autoCommitTurns');
      expect(memory.openviking).toBeUndefined();
    });
  });
});
