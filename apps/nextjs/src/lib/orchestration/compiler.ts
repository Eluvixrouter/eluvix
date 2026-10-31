import { Node, Edge } from '@xyflow/react';
import {
  escapeShellArg,
  sanitizeSafeIdentifier,
  sanitizeIpv6SegmentList,
  sanitizePositiveInt
} from '@eluvix/router-core/shell-utils';

export interface CompilationResult {
  bifrostYaml: string;
  agentRouterJson: string;
  semanticRouterSetup: string;
  privacyGuardSetup: string;
  agentGatewayJson: string;
  observabilitySetup: string;
  antigravityConfig: string;
  codexConfig: string;
  claudeCodeConfig: string;
  eluvixJson: string;
  disaggregatedSetup: string;
  confidentialSetup?: string;
  rawRouterConfig: any;
}

export function compileGraph(nodes: Node[], edges: Edge[]): CompilationResult {
  // 1. Extract Local Engine Nodes (Lemonade, vLLM, SGLang, Ollama) and Cloud Providers (Billama, OpenAI, Claude)
  const localEngineNodes = nodes.filter(n => n.type === 'lemonadeNode' || n.type === 'vllmNode' || n.type === 'sglangNode' || n.type === 'ollamaNode');
  const vllmNodes = nodes.filter(n => n.type === 'vllmNode');
  const sglangNodes = nodes.filter(n => n.type === 'sglangNode');
  const billamaNodes = nodes.filter(n => n.type === 'billamaNode');
  const openaiNodes = nodes.filter(n => n.type === 'openaiNode');
  const claudeNodes = nodes.filter(n => n.type === 'claudeNode');
  const switchyardNodes = nodes.filter(n => n.type === 'switchyardNode');
  const antigravityNodes = nodes.filter(n => n.type === 'antigravityNode');
  const codexNodes = nodes.filter(n => n.type === 'codexNode');
  const claudeCodeNodes = nodes.filter(n => n.type === 'claudeCodeNode');
  const harnessNodes = nodes.filter(n => n.type === 'harnessNode');
  const memoryNodes = nodes.filter(n => n.type === 'memoryNode');
  const sandboxNodes = nodes.filter(n => n.type === 'sandboxNode');
  const knowledgeBaseNodes = nodes.filter(n => n.type === 'knowledgeBaseNode');
  const semanticCacheNodes = nodes.filter(n => n.type === 'semanticCacheNode');
  const consensusNodes = nodes.filter(n => n.type === 'consensusNode');
  const fallbackChainNodes = nodes.filter(n => n.type === 'fallbackChainNode');
  const confidentialEnclaveNodes = nodes.filter(n => n.type === 'confidentialEnclaveNode');
  
  // 2. Extract Bifrost (ModelGateway) Configurations
  const modelGateways = nodes.filter(n => n.type === 'modelGatewayNode');
  const bifrostConfig = generateBifrostYaml(
    modelGateways,
    localEngineNodes,
    switchyardNodes,
    edges,
    antigravityNodes,
    codexNodes,
    claudeCodeNodes,
    billamaNodes,
    openaiNodes,
    claudeNodes,
    harnessNodes
  );

  // 3. Extract Agent Router Configurations
  const taskRouters = nodes.filter(n => n.type === 'taskRouterNode');
  const agentNodes = nodes.filter(n => n.type === 'agentNode');
  const mcpTools = nodes.filter(n => n.type === 'mcpToolNode');
  const agentRouterConfig = generateAgentRouterJson(taskRouters, agentNodes, mcpTools, edges);

  // 4. Extract Semantic Router Configurations
  const semanticGuards = nodes.filter(n => n.type === 'semanticGuardNode');
  const semanticRouterConfig = generateSemanticRouterSetup(semanticGuards);

  // 5. Extract Privacy Guard Configurations
  const privacyGuards = nodes.filter(n => n.type === 'privacyGuardNode');
  const privacyGuardConfig = generatePrivacyGuardSetup(privacyGuards);

  // 6. Extract Agent Gateway Configurations
  const agentGateways = nodes.filter(n => n.type === 'agentGatewayNode');
  const agentGatewayConfig = generateAgentGatewayJson(agentGateways, mcpTools, edges);

  // 7. Extract Observability Configurations
  const observabilityNodes = nodes.filter(n => n.type === 'observabilityNode');
  const observabilityConfig = generateObservabilitySetup(observabilityNodes);

  // 8. Extract Autonomous Agent Configurations (AGY, Codex, Claude Code)
  const antigravityConfig = generateAntigravitySetup(antigravityNodes, edges);
  const codexConfig = generateCodexSetup(codexNodes, edges);
  const claudeCodeConfig = generateClaudeCodeSetup(claudeCodeNodes, edges);

  // 9. Generate Native Eluvix JSON Configuration
  const rawRouterConfig = generateEluvixConfig(
    localEngineNodes,
    modelGateways,
    semanticGuards,
    privacyGuards,
    switchyardNodes,
    edges,
    antigravityNodes,
    codexNodes,
    claudeCodeNodes,
    billamaNodes,
    openaiNodes,
    claudeNodes,
    harnessNodes,
    memoryNodes,
    sandboxNodes,
    knowledgeBaseNodes,
    semanticCacheNodes,
    consensusNodes,
    fallbackChainNodes,
    confidentialEnclaveNodes
  );

  return {
    bifrostYaml: bifrostConfig,
    agentRouterJson: agentRouterConfig,
    semanticRouterSetup: semanticRouterConfig,
    privacyGuardSetup: privacyGuardConfig,
    agentGatewayJson: agentGatewayConfig,
    observabilitySetup: observabilityConfig,
    antigravityConfig,
    codexConfig,
    claudeCodeConfig,
    eluvixJson: JSON.stringify(rawRouterConfig, null, 2),
    disaggregatedSetup: generateDisaggregatedLaunchScripts(vllmNodes, sglangNodes),
    confidentialSetup: generateConfidentialAttestationSetup(confidentialEnclaveNodes, localEngineNodes),
    rawRouterConfig
  };
}

