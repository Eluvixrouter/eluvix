import { Node, Edge } from '@xyflow/react';

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
  rawRouterConfig: any;
}

export function compileGraph(nodes: Node[], edges: Edge[]): CompilationResult {
  // 1. Extract Local Engine Nodes (Lemonade, vLLM, Ollama) and Cloud Providers (Billama, OpenAI, Claude)
  const localEngineNodes = nodes.filter(n => n.type === 'lemonadeNode' || n.type === 'vllmNode' || n.type === 'ollamaNode');
  const billamaNodes = nodes.filter(n => n.type === 'billamaNode');
  const openaiNodes = nodes.filter(n => n.type === 'openaiNode');
  const claudeNodes = nodes.filter(n => n.type === 'claudeNode');
  const switchyardNodes = nodes.filter(n => n.type === 'switchyardNode');
  const antigravityNodes = nodes.filter(n => n.type === 'antigravityNode');
  const codexNodes = nodes.filter(n => n.type === 'codexNode');
  const claudeCodeNodes = nodes.filter(n => n.type === 'claudeCodeNode');
  
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
    claudeNodes
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
    claudeNodes
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
  claudeNodes: Node[] = []
): any {
  const upstreams: any[] = [];
  const switchyard = switchyardNodes[0];
  const switchyardStrategy = String(switchyard?.data?.strategy || 'cost-complexity');
  const routes: Array<{ id: string; name: string; costLabel?: string }> = 
    Array.isArray(switchyard?.data?.routes) ? switchyard.data.routes : [];

  // Map each connected engine node from Switchyard's output handles
  const tierMap = new Map<string, { tierId: string; tierName: string; costPer1kTokens: number; maxComplexityScore: number }>();

  if (switchyard) {
    const outgoingEdges = edges.filter(e => e.source === switchyard.id);
    outgoingEdges.forEach((edge, idx) => {
      const handleId = edge.sourceHandle || (routes[idx] ? routes[idx].id : `tier-${idx + 1}`);
      const route = routes.find(r => r.id === handleId);

      let cost = 0.0;
      let maxComplexity = 2;
      if (handleId === 'tier-1') {
        cost = 0.0;
        maxComplexity = 1;
      } else if (handleId === 'tier-2') {
        cost = 0.0;
        maxComplexity = 3;
      } else if (handleId === 'tier-3') {
        cost = 0.0;
        maxComplexity = 3;
      } else if (handleId === 'tier-4') {
        cost = 0.003;
        maxComplexity = 4;
      } else {
        cost = idx * 0.002;
        maxComplexity = Math.min(4, idx + 1);
      }

      tierMap.set(edge.target, {
        tierId: handleId,
        tierName: route?.name || handleId,
        costPer1kTokens: cost,
        maxComplexityScore: maxComplexity
      });
    });
  }

  localEngines.forEach(node => {
    let type = 'lemonade';
    let defaultEndpoint = 'http://localhost:13305';
    let defaultName = 'Lemonade Engine';

    if (node.type === 'vllmNode') {
      type = 'vllm';
      defaultEndpoint = 'http://localhost:8000';
      defaultName = 'vLLM Engine';
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
      costPer1kTokens: 0.0,
      maxComplexityScore: type === 'lemonade' ? 2 : 3
    };

    upstreams.push({
      id: String(node.id),
      name: String(node.data?.label || defaultName),
      type,
      endpoint: String(node.data?.endpoint || defaultEndpoint),
      priority: Number(node.data?.priority || (type === 'lemonade' ? 25 : type === 'vllm' ? 22 : 20)),
      models: selected,
      tier: tierInfo.tierId,
      tierName: tierInfo.tierName,
      costPer1kTokens: tierInfo.costPer1kTokens,
      maxComplexityScore: tierInfo.maxComplexityScore,
      capabilities: node.data?.visionCapable ? ["vision"] : []
    });
  });

  modelGateways.forEach(node => {
    const tierInfo = tierMap.get(node.id) || {
      tierId: 'tier-3',
      tierName: 'Tier 3: Economy Cloud',
      costPer1kTokens: 0.005,
      maxComplexityScore: 4
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
      maxComplexityScore: tierInfo.maxComplexityScore,
      capabilities: node.data?.visionCapable ? ["vision"] : []
    });
  });

  antigravityNodes.forEach(node => {
    const modelId = node.data?.model === 'custom' 
      ? (node.data?.customModel || 'custom-agent') 
      : (node.data?.model || 'gemini-3.8-flash');
    const tierInfo = tierMap.get(node.id) || {
      tierId: 'tier-2',
      tierName: 'Tier 2: Antigravity Autonomous Agent',
      costPer1kTokens: 0.0,
      maxComplexityScore: 4
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
      maxComplexityScore: tierInfo.maxComplexityScore,
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
      costPer1kTokens: 0.001,
      maxComplexityScore: 4
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
      maxComplexityScore: tierInfo.maxComplexityScore,
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
      costPer1kTokens: 0.003,
      maxComplexityScore: 4
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
      maxComplexityScore: tierInfo.maxComplexityScore,
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
      costPer1kTokens: Number(node.data?.costPer1kTokens ?? 0.002),
      maxComplexityScore: 4
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
      costPer1kTokens: tierInfo.costPer1kTokens,
      maxComplexityScore: tierInfo.maxComplexityScore,
      capabilities: node.data?.visionCapable ? ["vision"] : []
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
      costPer1kTokens: Number(node.data?.costPer1kTokens ?? 0.005),
      maxComplexityScore: 4
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
      costPer1kTokens: tierInfo.costPer1kTokens,
      maxComplexityScore: tierInfo.maxComplexityScore,
      capabilities: node.data?.visionCapable ? ["vision"] : []
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
      costPer1kTokens: Number(node.data?.costPer1kTokens ?? 0.003),
      maxComplexityScore: 4
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
      costPer1kTokens: tierInfo.costPer1kTokens,
      maxComplexityScore: tierInfo.maxComplexityScore,
      capabilities: node.data?.visionCapable ? ["vision"] : []
    });
  });

  const swData = (switchyard?.data || {}) as Record<string, any>;
  const thresholds = (swData.complexityThresholds || {}) as Record<string, any>;
  const switchyardConfig = switchyard ? {
    strategy: switchyardStrategy,
    timeoutMs: Number(swData.timeoutMs ?? 60000),
    retryCount: Number(swData.retryCount ?? 1),
    spilloverThresholdMs: Number(swData.spilloverThresholdMs ?? 30000),
    codeEscalation: swData.codeEscalation !== false,
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

  return {
    upstreams,
    strategy: switchyardStrategy,
    fallbackStrategy: switchyardStrategy === 'round-robin' ? 'round-robin' : 'priority',
    switchyard: switchyardConfig,
    modelGateway: modelGatewayConfig,
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
  claudeNodes: Node[] = []
): string {
  if (
    nodes.length === 0 &&
    localEngines.length === 0 &&
    antigravityNodes.length === 0 &&
    codexNodes.length === 0 &&
    claudeCodeNodes.length === 0 &&
    billamaNodes.length === 0 &&
    openaiNodes.length === 0 &&
    claudeNodes.length === 0
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
    const type = node.type === 'lemonadeNode' ? 'lemonade' : node.type === 'vllmNode' ? 'vllm' : 'ollama';
    const endpoint = data.endpoint || (type === 'lemonade' ? 'http://localhost:13305' : type === 'vllm' ? 'http://localhost:8000' : 'http://localhost:11434');
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
    const model = node.data?.model === 'custom' ? (node.data?.customModel || 'custom') : (node.data?.model || 'gemini-3.8-flash');
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
      ? (node.data?.customModel || 'gemini-3.8-flash')
      : (node.data?.model || 'gemini-3.8-flash');
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
    model: n.data?.model === 'custom' ? n.data?.customModel : (n.data?.model || 'gemini-3.8-flash'),
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
    
    setup += `  // Guard Node: ${node.id} (${routeName})\n`;
    setup += `  const guard_${node.id.replace(/-/g, '_')} = new SemanticRouter({\n`;
    setup += `    name: "${routeName}",\n`;
    setup += `    encoder: "${encoder}",\n`;
    setup += `    similarityThreshold: ${threshold},\n`;
    setup += `    enforcementAction: "${action}",\n`;
    setup += `    threatVectors: ${JSON.stringify(vectors)},\n`;
    if (banned.length > 0) {
      setup += `    bannedPhrases: ${JSON.stringify(banned)},\n`;
    }
    setup += `    mode: "${encoder.includes('injection') || encoder.includes('guard') ? 'classifier-firewall' : 'vector-clustering'}"\n`;
    setup += `  });\n\n`;
  });
  
  setup += '  return { guards: [' + nodes.map(n => `guard_${n.id.replace(/-/g, '_')}`).join(', ') + '] };\n};\n';
  
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

    setup += `  action: "${action}",\n`;
    setup += `  redactionStyle: "${redactionStyle}",\n`;
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

    setup += `  // Telemetry Exporter: ${exporter}\n`;
    setup += `  const logger_${node.id.replace(/-/g, '_')} = initLogger({\n`;
    setup += `    projectName: "${projectName}",\n`;
    setup += `    exporter: "${exporter}",\n`;
    if (endpointUrl) {
      setup += `    endpointUrl: "${endpointUrl}",\n`;
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

    setup += `# Codex Agent Node: ${node.id} (${model})\n`;
    setup += `codex_agent_${node.id.replace(/-/g, '_')} = {\n`;
    setup += `    "name": "Codex Agent (${model})",\n`;
    setup += `    "model": "${model}",\n`;
    if (model === 'o3-mini' || model === 'o1' || model === 'o1-mini') {
      setup += `    "reasoning_effort": "${reasoningEffort}",\n`;
    }
    setup += `    "instructions": "${instructions}",\n`;
    setup += `    "environment": {\n`;
    setup += `        "type": "${env}",\n`;
    setup += `        "approval_mode": "${approval}",\n`;
    setup += `        "working_directory": "${workDir}",\n`;
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

