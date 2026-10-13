import { describe, it, expect } from 'vitest';
import { compileGraph } from '../orchestration/compiler';
import { validateConfig } from '../router';
import { Node, Edge } from '@xyflow/react';

describe('Cloud LLM Providers Compilation Suite', () => {
  it('compiles a billamaNode into a native Billama upstream and Bifrost gateway', () => {
    const nodes: Node[] = [
      {
        id: 'billama-1',
        type: 'billamaNode',
        position: { x: 100, y: 100 },
        data: {
          label: 'Billama Cloud Production',
          endpoint: 'https://api.billama.dev',
          apiKey: 'billama_sk_test_12345',
          priority: 18,
          costPer1kTokens: 0.002,
          selectedModel: 'llama-3.3-70b',
          models: ['llama-3.3-70b', 'deepseek-r1', '*'],
          visionCapable: true
        }
      }
    ];
    const edges: Edge[] = [];

    const result = compileGraph(nodes, edges);

    // Verify raw router config
    expect(result.rawRouterConfig).toBeDefined();
    expect(result.rawRouterConfig.upstreams).toHaveLength(1);
    const upstream = result.rawRouterConfig.upstreams[0];
    expect(upstream.id).toBe('billama-1');
    expect(upstream.name).toBe('Billama Cloud Production');
    expect(upstream.type).toBe('billama');
    expect(upstream.endpoint).toBe('https://api.billama.dev');
    expect(upstream.apiKey).toBe('billama_sk_test_12345');
    expect(upstream.priority).toBe(18);
    expect(upstream.models).toEqual(['llama-3.3-70b']);
    expect(upstream.costPer1kTokens).toBe(0.002);
    expect(upstream.capabilities).toContain('vision');

    // Verify validation
    expect(() => validateConfig(result.rawRouterConfig)).not.toThrow();

    // Verify Bifrost YAML
    expect(result.bifrostYaml).toContain('type: billama');
    expect(result.bifrostYaml).toContain('api_base: https://api.billama.dev');
    expect(result.bifrostYaml).toContain('selected_model: "llama-3.3-70b"');
    expect(result.bifrostYaml).toContain('priority: 18');
    expect(result.bifrostYaml).toContain('api_key: "billama_sk_test_12345"');
  });

  it('compiles an openaiNode into a native openai-compatible upstream and Bifrost gateway', () => {
    const nodes: Node[] = [
      {
        id: 'openai-1',
        type: 'openaiNode',
        position: { x: 100, y: 100 },
        data: {
          label: 'OpenAI Direct Frontier',
          endpoint: 'https://api.openai.com/v1',
          apiKey: 'sk-proj-test_secret_key',
          organization: 'org-eluvix-testing',
          priority: 12,
          costPer1kTokens: 0.005,
          selectedModel: 'gpt-4o',
          models: ['gpt-4o', 'o1', 'o3-mini', '*'],
          visionCapable: true
        }
      }
    ];
    const edges: Edge[] = [];

    const result = compileGraph(nodes, edges);

    // Verify raw router config
    expect(result.rawRouterConfig).toBeDefined();
    expect(result.rawRouterConfig.upstreams).toHaveLength(1);
    const upstream = result.rawRouterConfig.upstreams[0];
    expect(upstream.id).toBe('openai-1');
    expect(upstream.name).toBe('OpenAI Direct Frontier');
    expect(upstream.type).toBe('openai-compatible');
    expect(upstream.endpoint).toBe('https://api.openai.com/v1');
    expect(upstream.apiKey).toBe('sk-proj-test_secret_key');
    expect(upstream.organization).toBe('org-eluvix-testing');
    expect(upstream.priority).toBe(12);
    expect(upstream.models).toEqual(['gpt-4o']);
    expect(upstream.costPer1kTokens).toBe(0.005);
    expect(upstream.capabilities).toContain('vision');

    // Verify validation
    expect(() => validateConfig(result.rawRouterConfig)).not.toThrow();

    // Verify Bifrost YAML
    expect(result.bifrostYaml).toContain('type: openai-compatible');
    expect(result.bifrostYaml).toContain('api_base: https://api.openai.com/v1');
    expect(result.bifrostYaml).toContain('selected_model: "gpt-4o"');
    expect(result.bifrostYaml).toContain('priority: 12');
    expect(result.bifrostYaml).toContain('api_key: "sk-proj-test_secret_key"');
  });

  it('compiles a multi-tier hybrid architecture with Switchyard, Billama, and OpenAI', () => {
    const nodes: Node[] = [
      {
        id: 'input-1',
        type: 'inputNode',
        position: { x: 50, y: 150 },
        data: { label: 'Client Ingress' }
      },
      {
        id: 'switchyard-1',
        type: 'switchyardNode',
        position: { x: 300, y: 150 },
        data: {
          strategy: 'cost-complexity',
          failover: 'enabled',
          routes: [
            { id: 'tier-1', name: 'Tier 1: Local Low-Cost', costLabel: '$0.00' },
            { id: 'tier-2', name: 'Tier 2: Billama Cloud', costLabel: '$0.002' },
            { id: 'tier-3', name: 'Tier 3: OpenAI Direct', costLabel: '$0.005' }
          ]
        }
      },
      {
        id: 'lemonade-1',
        type: 'lemonadeNode',
        position: { x: 600, y: 50 },
        data: {
          label: 'Lemonade Fast Engine',
          endpoint: 'http://localhost:13305',
          priority: 30,
          selectedModel: '*'
        }
      },
      {
        id: 'billama-1',
        type: 'billamaNode',
        position: { x: 600, y: 200 },
        data: {
          label: 'Billama Llama-3.3-70b',
          endpoint: 'https://api.billama.dev',
          apiKey: 'billama_sk_live',
          priority: 20,
          selectedModel: 'llama-3.3-70b'
        }
      },
      {
        id: 'openai-1',
        type: 'openaiNode',
        position: { x: 600, y: 350 },
        data: {
          label: 'OpenAI GPT-4o Frontier',
          endpoint: 'https://api.openai.com/v1',
          apiKey: 'sk-proj-live',
          priority: 10,
          selectedModel: 'gpt-4o'
        }
      }
    ];

    const edges: Edge[] = [
      { id: 'e-in-sw', source: 'input-1', target: 'switchyard-1' },
      { id: 'e-sw-t1', source: 'switchyard-1', sourceHandle: 'tier-1', target: 'lemonade-1' },
      { id: 'e-sw-t2', source: 'switchyard-1', sourceHandle: 'tier-2', target: 'billama-1' },
      { id: 'e-sw-t3', source: 'switchyard-1', sourceHandle: 'tier-3', target: 'openai-1' }
    ];

    const result = compileGraph(nodes, edges);

    expect(result.rawRouterConfig.upstreams).toHaveLength(3);
    const upstreamIds = result.rawRouterConfig.upstreams.map((u: any) => u.id);
    expect(upstreamIds).toContain('lemonade-1');
    expect(upstreamIds).toContain('billama-1');
    expect(upstreamIds).toContain('openai-1');

    // Validate tier assignments from switchyard handles
    const billamaUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'billama-1');
    expect(billamaUpstream.tier).toBe('tier-2');
    expect(billamaUpstream.tierName).toBe('Tier 2: Billama Cloud');

    const openaiUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'openai-1');
    expect(openaiUpstream.tier).toBe('tier-3');
    expect(openaiUpstream.tierName).toBe('Tier 3: OpenAI Direct');

    // Validate overall configuration against router schema validator
    expect(() => validateConfig(result.rawRouterConfig)).not.toThrow();

    // Validate Bifrost YAML tiers and targets
    expect(result.bifrostYaml).toContain('targets: ["billama-1"]');
    expect(result.bifrostYaml).toContain('targets: ["openai-1"]');
    expect(result.bifrostYaml).toContain('targets: ["lemonade-1"]');
  });

  it('compiles a claudeNode into a native Anthropic upstream and Bifrost gateway', () => {
    const nodes: Node[] = [
      {
        id: 'claude-1',
        type: 'claudeNode',
        position: { x: 100, y: 100 },
        data: {
          label: 'Anthropic Claude 3.7',
          endpoint: 'https://api.anthropic.com/v1',
          apiKey: 'sk-ant-api03-test_token_123',
          priority: 15,
          costPer1kTokens: 0.003,
          selectedModel: 'claude-3-7-sonnet',
          models: ['claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku', '*'],
          visionCapable: true
        }
      }
    ];
    const edges: Edge[] = [];

    const result = compileGraph(nodes, edges);

    // Verify raw router config
    expect(result.rawRouterConfig).toBeDefined();
    expect(result.rawRouterConfig.upstreams).toHaveLength(1);
    const upstream = result.rawRouterConfig.upstreams[0];
    expect(upstream.id).toBe('claude-1');
    expect(upstream.name).toBe('Anthropic Claude 3.7');
    expect(upstream.type).toBe('anthropic');
    expect(upstream.endpoint).toBe('https://api.anthropic.com/v1');
    expect(upstream.apiKey).toBe('sk-ant-api03-test_token_123');
    expect(upstream.priority).toBe(15);
    expect(upstream.models).toEqual(['claude-3-7-sonnet']);
    expect(upstream.costPer1kTokens).toBe(0.003);
    expect(upstream.capabilities).toContain('vision');

    // Verify validation
    expect(() => validateConfig(result.rawRouterConfig)).not.toThrow();

    // Verify Bifrost YAML
    expect(result.bifrostYaml).toContain('type: anthropic');
    expect(result.bifrostYaml).toContain('api_base: https://api.anthropic.com/v1');
    expect(result.bifrostYaml).toContain('selected_model: "claude-3-7-sonnet"');
    expect(result.bifrostYaml).toContain('priority: 15');
    expect(result.bifrostYaml).toContain('api_key: "sk-ant-api03-test_token_123"');
  });

  it('supports simultaneous routing to both OpenAI Direct (cloud) and OpenAI Codex (agent)', () => {
    const nodes: Node[] = [
      {
        id: 'openai-1',
        type: 'openaiNode',
        position: { x: 100, y: 100 },
        data: {
          label: 'OpenAI Direct API',
          endpoint: 'https://api.openai.com/v1',
          apiKey: 'sk-proj-direct',
          selectedModel: 'gpt-4o'
        }
      },
      {
        id: 'codex-1',
        type: 'codexNode',
        position: { x: 100, y: 300 },
        data: {
          label: 'OpenAI Codex Sandbox Agent',
          model: 'o3-mini',
          reasoningEffort: 'high',
          environment: 'local-sandbox'
        }
      }
    ];
    const edges: Edge[] = [];

    const result = compileGraph(nodes, edges);

    expect(result.rawRouterConfig.upstreams).toHaveLength(2);
    const cloudUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'openai-1');
    const agentUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'codex-1');

    expect(cloudUpstream).toBeDefined();
    expect(cloudUpstream.type).toBe('openai-compatible');
    expect(cloudUpstream.endpoint).toBe('https://api.openai.com/v1');

    expect(agentUpstream).toBeDefined();
    expect(agentUpstream.codex).toBeDefined();
    expect(agentUpstream.codex.model).toBe('o3-mini');
    expect(agentUpstream.codex.reasoningEffort).toBe('high');

    // Bifrost should output both gateways
    expect(result.bifrostYaml).toContain('type: openai-compatible');
    expect(result.bifrostYaml).toContain('type: codex');
    expect(result.codexConfig).toContain('o3-mini');
  });
});