function generateEluvixConfig(
  localEngines: Node[],
  modelGateways: Node[],
  semanticGuards: Node[],
  privacyGuards: Node[],
  switchyardNodes: Node[] = [],
  edges: Edge[] = [],
  antigravityNodes: Node[] = [],
  codexNodes: Node[] = [],
  claudeCodeNodes: Node[] = [],
  billamaNodes: Node[] = [],
  openaiNodes: Node[] = [],
  claudeNodes: Node[] = [],
  harnessNodes: Node[] = [],
  memoryNodes: Node[] = [],
  sandboxNodes: Node[] = [],
  knowledgeBaseNodes: Node[] = [],
  semanticCacheNodes: Node[] = [],
  consensusNodes: Node[] = [],
  fallbackChainNodes: Node[] = [],
  confidentialEnclaveNodes: Node[] = []
): any {
  const upstreams: any[] = [];
  const switchyard = switchyardNodes[0];
  const switchyardStrategy = String(switchyard?.data?.strategy || 'cost-complexity');
  const routes: Array<{ id: string; name: string; costLabel?: string }> = 
    Array.isArray(switchyard?.data?.routes) ? switchyard.data.routes : [];

  // Map each connected engine node from Switchyard's output handles.
  // A tier expresses routing preference (ordering + default cost) ONLY. It
  // must never shrink an upstream's capability cap: wiring Lemonade into
  // tier-1 used to compile maxComplexityScore 1, which declared it incapable
  // of nearly every real prompt and silently escalated traffic to later
  // tiers (including cloud/agent upstreams the user never asked for).
  const tierMap = new Map<string, { tierId: string; tierName: string; costPer1kTokens: number }>();

  if (switchyard) {
    const outgoingEdges = edges.filter(e => e.source === switchyard.id);
    outgoingEdges.forEach((edge, idx) => {
      const handleId = edge.sourceHandle || (routes[idx] ? routes[idx].id : `tier-${idx + 1}`);
      const route = routes.find(r => r.id === handleId);

      let cost = 0.0;
      if (handleId === 'tier-4') {
        cost = 0.003;
      } else if (handleId !== 'tier-1' && handleId !== 'tier-2' && handleId !== 'tier-3') {
        cost = idx * 0.002;
      }

      tierMap.set(edge.target, {
        tierId: handleId,
        tierName: route?.name || handleId,
        costPer1kTokens: cost
      });
    });
  }

  // Capability is a property of the engine/model serving the upstream: an
  // explicit per-node value when provided, otherwise unbounded (the router
  // core treats a missing cap as 4). Tier wiring never lowers it.
  const capabilityCap = (node: Node): number => {
    const n = Number((node.data as any)?.maxComplexityScore);
    return Number.isFinite(n) && n >= 1 && n <= 4 ? n : 4;
  };

  localEngines.forEach(node => {
    let type = 'lemonade';
    let defaultEndpoint = 'http://localhost:13305';
    let defaultName = 'Lemonade Engine';

    if (node.type === 'vllmNode') {
      type = 'vllm';
      defaultEndpoint = 'http://localhost:8000';
      defaultName = 'vLLM Engine';
    } else if (node.type === 'sglangNode') {
      type = 'sglang';
      defaultEndpoint = 'http://localhost:30000';
      defaultName = 'SGLang Engine';
    } else if (node.type === 'ollamaNode') {
      type = 'ollama';
      defaultEndpoint = 'http://localhost:11434';
      defaultName = 'Ollama Engine';
    }

    const discovered = Array.isArray(node.data?.models) ? (node.data?.models as string[]) : [];
    const selected = node.data?.selectedModel && node.data.selectedModel !== '*'
      ? [String(node.data.selectedModel)]
      : (discovered.length > 0 ? discovered : ['*']);

    const tierInfo = tierMap.get(node.id) || {
      tierId: type === 'lemonade' ? 'tier-1' : 'tier-2',
      tierName: type === 'lemonade' ? 'Tier 1: Local Fast' : 'Tier 2: Local Reasoning',
      costPer1kTokens: 0.0
    };

    const primaryEnclave = confidentialEnclaveNodes[0];
    const enclaveData = (primaryEnclave?.data || {}) as Record<string, any>;
    const nodeConfidential = (node.data as any)?.confidential;
    const connectedToEnclave =
      confidentialEnclaveNodes.some(enclave => {
        const direct = edges.some(
          e => (e.source === enclave.id && e.target === node.id) || (e.target === enclave.id && e.source === node.id)
        );
        if (direct) return true;
        const enclaveToSwitchyard = edges.some(
          e => (e.source === enclave.id && switchyardNodes.some(s => s.id === e.target)) ||
               (e.target === enclave.id && switchyardNodes.some(s => s.id === e.source))
        );
        const switchyardToNode = edges.some(
          e => (switchyardNodes.some(s => s.id === e.source) && e.target === node.id) ||
               (switchyardNodes.some(s => s.id === e.target) && e.source === node.id)
        );
        return enclaveToSwitchyard && switchyardToNode;
      });

    const confidentialCfg =
      nodeConfidential?.enabled || connectedToEnclave
        ? {
            enabled: true,
            architecture:
              nodeConfidential?.architecture || enclaveData.architecture || 'sev-snp-h100-cc',
            kbsEndpoint:
              nodeConfidential?.kbsEndpoint || enclaveData.kbsEndpoint || 'https://kbs.internal.corp:8080',
            expectedMeasurement:
              nodeConfidential?.expectedMeasurement || enclaveData.expectedMeasurement,
            restrictedInjection:
              nodeConfidential?.restrictedInjection ?? enclaveData.restrictedInjection ?? true,
            spdmAttested: nodeConfidential?.spdmAttested ?? enclaveData.spdmAttested ?? true
          }
        : undefined;

    const disaggRaw = (node.data as any)?.disaggregation;
    const disaggregationConfig = disaggRaw ? { ...disaggRaw } : undefined;
    if (disaggregationConfig && disaggregationConfig.role === 'pd-pair') {
      disaggregationConfig.role = 'pd-disaggregated';
    }

    const quantRaw = (node.data as any)?.quantization;
    const quantizationConfig = quantRaw && quantRaw.enabled !== false && quantRaw.format !== 'bf16'
      ? { ...quantRaw }
      : undefined;

    const fabricRaw = (node.data as any)?.fabric;
    const fabricConfig = fabricRaw ? { ...fabricRaw } : undefined;

    upstreams.push({
      id: String(node.id),
      name: String(node.data?.label || defaultName),
      type,
      endpoint: String(node.data?.endpoint || defaultEndpoint),
      priority: Number(node.data?.priority || (type === 'lemonade' ? 25 : type === 'sglang' ? 24 : type === 'vllm' ? 22 : 20)),
      models: selected,
      tier: tierInfo.tierId,
      tierName: tierInfo.tierName,
      costPer1kTokens: tierInfo.costPer1kTokens,
      maxComplexityScore: capabilityCap(node),
      capabilities: node.data?.visionCapable ? ["vision"] : [],
      ...(node.data?.maxContextTokens ? { maxContextTokens: Number(node.data.maxContextTokens) } : {}),
      ...(node.data?.maxParallelRequests ? { maxParallelRequests: Number(node.data.maxParallelRequests) } : {}),
      ...(node.data?.monthlySpendLimit ? { monthlySpendLimit: Number(node.data.monthlySpendLimit) } : {}),
      ...(disaggregationConfig ? { disaggregation: disaggregationConfig } : {}),
      ...(confidentialCfg ? { confidential: confidentialCfg } : {}),
      ...(quantizationConfig ? { quantization: quantizationConfig } : {}),
      ...(fabricConfig ? { fabric: fabricConfig } : {})
    });
  });

  modelGateways.forEach(node => {
    const tierInfo = tierMap.get(node.id) || {
      tierId: 'tier-3',
      tierName: 'Tier 3: Economy Cloud',
      costPer1kTokens: 0.005
    };

    upstreams.push({
      id: String(node.id),
      name: String(node.data?.label || 'Cloud Fallback Gateway'),
      type: 'openai-compatible',
      endpoint: 'https://api.openai.com',
      priority: 5,
      models: [String(node.data?.primaryModel || 'gpt-4o')],
      tier: tierInfo.tierId,
      tierName: tierInfo.tierName,
      costPer1kTokens: tierInfo.costPer1kTokens,
      maxComplexityScore: capabilityCap(node),
      capabilities: node.data?.visionCapable ? ["vision"] : []
    });
  });

  antigravityNodes.forEach(node => {
    const modelId = node.data?.model === 'custom' 
      ? (node.data?.customModel || 'custom-agent') 
      : (node.data?.model || 'gemini-4-argon');
    const tierInfo = tierMap.get(node.id) || {
      tierId: 'tier-2',
      tierName: 'Tier 2: Antigravity Autonomous Agent',
      costPer1kTokens: 0.0
    };

    const execMode = node.data?.executionMode || 'cli';
    const cliPath = node.data?.cliPath || 'agy';
    // Use cli://agy for direct CLI invocation; use port 8002 for agent-router daemon (port 8080 is reserved for Switchyard)
    const endpoint = node.data?.endpoint || (execMode === 'cli' ? `cli://${cliPath}` : 'http://localhost:8002/v1');

    const agyModels = Array.from(new Set([
      String(modelId),
      'gemini-4-argon',
      'gemini-3.8-flash',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'gpt-oss-120b',
      '*'
    ]));

    upstreams.push({
      id: String(node.id),
      name: `Antigravity Agent (${modelId})`,
      type: execMode === 'cli' ? 'antigravity' : 'openai-compatible',
      endpoint: endpoint,
      priority: Number(node.data?.priority || 28),
      models: agyModels,
      tier: tierInfo.tierId,
      tierName: tierInfo.tierName,
      costPer1kTokens: tierInfo.costPer1kTokens,
      maxComplexityScore: capabilityCap(node),
      capabilities: node.data?.visionCapable ? ["vision"] : [],
      antigravity: {
        model: modelId,
        effort: node.data?.effort || 'auto',
        cleanHeadless: node.data?.cleanHeadless !== false,
        executionMode: execMode,
        cliPath: cliPath,
        endpoint: endpoint,
        sandbox: node.data?.sandboxMode || 'standard',
        behavior: node.data?.agentBehavior || 'autonomous',
        extendedThinking: node.data?.extendedThinking ?? true,
        thinkingBudget: node.data?.thinkingBudget ?? 2048,
        subagents: node.data?.enableSubagents ?? true,
        maxSubagentDepth: node.data?.maxSubagentDepth ?? 2
      }
    });
  });

  codexNodes.forEach(node => {
    const modelId = node.data?.model === 'custom' 
      ? (node.data?.customModel || 'custom-codex') 
      : (node.data?.model || 'o3-mini');
    const tierInfo = tierMap.get(node.id) || {
      tierId: 'tier-2',
      tierName: 'Tier 2: OpenAI Codex Autonomous Agent',
      costPer1kTokens: 0.001
    };

    upstreams.push({
      id: String(node.id),
      name: `OpenAI Codex (${modelId})`,
      type: 'openai-compatible',
      endpoint: 'http://localhost:8081/v1',
      priority: Number(node.data?.priority || 27),
      models: [modelId, '*'],
      tier: tierInfo.tierId,
      tierName: tierInfo.tierName,
      costPer1kTokens: tierInfo.costPer1kTokens,
      maxComplexityScore: capabilityCap(node),
      capabilities: node.data?.visionCapable ? ["vision"] : [],
      codex: {
        model: modelId,
        reasoningEffort: node.data?.reasoningEffort || 'medium',
        environment: node.data?.environment || 'local-sandbox',
        approvalMode: node.data?.approvalMode || 'confirm-risky',
        workingDirectory: node.data?.workingDirectory || './workspace',
        tools: {
          codeInterpreter: node.data?.enableCodeInterpreter !== false,
          bash: node.data?.enableBash !== false,
          fileEditor: node.data?.enableFileEditor !== false,
          webBrowsing: node.data?.enableWebBrowsing ?? true
        }
      }
    });
  });

  claudeCodeNodes.forEach(node => {
    const modelId = node.data?.model === 'custom' 
      ? (node.data?.customModel || 'custom-claude') 
      : (node.data?.model || 'claude-3-7-sonnet');
    const tierInfo = tierMap.get(node.id) || {
      tierId: 'tier-2',
      tierName: 'Tier 2: Claude Code Autonomous Agent',
      costPer1kTokens: 0.003
    };

    upstreams.push({
      id: String(node.id),
      name: `Claude Code Agent (${modelId})`,
      type: 'openai-compatible',
      endpoint: 'http://localhost:8082/v1',
      priority: Number(node.data?.priority || 26),
      models: [modelId, '*'],
      tier: tierInfo.tierId,
      tierName: tierInfo.tierName,
      costPer1kTokens: tierInfo.costPer1kTokens,
      maxComplexityScore: capabilityCap(node),
      capabilities: node.data?.visionCapable ? ["vision"] : [],
      claudeCode: {
        model: modelId,
        permissionMode: node.data?.permissionMode || 'accept-non-destructive',
        extendedThinking: node.data?.extendedThinking ?? true,
        thinkingBudget: node.data?.extendedThinking ? Number(node.data?.thinkingBudget ?? 4096) : 0,
        compactContext: node.data?.compactContext ?? true,
        subagents: node.data?.enableSubagents ?? true,
        maxSubagentDepth: Number(node.data?.maxSubagentDepth ?? 2),
        tools: {
          bash: node.data?.enableBashTool !== false,
          fileEdit: node.data?.enableFileEditTool !== false,
          grep: node.data?.enableGrepTool !== false,
          webFetch: node.data?.enableWebFetchTool ?? true
        }
      }
    });
  });

  billamaNodes.forEach(node => {
    const discovered = Array.isArray(node.data?.models) ? (node.data?.models as string[]) : [];
    const selected = node.data?.selectedModel && node.data.selectedModel !== '*'
      ? [String(node.data.selectedModel)]
      : (discovered.length > 0 ? discovered : ['llama-3.3-70b', 'deepseek-r1', '*']);

    const tierInfo = tierMap.get(node.id) || {
      tierId: 'tier-3',
      tierName: 'Tier 3: Billama Cloud',
      costPer1kTokens: Number(node.data?.costPer1kTokens ?? 0.002)
    };

    upstreams.push({
      id: String(node.id),
      name: String(node.data?.label || 'Billama Cloud Provider'),
      type: 'billama',
      endpoint: String(node.data?.endpoint || 'https://api.billama.dev'),
      ...(node.data?.apiKey ? { apiKey: String(node.data.apiKey) } : {}),
      priority: Number(node.data?.priority ?? 15),
      models: selected,
      tier: tierInfo.tierId,
      tierName: tierInfo.tierName,
      costPer1kTokens: Number(node.data?.costPer1kTokens ?? tierInfo.costPer1kTokens),
      maxComplexityScore: capabilityCap(node),
      capabilities: node.data?.visionCapable ? ["vision"] : [],
      ...(node.data?.maxContextTokens ? { maxContextTokens: Number(node.data.maxContextTokens) } : {}),
      ...(node.data?.maxParallelRequests ? { maxParallelRequests: Number(node.data.maxParallelRequests) } : {}),
      ...(node.data?.monthlySpendLimit ? { monthlySpendLimit: Number(node.data.monthlySpendLimit) } : {})
    });
  });

  openaiNodes.forEach(node => {
    const discovered = Array.isArray(node.data?.models) ? (node.data?.models as string[]) : [];
    const selected = node.data?.selectedModel && node.data.selectedModel !== '*'
      ? [String(node.data.selectedModel)]
      : (discovered.length > 0 ? discovered : ['gpt-4o', 'gpt-4o-mini', '*']);

    const tierInfo = tierMap.get(node.id) || {
      tierId: 'tier-4',
      tierName: 'Tier 4: OpenAI Cloud',
      costPer1kTokens: Number(node.data?.costPer1kTokens ?? 0.005)
    };

    upstreams.push({
      id: String(node.id),
      name: String(node.data?.label || 'OpenAI Direct Provider'),
      type: 'openai-compatible',
      endpoint: String(node.data?.endpoint || 'https://api.openai.com/v1'),
      ...(node.data?.apiKey ? { apiKey: String(node.data.apiKey) } : {}),
      ...(node.data?.organization ? { organization: String(node.data.organization) } : {}),
      priority: Number(node.data?.priority ?? 10),
      models: selected,
      tier: tierInfo.tierId,
      tierName: tierInfo.tierName,
      costPer1kTokens: Number(node.data?.costPer1kTokens ?? tierInfo.costPer1kTokens),
      maxComplexityScore: capabilityCap(node),
      capabilities: node.data?.visionCapable ? ["vision"] : [],
      ...(node.data?.maxContextTokens ? { maxContextTokens: Number(node.data.maxContextTokens) } : {}),
      ...(node.data?.maxParallelRequests ? { maxParallelRequests: Number(node.data.maxParallelRequests) } : {}),
      ...(node.data?.monthlySpendLimit ? { monthlySpendLimit: Number(node.data.monthlySpendLimit) } : {})
    });
  });

  claudeNodes.forEach(node => {
    const discovered = Array.isArray(node.data?.models) ? (node.data?.models as string[]) : [];
    const selected = node.data?.selectedModel && node.data.selectedModel !== '*'
      ? [String(node.data.selectedModel)]
      : (discovered.length > 0 ? discovered : ['claude-3-7-sonnet', 'claude-3-5-sonnet', '*']);

    const tierInfo = tierMap.get(node.id) || {
      tierId: 'tier-4',
      tierName: 'Tier 4: Anthropic Cloud',
      costPer1kTokens: Number(node.data?.costPer1kTokens ?? 0.003)
    };

    upstreams.push({
      id: String(node.id),
      name: String(node.data?.label || 'Anthropic Claude Provider'),
      type: 'anthropic',
      endpoint: String(node.data?.endpoint || 'https://api.anthropic.com/v1'),
      ...(node.data?.apiKey ? { apiKey: String(node.data.apiKey) } : {}),
      priority: Number(node.data?.priority ?? 10),
      models: selected,
      tier: tierInfo.tierId,
      tierName: tierInfo.tierName,
      costPer1kTokens: Number(node.data?.costPer1kTokens ?? tierInfo.costPer1kTokens),
      maxComplexityScore: capabilityCap(node),
      capabilities: node.data?.visionCapable ? ["vision"] : [],
      ...(node.data?.maxContextTokens ? { maxContextTokens: Number(node.data.maxContextTokens) } : {}),
      ...(node.data?.maxParallelRequests ? { maxParallelRequests: Number(node.data.maxParallelRequests) } : {}),
      ...(node.data?.monthlySpendLimit ? { monthlySpendLimit: Number(node.data.monthlySpendLimit) } : {})
    });
  });

  // Discover connected sandbox per harness node (or global first sandbox)
  const primarySandbox = sandboxNodes[0];

  harnessNodes.forEach(node => {
    const kind = String(node.data?.kind || 'trueforge');
    const agentId = String(node.data?.agentId || 'default');
    const defaultEndpoint =
      kind === 'trueforge'
        ? 'http://localhost:8790'
        : kind === 'opencode'
        ? 'http://localhost:4096'
        : kind === 'aider'
        ? 'aider://embedded'
        : kind === 'swe-agent'
        ? 'swe-agent://embedded'
        : kind === 'cline'
        ? 'cline://embedded'
        : kind === 'plandex'
        ? 'plandex://embedded'
        : kind === 'acp'
        ? 'acp://goose'
        : kind === 'openhands'
        ? 'http://localhost:3000'
        : kind === 'mastra'
        ? 'http://localhost:4111'
        : kind === 'letta'
        ? 'http://localhost:8283'
        : kind === 'a2a'
        ? 'http://localhost:8900'
        : 'http://localhost:8642/v1';
    const tierInfo = tierMap.get(node.id) || {
      tierId: 'tier-3',
      tierName: `Tier 3: Agent Harness (${kind})`,
      costPer1kTokens: 0.0
    };
    const approvalPolicy = String(
      node.data?.approvals || node.data?.approvalPolicy || 'auto-approve-readonly'
    );
    const harnessModels =
      kind === 'trueforge'
        ? Array.from(
            new Set([
              'harness/trueforge',
              `trueforge/${agentId}`,
              'trueforge/default',
              'trueforge/coder',
              'trueforge/researcher',
              '*'
            ])
          )
        : [`harness/${kind}`, `${kind}/${agentId}`, '*'];

    const connectedSandboxEdge = edges.find(
      e => (e.source === node.id && sandboxNodes.some(s => s.id === e.target)) ||
           (e.target === node.id && sandboxNodes.some(s => s.id === e.source))
    );
    const linkedSandbox = connectedSandboxEdge
      ? sandboxNodes.find(s => s.id === connectedSandboxEdge.source || s.id === connectedSandboxEdge.target)
      : primarySandbox;

    upstreams.push({
      id: String(node.id),
      name: String(node.data?.label || `Agent Harness (${kind})`),
      type: 'harness',
      endpoint: String(node.data?.endpoint || defaultEndpoint),
      priority: Number(node.data?.priority ?? 30),
      models: harnessModels,
      tier: tierInfo.tierId,
      tierName: tierInfo.tierName,
      costPer1kTokens: tierInfo.costPer1kTokens,
      maxComplexityScore: capabilityCap(node),
      harness: {
        kind,
        agentId,
        approvals: approvalPolicy,
        approvalPolicy,
        sessionMode: String(node.data?.sessionMode || 'per-eluvix-session'),
        // Locality is never defaulted: emit the declaration only when the
        // canvas carries an explicit boolean. Without it, the router derives
        // locality from the endpoint (acp:// and cli:// wrappers are not
        // local) instead of the old default-true that marked every canvas
        // harness as on-machine.
        ...(typeof node.data?.providerIsLocal === 'boolean'
          ? { providerIsLocal: node.data.providerIsLocal }
          : {}),
        ...(typeof node.data?.command === 'string' || Array.isArray(node.data?.command)
          ? { command: node.data.command }
          : {}),
        ...(Array.isArray(node.data?.args)
          ? { args: node.data.args.map((a: any) => String(a)) }
          : {}),
        // M-4: explicit per-harness tool allowlist for auto-approval.
        // Absent/empty means nothing is auto-approved by name.
        ...(Array.isArray(node.data?.autoApproveTools)
          ? { autoApproveTools: node.data.autoApproveTools.map((t: any) => String(t)) }
          : {}),
        ...(node.data?.cwd ? { cwd: String(node.data.cwd) } : {}),
        ...(typeof node.data?.embedded === 'boolean' ? { embedded: node.data.embedded } : {}),
        ...(typeof node.data?.forked === 'boolean' ? { forked: node.data.forked } : {}),
        ...(typeof node.data?.deepIntegration === 'boolean' ? { deepIntegration: node.data.deepIntegration } : {}),
        ...(node.data?.architectModel ? { architectModel: String(node.data.architectModel) } : {}),
        ...(node.data?.editorModel ? { editorModel: String(node.data.editorModel) } : {}),
        ...(node.data?.repoMapTokens !== undefined ? { repoMapTokens: Number(node.data.repoMapTokens) } : {}),
        ...(node.data?.editFormat ? { editFormat: String(node.data.editFormat) } : {}),
        ...(node.data?.aciProfile ? { aciProfile: String(node.data.aciProfile) } : {}),
        ...(linkedSandbox
          ? {
              sandboxEndpoint: String(linkedSandbox.data?.endpoint || 'http://localhost:3986'),
              sandboxType: String(linkedSandbox.data?.sandboxType || 'docker-exec')
            }
          : {})
      }
    });
  });

  const swData = (switchyard?.data || {}) as Record<string, any>;
  const enclaveNode = confidentialEnclaveNodes[0];
  const enclaveNodeData = (enclaveNode?.data || {}) as Record<string, any>;
  const resolvedConfidentialPolicy =
    swData.confidentialPolicy && swData.confidentialPolicy !== 'disabled'
      ? String(swData.confidentialPolicy)
      : enclaveNodeData.confidentialPolicy
      ? String(enclaveNodeData.confidentialPolicy)
      : undefined;
  const resolvedQuantizationPolicy =
    swData.quantizationPolicy && swData.quantizationPolicy !== 'disabled'
      ? String(swData.quantizationPolicy)
      : undefined;
  const resolvedFabricPolicy =
    swData.fabricPolicy && swData.fabricPolicy !== 'disabled'
      ? String(swData.fabricPolicy)
      : undefined;

  const thresholds = (swData.complexityThresholds || {}) as Record<string, any>;
  const switchyardConfig = switchyard ? {
    strategy: switchyardStrategy,
    timeoutMs: Number(swData.timeoutMs ?? 60000),
    retryCount: Number(swData.retryCount ?? 1),
    spilloverThresholdMs: Number(swData.spilloverThresholdMs ?? 30000),
    codeEscalation: swData.codeEscalation !== false,
    prefillIsolationThresholdTokens: swData.prefillIsolationThresholdTokens !== undefined
      ? Number(swData.prefillIsolationThresholdTokens)
      : undefined,
    kvPrefixAffinity: swData.kvPrefixAffinity !== false,
    ...(resolvedConfidentialPolicy ? { confidentialPolicy: resolvedConfidentialPolicy } : {}),
    ...(resolvedQuantizationPolicy ? { quantizationPolicy: resolvedQuantizationPolicy } : {}),
    ...(resolvedFabricPolicy ? { fabricPolicy: resolvedFabricPolicy } : {}),
    complexityThresholds: {
      moderate: Number(thresholds.moderate ?? 300),
      heavy: Number(thresholds.heavy ?? 1500),
      frontier: Number(thresholds.frontier ?? 6000),
    },
    maxCostPerRequest: swData.maxCostPerRequest !== undefined ? Number(swData.maxCostPerRequest) : 0.05
  } : undefined;

  const mgNode = modelGateways[0];
  const mgData = (mgNode?.data || {}) as Record<string, any>;
  const modelGatewayConfig = mgNode ? {
    primaryModel: mgData.primaryModel || undefined,
    fallbackStrategy: mgData.fallbackStrategy || 'cheaper',
    caching: mgData.cacheEnabled ? {
      enabled: true,
      ttlSeconds: Number(mgData.cacheTtlSeconds ?? 3600),
      similarityThreshold: Number(mgData.cacheSimilarityThreshold ?? 0.95)
    } : undefined,
    rateLimits: mgData.rateLimitRpm ? {
      maxRpm: Number(mgData.rateLimitRpm)
    } : undefined,
    systemPromptPrepend: mgData.systemPromptPrepend || undefined
  } : undefined;

  const sgNode = semanticGuards[0];
  const sgData = (sgNode?.data || {}) as Record<string, any>;

  const pgNode = privacyGuards[0];
  const pgData = (pgNode?.data || {}) as Record<string, any>;

  const memNode = memoryNodes[0];
  const memData = (memNode?.data || {}) as Record<string, any>;
  const memoryConfig = memNode
    ? {
        enabled: true,
        provider: String(memData.provider || 'builtin'),
        endpoint: memData.endpoint ? String(memData.endpoint) : undefined,
        recallBudgetTokens: Number(memData.recallBudgetTokens ?? 600),
        writeBack: memData.writeBack !== false,
        allowCloudEgress: Boolean(memData.allowCloudEgress),
        cloudMode: memData.cloudMode === 'strip' ? 'strip' : 'filter',
        ...(memData.apiKey ? { apiKey: String(memData.apiKey) } : {}),
        ...(memData.recallTimeoutMs !== undefined
          ? { recallTimeoutMs: Number(memData.recallTimeoutMs) }
          : {}),
        ...(memData.autoCommitTurns !== undefined
          ? { autoCommitTurns: Number(memData.autoCommitTurns) }
          : {}),
        openviking:
          memData.readingLevel || (Array.isArray(memData.scopePrefixes) && memData.scopePrefixes.length > 0)
            ? {
                ...(memData.readingLevel
                  ? { readingLevel: memData.readingLevel as 'L0' | 'L1' | 'L2' }
                  : {}),
                ...(Array.isArray(memData.scopePrefixes) && memData.scopePrefixes.length > 0
                  ? { scopePrefixes: memData.scopePrefixes.map((p: any) => String(p)) }
                  : {})
              }
            : undefined
      }
    : undefined;

  const kbNode = knowledgeBaseNodes[0];
  const kbData = (kbNode?.data || {}) as Record<string, any>;
  const knowledgeConfig = kbNode
    ? {
        enabled: true,
        backend: String(kbData.backend || 'lightrag'),
        endpoint: kbData.endpoint ? String(kbData.endpoint) : undefined,
        collectionUri: String(kbData.collectionUri || 'viking://resources/docs'),
        retrievalMode: String(kbData.retrievalMode || 'hybrid'),
        citationMode: String(kbData.citationMode || 'bracket'),
        topK: Number(kbData.topK ?? 5),
        maxTokens: Number(kbData.maxTokens ?? 1200),
        minScore: Number(kbData.minScore ?? 0.65)
      }
    : undefined;

  const scNode = semanticCacheNodes[0];
  const scData = (scNode?.data || {}) as Record<string, any>;
  const cacheConfig = scNode
    ? {
        enabled: true,
        backend: String(scData.backend || 'sqlite-fts'),
        endpoint: scData.endpoint ? String(scData.endpoint) : undefined,
        mode: String(scData.mode || 'exact'),
        similarityThreshold: Number(scData.similarityThreshold ?? 0.94),
        ttlSeconds: Number(scData.ttlSeconds ?? 3600),
        scopeByUser: scData.scopeByUser !== false,
        scopeIsolation: String(scData.scopeIsolation || (scData.scopeByUser === false ? 'global' : 'user')),
        bypassOnTools: scData.bypassOnTools !== false
      }
    : undefined;

  const sbNode = sandboxNodes[0];
  const sbData = (sbNode?.data || {}) as Record<string, any>;
  const sandboxConfig = sbNode
    ? {
        enabled: true,
        runtime: String(sbData.runtime || 'docker'),
        image: sbData.image ? String(sbData.image) : undefined,
        timeoutSec: Number(sbData.timeoutSec ?? 30),
        sandboxType: String(sbData.sandboxType || 'docker-exec'),
        endpoint: String(sbData.endpoint || 'http://localhost:3986'),
        timeoutMs: Number(sbData.timeoutMs ?? 30000),
        memoryLimitMb: Number(sbData.memoryLimitMb ?? 512),
        networkPolicy: String(sbData.networkPolicy || 'none'),
        autoCleanup: sbData.autoCleanup !== false
      }
    : undefined;

  const consensusGroups = consensusNodes.map(node => {
    const cData = (node.data || {}) as Record<string, any>;
    const candidateEdges = edges.filter(
      e => e.source === node.id && (!e.sourceHandle || e.sourceHandle.startsWith('candidate-'))
    );
    const judgeEdge = edges.find(e => e.source === node.id && e.sourceHandle === 'judge');
    const strategy = String(cData.strategy || (cData.mode === 'judge' ? 'parallel-judge' : cData.mode || 'parallel-judge'));
    return {
      id: String(node.id),
      mode: String(cData.mode || 'judge'),
      strategy,
      minQuorum: Number(cData.minQuorum ?? 2),
      candidateCount: Number(cData.candidateCount ?? 3),
      candidateUpstreamIds: candidateEdges.map(e => e.target),
      judgeUpstreamId: judgeEdge?.target,
      judgeModel: String(cData.judgeModel || 'auto'),
      timeoutMs: Number(cData.timeoutMs ?? 45000),
      rubric: String(cData.rubric || 'accuracy-conciseness')
    };
  });

  const fallbackChains = fallbackChainNodes.map(node => {
    const fData = (node.data || {}) as Record<string, any>;
    const primaryEdge = edges.find(e => e.source === node.id && (e.sourceHandle === 'primary' || e.sourceHandle === 'tier-1'));
    const secondaryEdge = edges.find(e => e.source === node.id && (e.sourceHandle === 'secondary' || e.sourceHandle === 'tier-2'));
    const tertiaryEdge = edges.find(e => e.source === node.id && (e.sourceHandle === 'tertiary' || e.sourceHandle === 'emergency' || e.sourceHandle === 'tier-3'));
    const genericEdges = edges.filter(e => e.source === node.id && !e.sourceHandle);

    const orderedUpstreamIds = [
      primaryEdge?.target || genericEdges[0]?.target,
      secondaryEdge?.target || genericEdges[1]?.target,
      tertiaryEdge?.target || genericEdges[2]?.target,
      ...genericEdges.slice(3).map(e => e.target)
    ].filter(Boolean) as string[];

    return {
      id: String(node.id),
      primaryUpstreamId: orderedUpstreamIds[0],
      secondaryUpstreamId: orderedUpstreamIds[1],
      tertiaryUpstreamId: orderedUpstreamIds[2],
      orderedUpstreamIds,
      failureThreshold: Number(fData.failureThreshold ?? 3),
      cooldownSeconds: Number(fData.cooldownSeconds ?? 60),
      hedgeDelayMs: Number(fData.hedgeDelayMs ?? 0),
      retryOn429: fData.retryOn429 !== false,
      retryOn5xx: fData.retryOn5xx !== false
    };
  });

  // Egress is determined by what is actually on the canvas: a graph whose
  // upstreams are all local engines compiles to a fail-closed local-only
  // policy, so the router can never fall back to an external service that
  // is not part of this layout. Any cloud provider, cloud gateway, or
  // external agent node (Antigravity/Codex/Claude Code phone home even
  // though their daemons listen on localhost) opts the layout into egress.
  const hasExternalUpstream =
    antigravityNodes.length > 0 ||
    codexNodes.length > 0 ||
    claudeCodeNodes.length > 0 ||
    billamaNodes.length > 0 ||
    openaiNodes.length > 0 ||
    claudeNodes.length > 0 ||
    modelGateways.length > 0 ||
    // A harness counts as on-machine only when it explicitly declares
    // providerIsLocal: true — an undeclared harness may front a cloud
    // model, so the layout opts into egress (fail-closed).
    harnessNodes.some(n => (n.data as any)?.providerIsLocal !== true);

  return {
    upstreams,
    egressPolicy: hasExternalUpstream ? 'allow-egress' : 'local-only',
    ...(resolvedConfidentialPolicy ? { confidentialPolicy: resolvedConfidentialPolicy } : {}),
    ...(resolvedQuantizationPolicy ? { quantizationPolicy: resolvedQuantizationPolicy } : {}),
    ...(resolvedFabricPolicy ? { fabricPolicy: resolvedFabricPolicy } : {}),
    strategy: switchyardStrategy,
    fallbackStrategy: switchyardStrategy === 'round-robin' ? 'round-robin' : 'priority',
    switchyard: switchyardConfig,
    modelGateway: modelGatewayConfig,
    ...(memoryConfig ? { memory: memoryConfig } : {}),
    ...(knowledgeConfig ? { knowledge: knowledgeConfig } : {}),
    ...(cacheConfig ? { cache: cacheConfig } : {}),
    ...(sandboxConfig ? { sandbox: sandboxConfig } : {}),
    ...(consensusGroups.length > 0 ? { consensusGroups } : {}),
    ...(fallbackChains.length > 0 ? { fallbackChains } : {}),
    promptGuard: {
      enabled: semanticGuards.length > 0,
      threshold: sgNode ? Number(sgData.threshold ?? 0.85) : 0.85,
      action: sgNode ? String(sgData.enforcementAction || 'block') : 'block',
      threatVectors: sgData.threatVectors || {
        instructionOverride: true,
        danJailbreak: true,
        systemPromptLeak: true,
        obfuscation: true
      },
      bannedPhrases: Array.isArray(sgData.bannedPhrases) ? sgData.bannedPhrases : []
    },
    privacyGuard: {
      enabled: privacyGuards.length > 0,
      action: pgNode ? String(pgData.action || 'anonymize') : 'anonymize',
      redactionStyle: pgNode ? String(pgData.redactionStyle || 'token') : 'token',
      whitelist: Array.isArray(pgData.whitelist)
        ? pgData.whitelist
        : (typeof pgData.whitelist === 'string' ? pgData.whitelist.split(',').map((s: string) => s.trim()).filter(Boolean) : []),
      customPatterns: Array.isArray(pgData.customPatterns) ? pgData.customPatterns : [],
      auditLogging: Boolean(pgData.auditLogging),
      detectPii: pgData.detectPii || {
        apiKey: true,
        ssn: true,
        creditCard: true,
        email: true,
        phone: true,
        ipAddress: true
      }
    }
  };
}

