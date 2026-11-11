import { Node, Edge } from '@xyflow/react';
import type { RouterConfig, UpstreamConfig } from '@eluvix/router-core';
import { autoLayoutGraph } from './auto-layout';

function upstreamToNodeType(u: UpstreamConfig): string {
  switch (u.type) {
    case 'lemonade':
      return 'lemonadeNode';
    case 'ollama':
      return 'ollamaNode';
    case 'ramalama':
      return 'ramalamaNode';
    case 'comfyui':
      return 'comfyuiNode';
    case 'audio':
    case 'whisper':
    case 'speaches':
    case 'kokoro-tts':
      return 'audioVoiceNode';
    case 'vllm':
    case 'vllm-sr':
      return 'vllmNode';
    case 'sglang':
      return 'sglangNode';
    case 'billama':
      return 'billamaNode';
    case 'anthropic':
      return 'claudeNode';
    case 'antigravity':
      return 'antigravityNode';
    case 'harness':
      return 'harnessNode';
    case 'openai-compatible':
    default:
      if (u.endpoint?.includes('anthropic.com')) return 'claudeNode';
      return 'openaiNode';
  }
}

export function decompileConfigToGraph(config: RouterConfig): {
  nodes: Node[];
  edges: Edge[];
} {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // 1. Column 0: Client Input Node
  const inputId = 'input-1';
  nodes.push({
    id: inputId,
    type: 'inputNode',
    position: { x: 50, y: 220 },
    data: { label: 'Client Input' },
  });

  let prevPipelineNodeId = inputId;
  let guardY = 120;

  // 2. Column 1: Security & Cache Guards
  if (config.privacyGuard?.enabled) {
    const pgId = 'privacy-guard-1';
    nodes.push({
      id: pgId,
      type: 'privacyGuardNode',
      position: { x: 320, y: guardY },
      data: {
        action: config.privacyGuard.action || 'anonymize',
        redactionStyle: config.privacyGuard.redactionStyle || 'token',
        whitelist: config.privacyGuard.whitelist || [],
        customPatterns: config.privacyGuard.customPatterns || [],
        auditLogging: Boolean(config.privacyGuard.auditLogging),
        detectPii: config.privacyGuard.detectPii || {
          apiKey: true,
          ssn: true,
          creditCard: true,
          email: true,
          phone: true,
          ipAddress: true,
        },
      },
    });
    edges.push({
      id: `e-${prevPipelineNodeId}-${pgId}`,
      source: prevPipelineNodeId,
      target: pgId,
      animated: true,
    });
    prevPipelineNodeId = pgId;
    guardY += 200;
  }

  if (config.promptGuard?.enabled) {
    const sgId = 'semantic-guard-1';
    nodes.push({
      id: sgId,
      type: 'semanticGuardNode',
      position: { x: 600, y: 120 },
      data: {
        routeName: 'prompt-injection-defense',
        encoder: 'deberta-v3-injection',
        threshold: config.promptGuard.threshold ?? 0.85,
        enforcementAction:
          (config.promptGuard as any).action ||
          config.promptGuard.enforcementAction ||
          'block',
        threatVectors: config.promptGuard.threatVectors || {
          instructionOverride: true,
          danJailbreak: true,
          systemPromptLeak: true,
          obfuscation: true,
        },
        bannedPhrases: config.promptGuard.bannedPhrases || [],
      },
    });
    edges.push({
      id: `e-${prevPipelineNodeId}-${sgId}`,
      source: prevPipelineNodeId,
      target: sgId,
      animated: true,
    });
    prevPipelineNodeId = sgId;
  }

  if (config.cache?.enabled) {
    const scId = 'semantic-cache-1';
    nodes.push({
      id: scId,
      type: 'semanticCacheNode',
      position: { x: 600, y: 340 },
      data: {
        mode: config.cache.mode || 'exact',
        similarityThreshold: config.cache.similarityThreshold ?? 0.94,
        ttlSeconds: config.cache.ttlSeconds ?? 3600,
        scopeIsolation: config.cache.scopeIsolation || 'user',
        bypassOnTools: config.cache.bypassOnTools !== false,
      },
    });
    edges.push({
      id: `e-${prevPipelineNodeId}-${scId}`,
      source: prevPipelineNodeId,
      target: scId,
      animated: true,
    });
    prevPipelineNodeId = scId;
  }

  // 3. Column 2: Switchyard Balancer Node
  const swId = 'switchyard-1';
  const swCfg = config.switchyard || {};
  const tierMap = new Map<string, { id: string; name: string; costLabel?: string }>();
  for (const u of config.upstreams || []) {
    const tId = u.tier || 'tier-1';
    if (!tierMap.has(tId)) {
      tierMap.set(tId, {
        id: tId,
        name: u.tierName || (tId === 'tier-1' ? 'Tier 1: Local Fast' : tId === 'tier-2' ? 'Tier 2: Heavy Local' : 'Tier 3: Cloud Frontier'),
        costLabel: u.costPer1kTokens ? `$${u.costPer1kTokens}` : '$0.00',
      });
    }
  }
  if (tierMap.size === 0) {
    tierMap.set('tier-1', { id: 'tier-1', name: 'Tier 1: Local Fast', costLabel: '$0.00' });
    tierMap.set('tier-2', { id: 'tier-2', name: 'Tier 2: Heavy Local', costLabel: '$0.00' });
    tierMap.set('tier-3', { id: 'tier-3', name: 'Tier 3: Cloud Frontier', costLabel: '$0.005' });
  }

  nodes.push({
    id: swId,
    type: 'switchyardNode',
    position: { x: 900, y: 200 },
    data: {
      strategy: swCfg.strategy || config.strategy || 'cost-complexity',
      timeoutMs: swCfg.timeoutMs ?? 60000,
      retryCount: swCfg.retryCount ?? 1,
      spilloverThresholdMs: swCfg.spilloverThresholdMs ?? 30000,
      codeEscalation: swCfg.codeEscalation !== false,
      maxCostPerRequest: swCfg.maxCostPerRequest ?? 0.05,
      ...(swCfg.mediaIntentRouting !== undefined ? { mediaIntentRouting: swCfg.mediaIntentRouting } : {}),
      ...(typeof swCfg.maxDailySpendUsd === 'number' && swCfg.maxDailySpendUsd > 0
        ? {
            maxDailySpendUsd: swCfg.maxDailySpendUsd,
            budgetExhaustedAction: swCfg.budgetExhaustedAction || 'prefer-local',
          }
        : {}),
      complexityThresholds: swCfg.complexityThresholds || {
        moderate: 300,
        heavy: 1500,
        frontier: 6000,
      },
      routes: Array.from(tierMap.values()),
      ...(config.confidentialPolicy ? { confidentialPolicy: config.confidentialPolicy } : {}),
      ...(config.quantizationPolicy ? { quantizationPolicy: config.quantizationPolicy } : {}),
      ...(config.fabricPolicy ? { fabricPolicy: config.fabricPolicy } : {}),
      ...(config.crsPolicy ? { crsPolicy: config.crsPolicy } : {}),
      ...(config.attentionPolicy ? { attentionPolicy: config.attentionPolicy } : {}),
    },
  });

  edges.push({
    id: `e-${prevPipelineNodeId}-${swId}`,
    source: prevPipelineNodeId,
    target: swId,
    animated: true,
  });

  // 4. Column 3: Upstream Engine / Provider / Agent Nodes
  const upstreams = config.upstreams || [];
  upstreams.forEach((u, idx) => {
    const nodeType = upstreamToNodeType(u);
    const selectedModel = Array.isArray(u.models) && u.models.length > 0 ? u.models[0] : '*';
    const baseData: Record<string, any> = {
      label: u.name,
      endpoint: u.endpoint,
      priority: u.priority,
      selectedModel,
      models: u.models || [selectedModel],
      visionCapable: Array.isArray(u.capabilities) && u.capabilities.includes('vision'),
      ...(u.costPer1kTokens !== undefined ? { costPer1kTokens: u.costPer1kTokens } : {}),
      ...(u.maxComplexityScore !== undefined ? { maxComplexityScore: u.maxComplexityScore } : {}),
      ...(u.maxContextTokens !== undefined ? { maxContextTokens: u.maxContextTokens } : {}),
      ...(u.maxParallelRequests !== undefined ? { maxParallelRequests: u.maxParallelRequests } : {}),
      ...(u.monthlySpendLimit !== undefined ? { monthlySpendLimit: u.monthlySpendLimit } : {}),
      ...(u.ramalama ? { ramalama: { ...u.ramalama } } : {}),
      ...(u.comfyui ? { comfyui: { ...u.comfyui } } : {}),
      ...(u.disaggregation ? { disaggregation: { ...u.disaggregation } } : {}),
      ...(u.confidential ? { confidential: { ...u.confidential } } : {}),
      ...(u.quantization ? { quantization: { ...u.quantization } } : {}),
      ...(u.fabric ? { fabric: { ...u.fabric } } : {}),
      ...(u.attentionKernel ? { attentionKernel: { ...u.attentionKernel } } : {}),
      ...(u.crs ? { crs: { ...u.crs } } : {}),
      ...(u.vectorcraft ? { vectorcraft: { ...u.vectorcraft } } : {}),
      ...(u.artcraft ? { artcraft: { ...u.artcraft } } : {}),
      ...(u.comfyui ? { comfyui: { ...u.comfyui } } : {}),
      ...(u.audio ? { audio: { ...u.audio } } : {}),
    };

    if (nodeType === 'antigravityNode' && u.antigravity) {
      Object.assign(baseData, {
        model: u.antigravity.model || selectedModel,
        executionMode: u.antigravity.executionMode || 'cli',
        cliPath: u.antigravity.cliPath || 'agy',
        cwd: u.antigravity.cwd,
        sandboxMode: u.antigravity.sandbox || 'standard',
        agentBehavior: u.antigravity.behavior || 'autonomous',
        extendedThinking: u.antigravity.extendedThinking,
        thinkingBudget: u.antigravity.thinkingBudget,
        enableSubagents: u.antigravity.subagents,
        maxSubagentDepth: u.antigravity.maxSubagentDepth,
        effort: u.antigravity.effort,
        cleanHeadless: u.antigravity.cleanHeadless,
      });
    }

    if (nodeType === 'harnessNode' && u.harness) {
      const h = u.harness as Record<string, any>;
      Object.assign(baseData, {
        kind: h.kind || 'trueforge',
        transport: h.transport || (u.endpoint?.startsWith('acp://') ? 'acp' : 'http'),
        profile: h.profile,
        workspaceDir: h.workspaceDir,
        maxTurns: h.maxTurns,
        approvalMode: h.approvalMode || h.approvals,
        command: h.command,
        args: h.args,
        cwd: h.cwd,
        ...(typeof h.providerIsLocal === 'boolean'
          ? { providerIsLocal: h.providerIsLocal }
          : {}),
      });
    }

    nodes.push({
      id: u.id,
      type: nodeType,
      position: { x: 1320, y: 40 + idx * 210 },
      data: baseData,
    });

    edges.push({
      id: `e-${swId}-${u.id}`,
      source: swId,
      target: u.id,
      sourceHandle: u.tier || 'tier-1',
      animated: true,
    });

    if (u.comfyui?.promptEnhancerUpstreamId) {
      edges.push({
        id: `e-${u.comfyui.promptEnhancerUpstreamId}-${u.id}`,
        source: u.comfyui.promptEnhancerUpstreamId,
        target: u.id,
        animated: true,
      });
    }
  });

  // 5. Column 4: Context / Memory / Knowledge / Sandbox Overlays
  let overlayY = 60;
  if (config.memory?.enabled) {
    const memId = 'memory-1';
    nodes.push({
      id: memId,
      type: 'memoryNode',
      position: { x: 900, y: 520 },
      data: {
        ...config.memory,
      },
    });
    edges.push({
      id: `e-${memId}-${swId}`,
      source: memId,
      target: swId,
      animated: true,
    });
  }

  if (config.knowledge?.enabled) {
    const kbId = 'knowledge-base-1';
    nodes.push({
      id: kbId,
      type: 'knowledgeBaseNode',
      position: { x: 900, y: 720 },
      data: {
        ...config.knowledge,
      },
    });
    const ramalamaTarget = nodes.find((n) => n.type === 'ramalamaNode');
    edges.push({
      id: `e-${kbId}-${ramalamaTarget ? ramalamaTarget.id : swId}`,
      source: kbId,
      target: ramalamaTarget ? ramalamaTarget.id : swId,
      animated: true,
    });
  }

  if (config.sandbox?.enabled) {
    const sbId = 'sandbox-1';
    nodes.push({
      id: sbId,
      type: 'sandboxNode',
      position: { x: 1720, y: overlayY },
      data: {
        ...config.sandbox,
      },
    });
    overlayY += 200;
  }

  if (config.cascade?.enabled) {
    const casId = config.cascade.id || 'speculative-cascade-1';
    nodes.push({
      id: casId,
      type: 'speculativeCascadeNode',
      position: { x: 920, y: 460 },
      data: {
        label: 'Speculative Cascade',
        ...config.cascade,
      },
    });
    edges.push({
      id: `e-${prevPipelineNodeId}-${casId}`,
      source: prevPipelineNodeId,
      target: casId,
      animated: true,
    });
    if (config.cascade.draftUpstreamId) {
      edges.push({
        id: `e-${casId}-draft-${config.cascade.draftUpstreamId}`,
        source: casId,
        sourceHandle: 'draft',
        target: config.cascade.draftUpstreamId,
        animated: true,
      });
    }
    if (config.cascade.verifierUpstreamId) {
      edges.push({
        id: `e-${casId}-verifier-${config.cascade.verifierUpstreamId}`,
        source: casId,
        sourceHandle: 'verifier',
        target: config.cascade.verifierUpstreamId,
        animated: true,
      });
    }
    if (config.cascade.shadowStudentUpstreamId) {
      edges.push({
        id: `e-${casId}-shadow-${config.cascade.shadowStudentUpstreamId}`,
        source: casId,
        sourceHandle: 'shadow-student',
        target: config.cascade.shadowStudentUpstreamId,
        animated: true,
      });
    }
  }

  return { nodes: autoLayoutGraph(nodes, edges), edges };
}
