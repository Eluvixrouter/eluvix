import { describe, it, expect } from 'vitest';
import { compileGraph } from '../orchestration/compiler';
import { analyzeGraphDiagnostics } from '../orchestration/diagnostics';
import { decompileConfigToGraph } from '../orchestration/decompiler';
import { EXAMPLE_LAYOUTS } from '../layouts/examples';
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

    it('compiles Neuro-Symbolic CRS node into crsPolicy, upstream crs config, and crsSetup script', () => {
      const nodes: Node[] = [
        {
          id: 'sw-crs',
          type: 'switchyardNode',
          position: { x: 0, y: 0 },
          data: {
            strategy: 'stall-escalation',
            routes: [{ id: 'tier-1', name: 'Tier 1: CRS Verifier' }]
          }
        } as Node,
        {
          id: 'crs-1',
          type: 'crsNode',
          position: { x: 100, y: 0 },
          data: {
            crsPolicy: 'strict-zero-false-positive',
            slicerMode: 'backward-def-use',
            sanitizerArch: 'kasan-x86_64',
            targetSink: 'memcpy',
            stallThresholdSeconds: 240,
            defaultBitWidth: 16
          }
        } as Node,
        {
          id: 'vllm-1',
          type: 'vllmNode',
          position: { x: 200, y: 0 },
          data: { label: 'vLLM Verifier', endpoint: 'http://localhost:8000' }
        } as Node
      ];
      const edges = [
        { id: 'e-crs-sw', source: 'crs-1', target: 'sw-crs' } as any,
        { id: 'e-sw-vllm', source: 'sw-crs', target: 'vllm-1', sourceHandle: 'tier-1' } as any
      ];
      const result = compileGraph(nodes, edges);
      expect(result.rawRouterConfig.crsPolicy).toBe('strict-zero-false-positive');
      expect(result.rawRouterConfig.switchyard.crsPolicy).toBe('strict-zero-false-positive');
      expect(result.rawRouterConfig.switchyard.strategy).toBe('stall-escalation');
      const vllmUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'vllm-1');
      expect(vllmUpstream.crs).toEqual({
        enabled: true,
        policy: 'strict-zero-false-positive',
        slicerMode: 'backward-def-use',
        sanitizerArch: 'kasan-x86_64',
        targetSink: 'memcpy',
        stallThresholdSeconds: 240,
        defaultBitWidth: 16
      });
      expect(result.crsSetup).toContain('0xdffffc0000000000');
      expect(result.crsSetup).toContain('-fsanitize=address,undefined');
    });

    it('compiles VectorCraft Art MCP node into upstream vectorcraft config, harness mcpServers, and setup script', () => {
      const nodes: Node[] = [
        {
          id: 'vc-1',
          type: 'vectorcraftNode',
          position: { x: 0, y: 0 },
          data: {
            backendMode: 'headless',
            cliCommand: 'vectorcraft-cli',
            controlAddress: '127.0.0.1:7979',
            defaultPromptWorkflow: 'icon-set',
            autoApproveTier: 'canvas-draw',
            defaultExportFormat: 'svg',
            readRoots: ['/workspace/assets'],
            writeRoots: ['/workspace/exports']
          }
        } as Node,
        {
          id: 'gw-1',
          type: 'agentGatewayNode',
          position: { x: 150, y: 0 },
          data: { accessPolicy: 'restrictive' }
        } as Node,
        {
          id: 'harness-1',
          type: 'harnessNode',
          position: { x: 300, y: 0 },
          data: {
            label: 'ACP Artist Harness',
            kind: 'acp',
            endpoint: 'acp://goose',
            approvals: 'auto-approve-readonly'
          }
        } as Node
      ];
      const edges = [
        { id: 'e-vc-gw', source: 'vc-1', target: 'gw-1' } as any,
        { id: 'e-gw-harness', source: 'gw-1', target: 'harness-1' } as any
      ];
      const result = compileGraph(nodes, edges);

      expect(result.rawRouterConfig.vectorcraft).toEqual({
        enabled: true,
        cliCommand: 'vectorcraft-cli',
        backendMode: 'headless',
        controlAddress: '127.0.0.1:7979',
        defaultPromptWorkflow: 'icon-set',
        autoApproveTier: 'canvas-draw',
        defaultExportFormat: 'svg',
        readRoots: ['/workspace/assets'],
        writeRoots: ['/workspace/exports']
      });

      const harnessUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'harness-1');
      expect(harnessUpstream).toBeTruthy();
      expect(harnessUpstream.vectorcraft?.enabled).toBe(true);
      expect(harnessUpstream.harness.mcpServers).toEqual([
        expect.objectContaining({
          name: 'vectorcraft',
          transport: 'stdio',
          endpoint:
            'stdio://vectorcraft-cli mcp --headless --automation-read-root /workspace/assets --automation-write-root /workspace/exports'
        })
      ]);
      expect(harnessUpstream.harness.autoApproveTools).toContain('draw_shape');
      expect(harnessUpstream.harness.autoApproveTools).toContain('command_batch');
      expect(harnessUpstream.harness.autoApproveTools).not.toContain('ui_screenshot');

      const parsedGw = JSON.parse(result.agentGatewayJson);
      expect(parsedGw.gateways[0].mcpTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'vectorcraft',
            endpoint:
              'stdio://vectorcraft-cli mcp --headless --automation-read-root /workspace/assets --automation-write-root /workspace/exports'
          })
        ])
      );

      expect(result.vectorcraftSetup).toContain('claude mcp add vectorcraft');
      expect(result.vectorcraftSetup).toContain('--automation-write-root');
    });

    it('compiles multi-app ArtCraft Suite node into bundled harness mcpServers, gateway tools, and artcraftSetup', () => {
      const nodes: Node[] = [
        {
          id: 'ac-bundle-1',
          type: 'artcraftNode',
          position: { x: 0, y: 0 },
          data: {
            app: 'photocraft',
            enabledApps: ['photocraft', 'figcraft', 'cadcraft', 'craft-anything'],
            backendMode: 'remote',
            autoApproveTier: 'full-automation'
          }
        } as Node,
        {
          id: 'gw-ac',
          type: 'agentGatewayNode',
          position: { x: 150, y: 0 },
          data: { accessPolicy: 'restrictive' }
        } as Node,
        {
          id: 'harness-ac',
          type: 'harnessNode',
          position: { x: 300, y: 0 },
          data: {
            label: 'ACP Creative Studio Harness',
            kind: 'acp',
            endpoint: 'acp://goose',
            approvals: 'auto-approve-readonly'
          }
        } as Node
      ];
      const edges = [
        { id: 'e-ac-gw', source: 'ac-bundle-1', target: 'gw-ac' } as any,
        { id: 'e-gw-hac', source: 'gw-ac', target: 'harness-ac' } as any
      ];
      const result = compileGraph(nodes, edges);

      expect(result.rawRouterConfig.artcraft?.enabled).toBe(true);
      expect(result.rawRouterConfig.artcraft?.app).toBe('photocraft');
      expect(result.rawRouterConfig.artcraft?.enabledApps).toEqual([
        'photocraft',
        'figcraft',
        'cadcraft',
        'craft-anything'
      ]);

      const harnessUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'harness-ac');
      expect(harnessUpstream).toBeTruthy();
      expect(harnessUpstream.artcraft?.enabled).toBe(true);
      expect(harnessUpstream.harness.mcpServers.map((s: any) => s.name)).toEqual([
        'photocraft',
        'figcraft',
        'cadcraft',
        'craft-anything'
      ]);
      expect(harnessUpstream.harness.mcpServers[0].endpoint).toBe(
        'stdio://photocraft-cli mcp --bridge 127.0.0.1:9878'
      );
      expect(harnessUpstream.harness.mcpServers[1].endpoint).toBe(
        'stdio://figcraft-cli mcp --attach 127.0.0.1:7979'
      );
      expect(harnessUpstream.harness.mcpServers[3].endpoint).toBe(
        'stdio://craft-anything-cli mcp --deep --all-tools'
      );

      const parsedGw = JSON.parse(result.agentGatewayJson);
      expect(parsedGw.gateways[0].mcpTools.map((t: any) => t.name)).toEqual(
        expect.arrayContaining(['photocraft', 'figcraft', 'cadcraft', 'craft-anything'])
      );
      expect(result.artcraftSetup).toContain('claude mcp add photocraft');
      expect(result.artcraftSetup).toContain('claude mcp add figcraft');
      expect(result.artcraftSetup).toContain('claude mcp add cadcraft');
      expect(result.artcraftSetup).toContain('claude mcp add craft-anything');
    });

    it('compiles OpenCode + VectorCraft Art Studio layout (Bundled Example 19)', async () => {
      const { EXAMPLE_LAYOUTS } = await import('../layouts/examples/index');
      const studioLayout = EXAMPLE_LAYOUTS.find(l => l.id === 'opencode-vectorcraft-art-studio');
      expect(studioLayout).toBeDefined();

      const result = compileGraph(studioLayout!.nodes, studioLayout!.edges);
      expect(result.rawRouterConfig.vectorcraft?.enabled).toBe(true);
      expect(result.rawRouterConfig.vectorcraft?.cliCommand).toBe('vectorcraft-cli');
      expect(result.rawRouterConfig.vectorcraft?.defaultExportFormat).toBe('svg');

      const opencodeUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'opencode-harness-1');
      expect(opencodeUpstream).toBeDefined();
      expect(opencodeUpstream.type).toBe('harness');
      expect(opencodeUpstream.harness?.kind).toBe('opencode');
      expect(opencodeUpstream.harness?.providerIsLocal).toBe(true);
      expect(opencodeUpstream.vectorcraft?.enabled).toBe(true);

      // Verify mcpServers injected into the OpenCode harness
      expect(opencodeUpstream.harness.mcpServers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'vectorcraft',
            transport: 'stdio'
          })
        ])
      );

      // Verify autoApproveTools contains vectorcraft tools
      expect(opencodeUpstream.harness.autoApproveTools).toContain('draw_shape');
      expect(opencodeUpstream.harness.autoApproveTools).toContain('draw_path');
      expect(opencodeUpstream.harness.autoApproveTools).toContain('command_batch');

      // Verify Agent Gateway tool list
      const parsedGw = JSON.parse(result.agentGatewayJson);
      expect(parsedGw.gateways[0].mcpTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'vectorcraft'
          })
        ])
      );

      // Verify Lemonade multi-model routing upstreams replaced Claude
      const coderUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'lemonade-coder-1');
      expect(coderUpstream).toBeDefined();
      expect(coderUpstream.type).toBe('lemonade');
      expect(coderUpstream.models).toContain('qwen2.5-coder-7b');
      expect(coderUpstream.tier).toBe('tier-2');

      const reasoningUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'lemonade-reasoning-1');
      expect(reasoningUpstream).toBeDefined();
      expect(reasoningUpstream.type).toBe('lemonade');
      expect(reasoningUpstream.models).toContain('deepseek-r1-distill-qwen-14b');
      expect(reasoningUpstream.tier).toBe('tier-3');

      const visionUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'lemonade-vision-1');
      expect(visionUpstream).toBeDefined();
      expect(visionUpstream.type).toBe('lemonade');
      expect(visionUpstream.models).toContain('llama-3.2-11b-vision');
      expect(visionUpstream.tier).toBe('tier-4');
      expect(visionUpstream.capabilities).toContain('vision');

      // Verify Claude is not present
      const claudeUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'claude-code-artist-1');
      expect(claudeUpstream).toBeUndefined();
    });

    it('compiles FlashAttention-3 Warp-Specialized & Blackwell tcgen05 TMEM Cluster layout (Bundled Example 20)', async () => {
      const { EXAMPLE_LAYOUTS } = await import('../layouts/examples/index');
      const fa3Layout = EXAMPLE_LAYOUTS.find(l => l.id === 'fa3-warp-specialized-hopper-blackwell-cluster');
      expect(fa3Layout).toBeDefined();

      const result = compileGraph(fa3Layout!.nodes, fa3Layout!.edges);
      expect(result.rawRouterConfig.attentionPolicy).toBe('prefer-blackwell-tmem');
      expect(result.rawRouterConfig.switchyard?.attentionPolicy).toBe('prefer-blackwell-tmem');

      const blackwellUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'sglang-blackwell-1');
      expect(blackwellUpstream).toBeDefined();
      expect(blackwellUpstream.attentionKernel?.backend).toBe('blackwell-tcgen05-tmem');
      expect(blackwellUpstream.attentionKernel?.smArch).toBe('sm_100a');
      expect(blackwellUpstream.attentionKernel?.blackwellTmem).toBe(true);
      expect(blackwellUpstream.attentionKernel?.ctaPair2Sm).toBe(true);

      const hopperUpstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'vllm-hopper-fa3-1');
      expect(hopperUpstream).toBeDefined();
      expect(hopperUpstream.attentionKernel?.backend).toBe('fa3-fp8-hadamard');
      expect(hopperUpstream.attentionKernel?.smArch).toBe('sm_90a');
      expect(hopperUpstream.attentionKernel?.fp8HadamardIncoherent).toBe(true);

      expect(result.disaggregatedSetup).toContain('tcgen05.mma.cta_group::2.m256n128k32');
      expect(result.disaggregatedSetup).toContain('setmaxnreg.dec.sync.aligned.u32 40');
      expect(result.disaggregatedSetup).toContain('setmaxnreg.inc.sync.aligned.u32 232');
      expect(result.disaggregatedSetup).toContain('CU_TENSOR_MAP_SWIZZLE_128B');
    });

    it('compiles ramalamaNode alongside lemonadeNode and ollamaNode with OCI container & runtime settings', () => {
      const nodes: Node[] = [
        switchyardNode,
        {
          id: 'ramalama-1',
          type: 'ramalamaNode',
          position: { x: 100, y: 100 },
          data: {
            label: 'RamaLama OCI Runner',
            endpoint: 'http://localhost:8080',
            selectedModel: 'granite-code:8b',
            priority: 21,
            ramalama: {
              containerEngine: 'podman',
              runtime: 'vllm',
              ociTransport: 'oci',
              accelerator: 'cuda',
              selinuxEnforcing: true,
              ctxSize: 16384,
              ngl: 99,
            },
          },
        },
      ];
      const edges = [{ id: 'e-rama', source: 'sw-1', target: 'ramalama-1', sourceHandle: 'tier-1' } as any];
      const result = compileGraph(nodes, edges);

      const upstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'ramalama-1');
      expect(upstream).toBeDefined();
      expect(upstream.type).toBe('ramalama');
      expect(upstream.name).toBe('RamaLama OCI Runner');
      expect(upstream.endpoint).toBe('http://localhost:8080');
      expect(upstream.models).toEqual(['granite-code:8b']);
      expect(upstream.tier).toBe('tier-1');
      expect(upstream.maxComplexityScore).toBe(4);
      expect(upstream.ramalama).toEqual({
        containerEngine: 'podman',
        runtime: 'vllm',
        ociTransport: 'oci',
        accelerator: 'cuda',
        selinuxEnforcing: true,
        ctxSize: 16384,
        ngl: 99,
      });
      expect(result.rawRouterConfig.egressPolicy).toBe('local-only');
      expect(result.bifrostYaml).toContain('type: ramalama');
      expect(result.bifrostYaml).toContain('container_engine: podman');
      expect(result.bifrostYaml).toContain('runtime: vllm');
      expect(result.bifrostYaml).toContain('oci_transport: oci');
      expect(result.ramalamaSetup).toContain('[Container]');
      expect(result.ramalamaSetup).toContain('Image=quay.io/ramalama/cuda:latest');
      expect(result.ramalamaSetup).toContain('SecurityLabelType=container_engine_t');
      expect(result.ramalamaSetup).toContain('PublishPort=8080:8080');
    });

    it('wires knowledgeBaseNode (--rag) and airgapped sandboxNode (--network=none) into ramalamaNode and Quadlet output', () => {
      const nodes: Node[] = [
        switchyardNode,
        {
          id: 'kb-1',
          type: 'knowledgeBaseNode',
          position: { x: 100, y: 300 },
          data: {
            provider: 'openviking',
            collectionUri: 'oci://quay.io/eluvix/docs-rag:v1',
          },
        },
        {
          id: 'sb-1',
          type: 'sandboxNode',
          position: { x: 100, y: 420 },
          data: {
            networkPolicy: 'none',
          },
        },
        {
          id: 'ramalama-rag-1',
          type: 'ramalamaNode',
          position: { x: 400, y: 200 },
          data: {
            label: 'Airgapped RamaLama RAG',
            endpoint: 'http://localhost:8080',
            selectedModel: 'llama3.2:3b',
          },
        },
      ];
      const edges = [
        { id: 'e-sw', source: 'sw-1', target: 'ramalama-rag-1', sourceHandle: 'tier-1' },
        { id: 'e-kb', source: 'kb-1', target: 'ramalama-rag-1' },
        { id: 'e-sb', source: 'sb-1', target: 'ramalama-rag-1' },
      ] as any;

      const result = compileGraph(nodes, edges);
      const upstream = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'ramalama-rag-1');
      expect(upstream.ramalama.ragOciUri).toBe('oci://quay.io/eluvix/docs-rag:v1');
      expect(upstream.ramalama.networkIsolation).toBe('none');
      expect(upstream.ramalama.selinuxEnforcing).toBe(true);
      expect(upstream.ramalama.readOnlyRootfs).toBe(true);
      expect(result.ramalamaSetup).toContain("--rag 'oci://quay.io/eluvix/docs-rag:v1'");
      expect(result.ramalamaSetup).toContain('--network=none');
      expect(result.ramalamaSetup).toContain('Network=none');
    });

    it('compiles Sovereign OCI Container Triad layout (Bundled Example 21) and round-trips via decompileConfigToGraph', async () => {
      const { EXAMPLE_LAYOUTS } = await import('../layouts/examples/index');
      const triadLayout = EXAMPLE_LAYOUTS.find(
        (l) => l.id === 'sovereign-oci-ramalama-lemonade-ollama-triad'
      );
      expect(triadLayout).toBeDefined();

      const result = compileGraph(triadLayout!.nodes, triadLayout!.edges);
      expect(result.rawRouterConfig.egressPolicy).toBe('local-only');

      const ramaUp = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'ramalama-triad-1');
      const lemUp = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'lemonade-triad-1');
      const ollUp = result.rawRouterConfig.upstreams.find((u: any) => u.id === 'ollama-triad-1');
      expect(ramaUp?.type).toBe('ramalama');
      expect(ramaUp?.ramalama?.ragOciUri).toBe('oci://quay.io/eluvix/codebase-rag:latest');
      expect(lemUp?.type).toBe('lemonade');
      expect(ollUp?.type).toBe('ollama');

      // Decompile back to React Flow graph
      const decompiled = decompileConfigToGraph(result.rawRouterConfig);
      expect(decompiled.nodes.some((n) => n.type === 'ramalamaNode' && n.id === 'ramalama-triad-1')).toBe(true);
      expect(decompiled.nodes.some((n) => n.type === 'lemonadeNode' && n.id === 'lemonade-triad-1')).toBe(true);
      expect(decompiled.nodes.some((n) => n.type === 'ollamaNode' && n.id === 'ollama-triad-1')).toBe(true);
      expect(decompiled.nodes.some((n) => n.type === 'privacyGuardNode')).toBe(true);
      expect(decompiled.nodes.some((n) => n.type === 'semanticGuardNode')).toBe(true);
      expect(decompiled.nodes.some((n) => n.type === 'knowledgeBaseNode')).toBe(true);
    });

    it('detects port collisions across distinct engine types while permitting shared ports for the same engine type', () => {
      const collisionNodes: Node[] = [
        {
          id: 'rama-1',
          type: 'ramalamaNode',
          position: { x: 0, y: 0 },
          data: { endpoint: 'http://localhost:8000', selectedModel: 'granite:8b' },
        },
        {
          id: 'vllm-1',
          type: 'vllmNode',
          position: { x: 0, y: 200 },
          data: { endpoint: 'http://127.0.0.1:8000', selectedModel: 'llama3:70b' },
        },
        {
          id: 'lem-a',
          type: 'lemonadeNode',
          position: { x: 0, y: 400 },
          data: { endpoint: 'http://localhost:13305', selectedModel: 'qwen:7b' },
        },
        {
          id: 'lem-b',
          type: 'lemonadeNode',
          position: { x: 0, y: 500 },
          data: { endpoint: 'http://localhost:13305', selectedModel: 'llama:3b' },
        },
      ];

      const report = analyzeGraphDiagnostics(collisionNodes, [], 24);
      const portCollisions = report.diagnostics.filter((d) => d.code === 'PORT_COLLISION');
      expect(portCollisions).toHaveLength(1);
      expect(portCollisions[0].details?.hostPort).toBe('localhost:8000');
      expect(portCollisions[0].nodeIds).toEqual(['rama-1', 'vllm-1']);

      const vramWarnings = report.diagnostics.filter((d) => d.code === 'VRAM_OVERCOMMIT');
      expect(vramWarnings).toHaveLength(1);
      expect(report.estimatedTotalVramGb).toBeGreaterThan(24);
    });

    it('compiles ComfyUINode with LLM Prompt Enhancer, ArtCraft Post-Processing, Harness MCP, and Reverse Loopback (4 Pillars)', () => {
      const comfyLayout = EXAMPLE_LAYOUTS.find(
        (l) => l.id === 'comfyui-flux-artcraft-creative-pipeline'
      );
      expect(comfyLayout).toBeDefined();

      const result = compileGraph(comfyLayout!.nodes, comfyLayout!.edges);
      const comfyUp = result.rawRouterConfig.upstreams.find(
        (u: any) => u.id === 'comfyui-studio-1'
      );
      expect(comfyUp).toBeDefined();
      expect(comfyUp.type).toBe('comfyui');
      expect(comfyUp.endpoint).toBe('http://localhost:8188');
      expect(comfyUp.comfyui.workflowPreset).toBe('flux-txt2img');
      expect(comfyUp.comfyui.promptEnhancerUpstreamId).toBe('lemonade-enhancer-1');
      expect(comfyUp.comfyui.postProcessArtCraftApp).toBe('vectorcraft');
      expect(comfyUp.comfyui.loopbackEluvixUrl).toBe('http://127.0.0.1:3588/v1');
      expect(comfyUp.comfyui.vramMode).toBe('lowvram');
      expect(comfyUp.comfyui.reserveVramGb).toBe(6);

      expect(result.comfyuiSetup).toContain('--lowvram');
      expect(result.comfyuiSetup).toContain('--reserve-vram 6');
      expect(result.comfyuiSetup).toContain("OPENAI_API_BASE='http://127.0.0.1:3588/v1'");
      expect(result.bifrostYaml).toContain('type: comfyui');
      expect(result.bifrostYaml).toContain('workflow_preset: flux-txt2img');

      // Decompile and verify comfyuiNode + prompt enhancer edge round-trip
      const decompiled = decompileConfigToGraph(result.rawRouterConfig);
      expect(
        decompiled.nodes.some((n) => n.type === 'comfyuiNode' && n.id === 'comfyui-studio-1')
      ).toBe(true);
      expect(
        decompiled.edges.some(
          (e) => e.source === 'lemonade-enhancer-1' && e.target === 'comfyui-studio-1'
        )
      ).toBe(true);
    });
  });
});