function generateBifrostYaml(
  nodes: Node[],
  localEngines: Node[] = [],
  switchyardNodes: Node[] = [],
  edges: Edge[] = [],
  antigravityNodes: Node[] = [],
  codexNodes: Node[] = [],
  claudeCodeNodes: Node[] = [],
  billamaNodes: Node[] = [],
  openaiNodes: Node[] = [],
  claudeNodes: Node[] = [],
  harnessNodes: Node[] = []
): string {
  if (
    nodes.length === 0 &&
    localEngines.length === 0 &&
    antigravityNodes.length === 0 &&
    codexNodes.length === 0 &&
    claudeCodeNodes.length === 0 &&
    billamaNodes.length === 0 &&
    openaiNodes.length === 0 &&
    claudeNodes.length === 0 &&
    harnessNodes.length === 0
  ) return '';
  
  const switchyard = switchyardNodes[0];
  const strategy = String(switchyard?.data?.strategy || 'cost-complexity');
  let yaml = `version: 1.0\nrouting_strategy: ${strategy}\n`;

  if (switchyard) {
    const swData = (switchyard.data || {}) as Record<string, any>;
    const thresholds = (swData.complexityThresholds || {}) as Record<string, any>;
    const routes: Array<{ id: string; name: string; costLabel?: string }> = 
      Array.isArray(swData.routes) ? swData.routes : [];
    
    yaml += `switchyard_balancer:\n  strategy: ${strategy}\n  failover: enabled\n`;
    yaml += `  timeout_ms: ${swData.timeoutMs ?? 60000}\n`;
    yaml += `  retry_count: ${swData.retryCount ?? 1}\n`;
    yaml += `  spillover_threshold_ms: ${swData.spilloverThresholdMs ?? 30000}\n`;
    yaml += `  code_escalation: ${swData.codeEscalation !== false}\n`;
    yaml += `  max_cost_per_request: ${swData.maxCostPerRequest ?? 0.05}\n`;
    yaml += `  complexity_thresholds:\n`;
    yaml += `    moderate: ${thresholds.moderate ?? 300}\n`;
    yaml += `    heavy: ${thresholds.heavy ?? 1500}\n`;
    yaml += `    frontier: ${thresholds.frontier ?? 6000}\n`;
    yaml += `  tiers:\n`;
    routes.forEach(route => {
      const targets = edges
        .filter(e => e.source === switchyard.id && e.sourceHandle === route.id)
        .map(e => e.target);
      yaml += `    - id: ${route.id}\n`;
      yaml += `      name: "${route.name}"\n`;
      yaml += `      cost_rate: "${route.costLabel || '$0.00'}"\n`;
      yaml += `      targets: [${targets.map(t => `"${t}"`).join(', ')}]\n`;
    });
  }
  
  yaml += `gateways:\n`;
  
  localEngines.forEach(node => {
    const data = (node.data || {}) as Record<string, any>;
    const type = node.type === 'lemonadeNode'
      ? 'lemonade'
      : node.type === 'vllmNode'
      ? 'vllm'
      : node.type === 'sglangNode'
      ? 'sglang'
      : 'ollama';
    const endpoint = data.endpoint || (
      type === 'lemonade' ? 'http://localhost:13305' :
      type === 'vllm' ? 'http://localhost:8000' :
      type === 'sglang' ? 'http://localhost:30000' :
      'http://localhost:11434'
    );
    const selected = data.selectedModel || '*';
    yaml += `  - id: ${node.id}\n`;
    yaml += `    type: ${type}\n`;
    yaml += `    api_base: ${endpoint}\n`;
    yaml += `    selected_model: "${selected}"\n`;
    yaml += `    priority: ${data.priority || 20}\n`;
    if (data.maxContextTokens) {
      yaml += `    max_context_tokens: ${data.maxContextTokens}\n`;
    }
    if (data.maxParallelRequests) {
      yaml += `    max_parallel_requests: ${data.maxParallelRequests}\n`;
    }
  });

  billamaNodes.forEach(node => {
    const data = (node.data || {}) as Record<string, any>;
    const endpoint = data.endpoint || 'https://api.billama.dev';
    const selected = data.selectedModel || '*';
    yaml += `  - id: ${node.id}\n`;
    yaml += `    type: billama\n`;
    yaml += `    api_base: ${endpoint}\n`;
    yaml += `    selected_model: "${selected}"\n`;
    yaml += `    priority: ${data.priority ?? 15}\n`;
    if (data.apiKey) {
      yaml += `    api_key: "${data.apiKey}"\n`;
    }
    if (data.maxContextTokens) {
      yaml += `    max_context_tokens: ${data.maxContextTokens}\n`;
    }
    if (data.maxParallelRequests) {
      yaml += `    max_parallel_requests: ${data.maxParallelRequests}\n`;
    }
    if (data.monthlySpendLimit) {
      yaml += `    monthly_spend_limit: ${data.monthlySpendLimit}\n`;
    }
  });

  openaiNodes.forEach(node => {
    const data = (node.data || {}) as Record<string, any>;
    const endpoint = data.endpoint || 'https://api.openai.com/v1';
    const selected = data.selectedModel || '*';
    yaml += `  - id: ${node.id}\n`;
    yaml += `    type: openai-compatible\n`;
    yaml += `    api_base: ${endpoint}\n`;
    yaml += `    selected_model: "${selected}"\n`;
    yaml += `    priority: ${data.priority ?? 10}\n`;
    if (data.apiKey) {
      yaml += `    api_key: "${data.apiKey}"\n`;
    }
    if (data.maxContextTokens) {
      yaml += `    max_context_tokens: ${data.maxContextTokens}\n`;
    }
    if (data.maxParallelRequests) {
      yaml += `    max_parallel_requests: ${data.maxParallelRequests}\n`;
    }
    if (data.monthlySpendLimit) {
      yaml += `    monthly_spend_limit: ${data.monthlySpendLimit}\n`;
    }
  });

  claudeNodes.forEach(node => {
    const data = (node.data || {}) as Record<string, any>;
    const endpoint = data.endpoint || 'https://api.anthropic.com/v1';
    const selected = data.selectedModel || 'claude-3-7-sonnet';
    yaml += `  - id: ${node.id}\n`;
    yaml += `    type: anthropic\n`;
    yaml += `    api_base: ${endpoint}\n`;
    yaml += `    selected_model: "${selected}"\n`;
    yaml += `    priority: ${data.priority ?? 10}\n`;
    if (data.apiKey) {
      yaml += `    api_key: "${data.apiKey}"\n`;
    }
    if (data.maxContextTokens) {
      yaml += `    max_context_tokens: ${data.maxContextTokens}\n`;
    }
    if (data.maxParallelRequests) {
      yaml += `    max_parallel_requests: ${data.maxParallelRequests}\n`;
    }
    if (data.monthlySpendLimit) {
      yaml += `    monthly_spend_limit: ${data.monthlySpendLimit}\n`;
    }
  });

  antigravityNodes.forEach(node => {
    const model = node.data?.model === 'custom' ? (node.data?.customModel || 'custom') : (node.data?.model || 'gemini-4-argon');
    yaml += `  - id: ${node.id}\n`;
    yaml += `    type: antigravity\n`;
    yaml += `    model: "${model}"\n`;
    yaml += `    effort: ${node.data?.effort || 'auto'}\n`;
    yaml += `    clean_headless: ${node.data?.cleanHeadless !== false}\n`;
    yaml += `    sandbox_mode: ${node.data?.sandboxMode || 'standard'}\n`;
    yaml += `    agent_behavior: ${node.data?.agentBehavior || 'autonomous'}\n`;
    yaml += `    subagents: ${node.data?.enableSubagents !== false}\n`;
    yaml += `    max_depth: ${node.data?.maxSubagentDepth ?? 2}\n`;
    yaml += `    thinking_budget: ${node.data?.extendedThinking ? (node.data?.thinkingBudget ?? 2048) : 0}\n`;
  });

  codexNodes.forEach(node => {
    const model = node.data?.model === 'custom' ? (node.data?.customModel || 'custom') : (node.data?.model || 'o3-mini');
    yaml += `  - id: ${node.id}\n`;
    yaml += `    type: codex\n`;
    yaml += `    model: "${model}"\n`;
    yaml += `    reasoning_effort: ${node.data?.reasoningEffort || 'medium'}\n`;
    yaml += `    environment: ${node.data?.environment || 'local-sandbox'}\n`;
    yaml += `    approval_mode: ${node.data?.approvalMode || 'confirm-risky'}\n`;
  });

  claudeCodeNodes.forEach(node => {
    const model = node.data?.model === 'custom' ? (node.data?.customModel || 'custom') : (node.data?.model || 'claude-3-7-sonnet');
    yaml += `  - id: ${node.id}\n`;
    yaml += `    type: claude-code\n`;
    yaml += `    model: "${model}"\n`;
    yaml += `    permission_mode: ${node.data?.permissionMode || 'accept-non-destructive'}\n`;
    yaml += `    thinking_budget: ${node.data?.extendedThinking ? Number(node.data?.thinkingBudget ?? 4096) : 0}\n`;
  });

  harnessNodes.forEach(node => {
    const kind = String(node.data?.kind || 'trueforge');
    const endpoint = String(node.data?.endpoint || (kind === 'trueforge' ? 'http://localhost:8790' : kind === 'opencode' ? 'http://localhost:4096' : 'acp://goose'));
    const agentId = String(node.data?.agentId || 'default');
    const approvalPolicy = String(node.data?.approvals || node.data?.approvalPolicy || 'auto-approve-readonly');
    yaml += `  - id: ${node.id}\n`;
    yaml += `    type: harness\n`;
    yaml += `    harness_kind: ${kind}\n`;
    yaml += `    api_base: ${endpoint}\n`;
    yaml += `    agent_id: "${agentId}"\n`;
    yaml += `    approval_policy: ${approvalPolicy}\n`;
    yaml += `    priority: ${node.data?.priority ?? 30}\n`;
  });

  nodes.forEach(node => {
    const data = (node.data || {}) as Record<string, any>;
    const primary = data.primaryModel || 'gpt-4o';
    const fallback = data.fallbackStrategy || 'cheaper';
    
    yaml += `  - id: ${node.id}\n`;
    yaml += `    primary_model: ${primary}\n`;
    yaml += `    fallback_strategy: ${fallback}\n`;
    yaml += `    load_balancing: true\n`;
    if (data.cacheEnabled) {
      yaml += `    caching:\n`;
      yaml += `      enabled: true\n`;
      yaml += `      ttl_seconds: ${data.cacheTtlSeconds ?? 3600}\n`;
      yaml += `      similarity_threshold: ${data.cacheSimilarityThreshold ?? 0.95}\n`;
    }
    if (data.rateLimitRpm) {
      yaml += `    rate_limits:\n`;
      yaml += `      max_rpm: ${data.rateLimitRpm}\n`;
    }
    if (data.systemPromptPrepend) {
      yaml += `    system_prompt_prepend: ${JSON.stringify(data.systemPromptPrepend)}\n`;
    }
  });
  
  return yaml;
}

function generateAntigravitySetup(nodes: Node[], edges: Edge[]): string {
  if (nodes.length === 0) return '';
  
  let setup = '# ==============================================================================\n';
  setup += '# Google Antigravity (AGY) Agent Orchestration Setup\n';
  setup += '# Generated by Eluvix Visual Routing Editor\n';
  setup += '# ==============================================================================\n\n';
  setup += 'import asyncio\n';
  setup += 'from google.antigravity import Agent, LocalAgentConfig, types\n';
  setup += 'from google.antigravity.hooks import policy\n\n';

  nodes.forEach(node => {
    const model = node.data?.model === 'custom'
      ? (node.data?.customModel || 'gemini-4-argon')
      : (node.data?.model || 'gemini-4-argon');
    const sandbox = node.data?.sandboxMode || 'standard';
    const behavior = node.data?.agentBehavior === 'interactive'
      ? 'types.AgentBehavior.INTERACTIVE'
      : node.data?.agentBehavior === 'planning'
      ? 'types.AgentBehavior.PLANNING'
      : 'types.AgentBehavior.AUTONOMOUS';
    const subagents = node.data?.enableSubagents !== false;
    const maxDepth = Number(node.data?.maxSubagentDepth ?? 2);
    const thinkingBudget = node.data?.extendedThinking ? Number(node.data?.thinkingBudget ?? 2048) : 0;
    const instructions = String(node.data?.systemInstructions || 'You are an autonomous AI engineer.').replace(/"/g, '\\"');
    const delegatedSubagents = edges
      .filter(e => e.source === node.id && e.sourceHandle === 'subagents')
      .map(e => e.target);

    setup += `# Agent Node: ${node.id} (${model})\n`;
    setup += `config_${node.id.replace(/-/g, '_')} = LocalAgentConfig(\n`;
    setup += `    model="${model}",\n`;
    setup += `    system_instructions="${instructions}",\n`;
    setup += `    capabilities=types.CapabilitiesConfig(\n`;
    setup += `        agent_behavior=${behavior},\n`;
    if (subagents) {
      setup += `        max_subagent_depth=${maxDepth},\n`;
      if (delegatedSubagents.length > 0) {
        setup += `        allowed_subagents=[${delegatedSubagents.map(s => `"${s}"`).join(', ')}],\n`;
      }
    }
    if (thinkingBudget > 0) {
      setup += `        thinking_budget=${thinkingBudget},\n`;
    }
    setup += `    ),\n`;
    setup += `    policies=[\n`;
    if (node.data?.workspaceIsolation !== false) {
      setup += `        policy.workspace_only(),\n`;
    }
    if (sandbox === 'standard') {
      setup += `        # Standard Sandbox Mode (isolated filesystem, blocked unauthorized commands)\n`;
      setup += `        policy.confirm_run_command(),\n`;
    } else if (sandbox === 'read-only') {
      setup += `        # Read-Only Mode (all modification & execution tools blocked)\n`;
      setup += `        policy.deny("run_command"),\n`;
      setup += `        policy.deny("write_to_file"),\n`;
      setup += `        policy.deny("replace_file_content"),\n`;
    } else {
      setup += `        # Bypass Sandbox Mode (full filesystem & execution access)\n`;
      setup += `        policy.allow_all(),\n`;
    }
    setup += `    ]\n`;
    setup += `)\n\n`;
  });

  setup += '# CLI settings.json equivalent (~/.gemini/antigravity-cli/settings.json):\n';
  const cliSettings = nodes.map(n => ({
    id: n.id,
    model: n.data?.model === 'custom' ? n.data?.customModel : (n.data?.model || 'gemini-4-argon'),
    sandbox: n.data?.sandboxMode || 'standard',
    agent_behavior: n.data?.agentBehavior || 'autonomous',
    subagents: n.data?.enableSubagents !== false,
    max_subagent_depth: n.data?.maxSubagentDepth ?? 2,
    extended_thinking: n.data?.extendedThinking ?? true,
    thinking_budget: n.data?.thinkingBudget ?? 2048,
    network_access: n.data?.networkAccess || false
  }));
  setup += `# ${JSON.stringify({ agents: cliSettings }, null, 2).replace(/\n/g, '\n# ')}\n`;

  return setup;
}

function generateAgentRouterJson(taskRouters: Node[], agents: Node[], mcpTools: Node[], edges: Edge[]): string {
  if (taskRouters.length === 0 && agents.length === 0) return '{}';
  
  const routers = taskRouters.map(router => {
    const rData = (router.data || {}) as Record<string, any>;
    const connectedEdges = edges.filter(e => e.source === router.id);
    const connectedAgents = connectedEdges.map(e => {
      const agent = agents.find(a => a.id === e.target);
      if (!agent) return null;

      // Find MCP tools connected to this agent
      const toolEdges = edges.filter(te => te.target === agent.id);
      const agentTools = toolEdges.map(te => {
        const tool = mcpTools.find(t => t.id === te.source);
        return tool ? {
          name: tool.data?.toolName,
          endpoint: tool.data?.mcpEndpoint,
          executionMode: tool.data?.executionMode || 'auto',
          timeoutMs: tool.data?.timeoutMs ?? 15000
        } : null;
      }).filter(Boolean);

      return { 
        id: agent.id, 
        capability: agent.data?.capability || 'general',
        routeHandle: e.sourceHandle || 'intent-default',
        mcpTools: agentTools.length > 0 ? agentTools : undefined
      };
    }).filter(Boolean);

    // Group targets by intent handles
    const intentRoutes: Record<string, string[]> = {
      code: [],
      reasoning: [],
      fast: [],
      tools: [],
      default: []
    };
    connectedEdges.forEach(e => {
      const handle = e.sourceHandle || 'intent-default';
      const key = handle.replace('intent-', '');
      if (intentRoutes[key]) {
        intentRoutes[key].push(e.target);
      } else {
        intentRoutes.default.push(e.target);
      }
    });

    return {
      id: router.id,
      preference: rData.preference || 'balanced',
      classificationEngine: rData.classificationEngine || 'heuristic',
      confidenceThreshold: rData.confidenceThreshold ?? 0.85,
      intentRoutes,
      targets: connectedAgents
    };
  });

  return JSON.stringify({ routers }, null, 2);
}

function generateSemanticRouterSetup(nodes: Node[]): string {
  if (nodes.length === 0) return '';
  
  let setup = '// Semantic Router & Prompt Guard Orchestration\n';
  setup += 'import { SemanticRouter, Route } from "semantic-router";\n\n';
  setup += 'export const setupSemanticGuards = () => {\n';
  
  nodes.forEach(node => {
    const data = (node.data || {}) as Record<string, any>;
    const routeName = String(data.routeName || 'prompt-injection-guard');
    const encoder = String(data.encoder || 'deberta-v3-injection');
    const threshold = Number(data.threshold ?? 0.82);
    const action = String(data.enforcementAction || 'block');
    const vectors = data.threatVectors || { instructionOverride: true, danJailbreak: true, systemPromptLeak: true, obfuscation: true };
    const banned = Array.isArray(data.bannedPhrases) ? data.bannedPhrases : [];
    
    const safeNodeId = sanitizeSafeIdentifier(node.id, 'node');
    setup += `  // Guard Node: ${safeNodeId}\n`;
    setup += `  const guard_${safeNodeId} = new SemanticRouter({\n`;
    setup += `    name: ${JSON.stringify(routeName)},\n`;
    setup += `    encoder: ${JSON.stringify(encoder)},\n`;
    setup += `    similarityThreshold: ${threshold},\n`;
    setup += `    enforcementAction: ${JSON.stringify(action)},\n`;
    setup += `    threatVectors: ${JSON.stringify(vectors)},\n`;
    if (banned.length > 0) {
      setup += `    bannedPhrases: ${JSON.stringify(banned)},\n`;
    }
    setup += `    mode: ${JSON.stringify(encoder.includes('injection') || encoder.includes('guard') ? 'classifier-firewall' : 'vector-clustering')}\n`;
    setup += `  });\n\n`;
  });
  
  setup += '  return { guards: [' + nodes.map(n => `guard_${sanitizeSafeIdentifier(n.id, 'node')}`).join(', ') + '] };\n};\n';
  
  return setup;
}

function generatePrivacyGuardSetup(nodes: Node[]): string {
  if (nodes.length === 0) return '';

  let setup = '// Privacy & PII In-Flight Masking Setup\n';
  setup += 'export const privacyGuardConfig = {\n';
  setup += '  enabled: true,\n';

  nodes.forEach(node => {
    const data = (node.data || {}) as Record<string, any>;
    const action = String(data.action || 'anonymize');
    const redactionStyle = String(data.redactionStyle || 'token');
    const pii = (data.detectPii as Record<string, boolean> | undefined) || {};
    const whitelist = Array.isArray(data.whitelist)
      ? data.whitelist
      : (typeof data.whitelist === 'string' ? data.whitelist.split(',').map((s: string) => s.trim()).filter(Boolean) : []);
    const customPatterns = Array.isArray(data.customPatterns) ? data.customPatterns : [];
    const auditLogging = Boolean(data.auditLogging);

    setup += `  action: ${JSON.stringify(action)},\n`;
    setup += `  redactionStyle: ${JSON.stringify(redactionStyle)},\n`;
    setup += `  auditLogging: ${auditLogging},\n`;
    setup += `  detectPii: {\n`;
    setup += `    apiKey: ${pii.apiKey !== false},\n`;
    setup += `    ssn: ${pii.ssn !== false},\n`;
    setup += `    creditCard: ${pii.creditCard !== false},\n`;
    setup += `    email: ${pii.email !== false},\n`;
    setup += `    phone: ${pii.phone !== false},\n`;
    setup += `    ipAddress: ${pii.ipAddress !== false}\n`;
    setup += `  },\n`;
    if (whitelist.length > 0) {
      setup += `  whitelist: ${JSON.stringify(whitelist)},\n`;
    }
    if (customPatterns.length > 0) {
      setup += `  customPatterns: ${JSON.stringify(customPatterns)},\n`;
    }
  });

  setup += '};\n';
  return setup;
}

function generateAgentGatewayJson(nodes: Node[], mcpTools: Node[], edges: Edge[]): string {
  if (nodes.length === 0) return '{}';

  const gateways = nodes.map(node => {
    const data = (node.data || {}) as Record<string, any>;
    // Find MCP tools connected to this gateway
    const toolEdges = edges.filter(te => te.target === node.id);
    const gatewayTools = toolEdges.map(te => {
      const tool = mcpTools.find(t => t.id === te.source);
      return tool ? {
        name: tool.data?.toolName,
        endpoint: tool.data?.mcpEndpoint,
        executionMode: tool.data?.executionMode || 'auto',
        timeoutMs: tool.data?.timeoutMs ?? 15000
      } : null;
    }).filter(Boolean);

    if (data.enableNativeTools !== false) {
      gatewayTools.push({ name: 'native_tools', endpoint: 'local:///api/v1/tools', executionMode: 'auto', timeoutMs: 10000 });
    }

    return {
      id: node.id,
      accessPolicy: data.accessPolicy || 'restrictive',
      toolFilterMode: data.toolFilterMode || 'all',
      toolTimeoutMs: Number(data.toolTimeoutMs ?? 10000),
      sanitizeToolOutput: data.sanitizeToolOutput !== false,
      protocols: ['mcp', 'a2a'],
      mcpTools: gatewayTools.length > 0 ? gatewayTools : undefined
    };
  });

  return JSON.stringify({ gateways }, null, 2);
}

function generateObservabilitySetup(nodes: Node[]): string {
  if (nodes.length === 0) return '';
  
  let setup = '// Observability & OpenTelemetry Setup\n';
  setup += 'import { initLogger } from "braintrust";\n\n';
  setup += 'export const setupObservability = () => {\n';

  nodes.forEach(node => {
    const data = (node.data || {}) as Record<string, any>;
    const projectName = data.projectName || 'eluvix-production';
    const captureInputs = data.captureInputs !== false;
    const exporter = data.exporter || 'sqlite';
    const endpointUrl = data.endpointUrl || '';
    const samplingRate = Number(data.samplingRate ?? 100);
    const scrubPii = data.scrubPii !== false;
    const latencyAlertMs = Number(data.latencyAlertMs ?? 5000);

    const safeNodeId = sanitizeSafeIdentifier(node.id, 'node');
    setup += `  // Telemetry Exporter: ${exporter}\n`;
    setup += `  const logger_${safeNodeId} = initLogger({\n`;
    setup += `    projectName: ${JSON.stringify(projectName)},\n`;
    setup += `    exporter: ${JSON.stringify(exporter)},\n`;
    if (endpointUrl) {
      setup += `    endpointUrl: ${JSON.stringify(endpointUrl)},\n`;
    }
    setup += `    samplingRate: ${samplingRate / 100},\n`;
    setup += `    scrubPii: ${scrubPii},\n`;
    setup += `    latencyAlertMs: ${latencyAlertMs},\n`;
    setup += `    captureInputs: ${captureInputs}\n`;
    setup += `  });\n\n`;
  });

  setup += '  return { /* map of loggers */ };\n};\n';
  
  return setup;
}

function generateCodexSetup(nodes: Node[], edges: Edge[]): string {
  if (nodes.length === 0) return '';
  
  let setup = '# ==============================================================================\n';
  setup += '# OpenAI Codex Agent Orchestration Setup\n';
  setup += '# Generated by Eluvix Visual Routing Editor\n';
  setup += '# ==============================================================================\n\n';
  setup += 'import os\n';
  setup += 'from openai import OpenAI\n\n';
  setup += 'client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))\n\n';

  nodes.forEach(node => {
    const model = node.data?.model === 'custom'
      ? (node.data?.customModel || 'o3-mini')
      : (node.data?.model || 'o3-mini');
    const reasoningEffort = node.data?.reasoningEffort || 'medium';
    const env = node.data?.environment || 'local-sandbox';
    const approval = node.data?.approvalMode || 'confirm-risky';
    const workDir = node.data?.workingDirectory || './workspace';
    const instructions = String(node.data?.systemInstructions || 'You are OpenAI Codex, a premier autonomous software engineer.').replace(/"/g, '\\"');
    const delegatedSubagents = edges
      .filter(e => e.source === node.id && e.sourceHandle === 'subagents')
      .map(e => e.target);

    const safeNodeId = sanitizeSafeIdentifier(node.id, 'node');
    setup += `# Codex Agent Node: ${safeNodeId} (${model})\n`;
    setup += `codex_agent_${safeNodeId} = {\n`;
    setup += `    "name": ${JSON.stringify(`Codex Agent (${model})`)},\n`;
    setup += `    "model": ${JSON.stringify(model)},\n`;
    if (model === 'o3-mini' || model === 'o1' || model === 'o1-mini') {
      setup += `    "reasoning_effort": ${JSON.stringify(reasoningEffort)},\n`;
    }
    setup += `    "instructions": ${JSON.stringify(instructions)},\n`;
    setup += `    "environment": {\n`;
    setup += `        "type": ${JSON.stringify(env)},\n`;
    setup += `        "approval_mode": ${JSON.stringify(approval)},\n`;
    setup += `        "working_directory": ${JSON.stringify(workDir)},\n`;
    setup += `    },\n`;
    setup += `    "tools": [\n`;
    if (node.data?.enableCodeInterpreter !== false) {
      setup += `        {"type": "code_interpreter"},\n`;
    }
    if (node.data?.enableFileEditor !== false) {
      setup += `        {"type": "file_search"},\n`;
      setup += `        {"type": "function", "function": {"name": "apply_patch", "description": "Apply file diff or edit"}},\n`;
    }
    if (node.data?.enableBash !== false) {
      setup += `        {"type": "function", "function": {"name": "run_shell_command", "description": "Execute terminal command in sandbox"}},\n`;
    }
    if (node.data?.enableWebBrowsing) {
      setup += `        {"type": "function", "function": {"name": "browse_web", "description": "Search documentation and web pages"}},\n`;
    }
    setup += `    ],\n`;
    if (delegatedSubagents.length > 0) {
      setup += `    "delegated_subagents": [${delegatedSubagents.map(s => `"${s}"`).join(', ')}],\n`;
    }
    setup += `}\n\n`;
  });

  setup += '# CLI config equivalent (codex-config.json):\n';
  const cliSettings = nodes.map(n => ({
    id: n.id,
    model: n.data?.model === 'custom' ? n.data?.customModel : (n.data?.model || 'o3-mini'),
    reasoning_effort: n.data?.reasoningEffort || 'medium',
    environment: n.data?.environment || 'local-sandbox',
    approval_mode: n.data?.approvalMode || 'confirm-risky',
    working_directory: n.data?.workingDirectory || './workspace',
    tools: {
      code_interpreter: n.data?.enableCodeInterpreter !== false,
      bash: n.data?.enableBash !== false,
      file_editor: n.data?.enableFileEditor !== false,
      web_browsing: n.data?.enableWebBrowsing ?? true
    }
  }));
  setup += `# ${JSON.stringify({ agents: cliSettings }, null, 2).replace(/\n/g, '\n# ')}\n`;

  return setup;
}

function generateClaudeCodeSetup(nodes: Node[], edges: Edge[]): string {
  if (nodes.length === 0) return '';
  
  let setup = '# ==============================================================================\n';
  setup += '# Claude Code CLI & Agent Orchestration Setup\n';
  setup += '# Generated by Eluvix Visual Routing Editor\n';
  setup += '# ==============================================================================\n\n';

  nodes.forEach(node => {
    const model = node.data?.model === 'custom'
      ? (node.data?.customModel || 'claude-3-7-sonnet')
      : (node.data?.model || 'claude-3-7-sonnet');
    const permMode = node.data?.permissionMode || 'accept-non-destructive';
    const extendedThinking = node.data?.extendedThinking ?? true;
    const thinkingBudget = extendedThinking ? Number(node.data?.thinkingBudget ?? 4096) : 0;
    const delegatedSubagents = edges
      .filter(e => e.source === node.id && e.sourceHandle === 'subagents')
      .map(e => e.target);

    setup += `# Claude Code Node: ${node.id} (${model})\n`;
    setup += `# CLI Command invocation:\n`;
    let cliCmd = `claude --model ${model}`;
    if (permMode === 'dangerously-skip-permissions') {
      cliCmd += ` --dangerously-skip-permissions`;
    } else if (permMode === 'prompt') {
      cliCmd += ` --permission-mode prompt`;
    } else {
      cliCmd += ` --permission-mode accept-non-destructive`;
    }
    if (thinkingBudget > 0) {
      cliCmd += ` --max-thinking-tokens ${thinkingBudget}`;
    }
    setup += `# $ ${cliCmd}\n`;
    if (delegatedSubagents.length > 0) {
      setup += `# Delegated Subagents: ${delegatedSubagents.join(', ')}\n`;
    }
    setup += `\n`;
  });

  setup += '// Claude Code Project Configuration (~/.claude/config.json / .claude/config.json):\n';
  const configs = nodes.map(n => {
    const model = n.data?.model === 'custom' ? (n.data?.customModel || 'claude-3-7-sonnet') : (n.data?.model || 'claude-3-7-sonnet');
    const thinkingBudget = n.data?.extendedThinking ? Number(n.data?.thinkingBudget ?? 4096) : 0;
    return {
      id: n.id,
      model,
      permissionMode: n.data?.permissionMode || 'accept-non-destructive',
      thinkingBudget,
      compactContext: n.data?.compactContext ?? true,
      subagents: {
        enabled: n.data?.enableSubagents !== false,
        maxDepth: Number(n.data?.maxSubagentDepth ?? 2)
      },
      tools: {
        bash: n.data?.enableBashTool !== false,
        fileEdit: n.data?.enableFileEditTool !== false,
        grep: n.data?.enableGrepTool !== false,
        webFetch: n.data?.enableWebFetchTool ?? true
      },
      systemInstructions: n.data?.systemInstructions || 'You are Claude Code, an elite agentic software engineer.'
    };
  });
  setup += JSON.stringify({ claudeCodeAgents: configs }, null, 2);

  return setup;
}

export function generateDisaggregatedLaunchScripts(vllmNodes: Node[], sglangNodes: Node[]): string {
  const parts: string[] = [];

  parts.push(`# ==============================================================================`);
  parts.push(`# ELUVIX DISAGGREGATED PREFILL-DECODE SERVING (RDMA / RoCEv2)`);
  parts.push(`# Generated by Eluvix Orchestration Compiler`);
  parts.push(`# ==============================================================================\n`);

  if (sglangNodes.length > 0) {
    sglangNodes.forEach((node, i) => {
      const d = (node.data as any)?.disaggregation || {};
      const rawModel = (node.data as any)?.selectedModel && (node.data as any).selectedModel !== '*'
        ? (node.data as any).selectedModel
        : 'meta-llama/Llama-3.3-70B-Instruct-FP8';
      const model = escapeShellArg(rawModel, 'meta-llama/Llama-3.3-70B-Instruct-FP8');
      const tp = sanitizePositiveInt(d.tensorParallelSize, 4, 1, 64);
      const ibDev = sanitizeSafeIdentifier(d.rdmaDevice, 'mlx5_0');
      const backend = sanitizeSafeIdentifier(d.kvConnector, 'mooncake');
      const dtype = sanitizeSafeIdentifier(d.kvCacheDtype, 'fp8_e4m3');
      const prefillEndpoint = escapeShellArg(d.prefillEndpoint, 'http://10.200.1.10:30000');
      const decodeEndpoint = escapeShellArg(d.decodeEndpoint, 'http://10.200.1.20:30001');

      parts.push(`### [SGLang Instance ${i + 1}: ${node.data?.label || node.id}]`);
      parts.push(`# Mode: ${d.role || 'pd-router'} | Transfer: ${backend} over ${ibDev} | TP=${tp} | KV=${dtype}\n`);

      parts.push(`cat << 'EOF' > launch-sglang-prefill.sh`);
      parts.push(`#!/usr/bin/env bash`);
      parts.push(`# NODE A — Compute-Bound Prefill Pool (TP=${tp})`);
      parts.push(`python3 -m sglang.launch_server \\`);
      parts.push(`  --model-path ${model} \\`);
      parts.push(`  --disaggregation-mode prefill \\`);
      parts.push(`  --disaggregation-transfer-backend ${backend} \\`);
      parts.push(`  --disaggregation-ib-device ${ibDev} \\`);
      parts.push(`  --tp-size ${tp} \\`);
      parts.push(`  --kv-cache-dtype ${dtype} \\`);
      parts.push(`  --host 0.0.0.0 --port 30000`);
      parts.push(`EOF\n`);

      parts.push(`cat << 'EOF' > launch-sglang-decode.sh`);
      parts.push(`#!/usr/bin/env bash`);
      parts.push(`# NODE B — Bandwidth-Bound Decode Pool (TP=${tp})`);
      parts.push(`python3 -m sglang.launch_server \\`);
      parts.push(`  --model-path ${model} \\`);
      parts.push(`  --disaggregation-mode decode \\`);
      parts.push(`  --disaggregation-transfer-backend ${backend} \\`);
      parts.push(`  --disaggregation-ib-device ${ibDev} \\`);
      parts.push(`  --tp-size ${tp} \\`);
      parts.push(`  --kv-cache-dtype ${dtype} \\`);
      parts.push(`  --host 0.0.0.0 --port 30001`);
      parts.push(`EOF\n`);

      parts.push(`cat << 'EOF' > launch-sglang-router.sh`);
      parts.push(`#!/usr/bin/env bash`);
      parts.push(`# Disaggregated Load Balancer Router`);
      parts.push(`python3 -m sglang_router.launch_router \\`);
      parts.push(`  --pd-disaggregation \\`);
      parts.push(`  --prefill ${prefillEndpoint} \\`);
      parts.push(`  --decode ${decodeEndpoint} \\`);
      parts.push(`  --host 0.0.0.0 --port 8000`);
      parts.push(`EOF\n`);
    });
  }

  if (vllmNodes.length > 0) {
    vllmNodes.forEach((node, i) => {
      const d = (node.data as any)?.disaggregation || {};
      const q = (node.data as any)?.quantization || {};
      const f = (node.data as any)?.fabric || {};
      const rawModel = (node.data as any)?.selectedModel && (node.data as any).selectedModel !== '*'
        ? (node.data as any).selectedModel
        : 'meta-llama/Llama-3.3-70B-Instruct-FP8';
      const model = escapeShellArg(rawModel, 'meta-llama/Llama-3.3-70B-Instruct-FP8');
      const defaultTp = (q.format === 'nvfp4' || q.format === 'mxfp4') ? 1 : 4;
      const tp = sanitizePositiveInt(d.tensorParallelSize, defaultTp, 1, 64);
      const dev = sanitizeSafeIdentifier(d.rdmaDevice, 'mlx5_0:1');
      const port = sanitizePositiveInt(d.sideChannelPort, 5557, 1024, 65535);
      const dtype = sanitizeSafeIdentifier(d.kvCacheDtype, 'fp8_e4m3');
      const safeNodeId = sanitizeSafeIdentifier(node.id, 'node');
      const qformat = sanitizeSafeIdentifier(q.format, 'nvfp4');
      const calibSize = sanitizePositiveInt(q.calibSize, 512, 1, 65536);
      const qps = sanitizePositiveInt(f.qpsPerConnection, 4, 1, 64);
      const carrier = sanitizeIpv6SegmentList(f.srv6UsidCarrier, 'fcbb:bb00:0202:0104:0040::');

      parts.push(`### [vLLM v1 NIXL Instance ${i + 1}: ${node.data?.label || node.id}]`);
      if (f.topology && f.topology !== 'tor-static-ecmp') {
        parts.push(`# Rail-Optimized Clos Fabric (${f.topology}): NCCL PxN + SRv6 uSID + ConnectX-7/8 OOO-DDP`);
        parts.push(`export NCCL_CROSS_NIC=1`);
        parts.push(`export NCCL_PXN_DISABLE=0`);
        parts.push(`export NCCL_IB_QPS_PER_CONNECTION=${qps}`);
        parts.push(`export NCCL_IB_SPLIT_DATA_ON_QPS=1`);
        parts.push(`export NCCL_IB_TC=106`);
        if (f.topology === 'rail-srv6-usid') {
          parts.push(`sysctl -w net.ipv6.conf.all.seg6_enabled=1`);
          parts.push(`ip route replace 10.100.2.0/24 encap seg6 mode encap.red segs ${carrier} dev eth0`);
        }
        if (f.topology === 'rail-dlb-oooddp') {
          parts.push(`# Enable Out-of-Order Direct Data Placement (OOO-DDP) on ConnectX-7/8`);
          parts.push(`mlxconfig -d /dev/mst/mt4129_pciconf0 -y set ROCE_NEXT_PROTOCOL=254 ROCE_CC_PRIO_MASK_P1=255 OO_RECV_WR_EN=1`);
        }
      }
      if (q.format === 'nvfp4' || q.format === 'mxfp4') {
        const rawExportDir = `/models/${String(rawModel).split('/').pop() || 'Llama-3.3-70B'}-${String(qformat).toUpperCase()}-QuaRot`;
        const exportDir = escapeShellArg(rawExportDir, '/models/Llama-3.3-70B-NVFP4-QuaRot');
        parts.push(`# TensorRT ModelOpt PTQ: ${qformat.toUpperCase()} (E2M1) + Walsh-Hadamard (${q.outlierMitigation || 'hadamard-quarot'})`);
        parts.push(`cat << 'EOF' > quantize-and-serve-${qformat}-${safeNodeId}.sh`);
        parts.push(`#!/usr/bin/env bash`);
        parts.push(`set -euo pipefail`);
        parts.push(`MODEL_IN=${model}`);
        parts.push(`EXPORT_DIR=${exportDir}`);
        parts.push(`python3 -m modelopt.torch.quantization.examples.llm_ptq \\`);
        parts.push(`  --model "$MODEL_IN" \\`);
        parts.push(`  --qformat ${qformat} \\`);
        parts.push(`  --kv_cache_dtype fp8 \\`);
        parts.push(`  --calib_size ${calibSize} \\`);
        parts.push(`  --auto_quantize_bits ${qformat === 'nvfp4' ? 4.5 : 4.25} \\`);
        parts.push(`  --export_path "$EXPORT_DIR"`);
        parts.push(`vllm serve "$EXPORT_DIR" \\`);
        parts.push(`  --quantization modelopt \\`);
        parts.push(`  --kv-cache-dtype ${dtype} \\`);
        parts.push(`  --tensor-parallel-size ${tp} \\`);
        parts.push(`  --gpu-memory-utilization 0.92 \\`);
        parts.push(`  --port 8000`);
        parts.push(`EOF\n`);
      }
      parts.push(`cat << 'EOF' > launch-vllm-nixl-nodeA.sh`);
      parts.push(`#!/usr/bin/env bash`);
      parts.push(`# NODE A (10.200.1.10) — PREFILL POOL`);
      parts.push(`export UCX_TLS=rc,sm,cuda_copy,cuda_ipc,gdr_copy`);
      parts.push(`export UCX_NET_DEVICES=${dev}`);
      parts.push(`export VLLM_NIXL_SIDE_CHANNEL_HOST=10.200.1.10`);
      parts.push(`export VLLM_NIXL_SIDE_CHANNEL_PORT=${port}`);
      parts.push(`vllm serve ${model} \\`);
      parts.push(`  --host 0.0.0.0 --port 8100 \\`);
      parts.push(`  --tensor-parallel-size ${tp} \\`);
      parts.push(`  --kv-cache-dtype ${dtype} \\`);
      parts.push(`  --gpu-memory-utilization 0.85 \\`);
      parts.push(`  --kv-transfer-config '{"kv_connector": "NixlConnector", "kv_role": "kv_both"}'`);
      parts.push(`EOF\n`);

      parts.push(`cat << 'EOF' > launch-vllm-nixl-nodeB.sh`);
      parts.push(`#!/usr/bin/env bash`);
      parts.push(`# NODE B (10.200.1.20) — DECODE POOL`);
      parts.push(`export UCX_TLS=rc,sm,cuda_copy,cuda_ipc,gdr_copy`);
      parts.push(`export UCX_NET_DEVICES=${dev}`);
      parts.push(`export VLLM_NIXL_SIDE_CHANNEL_HOST=10.200.1.20`);
      parts.push(`export VLLM_NIXL_SIDE_CHANNEL_PORT=${port}`);
      parts.push(`vllm serve ${model} \\`);
      parts.push(`  --host 0.0.0.0 --port 8200 \\`);
      parts.push(`  --tensor-parallel-size ${tp} \\`);
      parts.push(`  --kv-cache-dtype ${dtype} \\`);
      parts.push(`  --gpu-memory-utilization 0.93 \\`);
      parts.push(`  --kv-transfer-config '{"kv_connector": "NixlConnector", "kv_role": "kv_both"}'`);
      parts.push(`EOF\n`);
    });
  }

  if (sglangNodes.length === 0 && vllmNodes.length === 0) {
    parts.push(`# No vLLM or SGLang nodes configured on canvas.`);
    parts.push(`# Drag a vLLM or SGLang node from the toolbox to generate RDMA launch manifests.`);
  }

  return parts.join('\n');
}

function generateConfidentialAttestationSetup(
  confidentialEnclaveNodes: Node[],
  localEngines: Node[]
): string {
  const enclaveNode = confidentialEnclaveNodes[0];
  const teeEngines = localEngines.filter((n) => (n.data as any)?.confidential?.enabled);

  if (!enclaveNode && teeEngines.length === 0) {
    return '# No Confidential Enclave node or TEE-enabled inference engine configured on canvas.';
  }

  const eData = (enclaveNode?.data || {}) as Record<string, any>;
  const arch = eData.architecture || (teeEngines[0]?.data as any)?.confidential?.architecture || 'sev-snp-h100-cc';
  const policy = eData.confidentialPolicy || 'require-dual-attestation';
  const kbsUrl = eData.kbsEndpoint || 'https://kbs.internal.corp:8080';
  const expectedMeasurement =
    eData.expectedMeasurement || '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

  return [
    `#!/usr/bin/env bash`,
    `# ==============================================================================`,
    `# ELUVIX ZERO-TRUST CONFIDENTIAL SILICON ATTESTATION & TRUSTEE KBS UNSEAL`,
    `# Architecture: ${arch} | Policy: ${policy}`,
    `# Expected Launch Digest (MRTD / MEASUREMENT): ${expectedMeasurement}`,
    `# ==============================================================================`,
    `set -euo pipefail`,
    ``,
    `KBS_URL=${escapeShellArg(kbsUrl)}`,
    `EXPECTED_MEASUREMENT=${escapeShellArg(expectedMeasurement)}`,
    `ENCLAVE_MODEL_DIR="/mnt/enclave_ram/models"`,
    ``,
    `echo "[1/4] Generating Ephemeral RSA-3072 Wrapping Keypair & Fetching KBS Nonce..."`,
    `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out /tmp/enclave_wrap.key`,
    `openssl rsa -in /tmp/enclave_wrap.key -pubout -out /tmp/enclave_wrap.pub`,
    `KBS_NONCE=$(curl -fsSL "$KBS_URL/kbs/v0/auth" | jq -r '.nonce')`,
    ``,
    `# Bind REPORT_DATA = SHA512(nonce || ephemeral_pubkey)`,
    `python3 -c '`,
    `import hashlib, sys`,
    `nonce = open("/dev/stdin").read().strip().encode()`,
    `pub = open("/tmp/enclave_wrap.pub", "rb").read()`,
    `open("/tmp/report_data.bin", "wb").write(hashlib.sha512(nonce + pub).digest())`,
    `' <<< "$KBS_NONCE"`,
    ``,
    `echo "[2/4] Requesting Hardware CPU TEE Attestation Report (/dev/sev-guest at VMPL 0)..."`,
    `snpguest report /tmp/attestation_report.bin /tmp/report_data.bin --vmpl 0`,
    `snpguest certificates PEM ./certs`,
    `snpguest verify attestation ./certs /tmp/attestation_report.bin`,
    ``,
    `echo "[3/4] Verifying NVIDIA H100 / B200 CC-Mode & SPDM 1.2 Reference Integrity Manifests..."`,
    `nvidia-smi conf-compute -f`,
    `python3 - << 'PYEOF'`,
    `from nv_attestation_sdk import attestation`,
    `client = attestation.Attestation("eluvix-enclave-worker")`,
    `client.add_verifier(attestation.Devices.GPU, attestation.Environment.LOCAL, "", "")`,
    `assert client.attest(), "GPU SPDM 1.2 RIM verification failed!"`,
    `PYEOF`,
    `nvidia-smi conf-compute -srs 1`,
    ``,
    `echo "[4/4] Unsealing Encrypted Model Weights into Ephemeral Enclave tmpfs..."`,
    `mkdir -p "$ENCLAVE_MODEL_DIR"`,
    `mount -t tmpfs -o size=160G tmpfs "$ENCLAVE_MODEL_DIR"`,
    `kbs-client --url "$KBS_URL" get-resource --path default/llama3-70b/dek \\`,
    `  | openssl enc -d -aes-256-gcm -in /mnt/encrypted_nvme/llama-70b.enc -out "$ENCLAVE_MODEL_DIR/model.safetensors"`,
    `echo "✓ Confidential Enclave unsealed and ready for zero-trust inference."`
  ].join('\n');
}

