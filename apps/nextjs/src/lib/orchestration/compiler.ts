import { Node, Edge } from '@xyflow/react';
import {
  escapeShellArg,
  sanitizeSafeIdentifier,
  sanitizeIpv6SegmentList,
  sanitizePositiveInt
} from '@eluvix/router-core/shell-utils';
import {
  generateCrsVerificationScript,
  type CrsOverlayConfig
} from '@eluvix/router-core/neuro-symbolic-crs';
import {
  generateVectorCraftSetupScript,
  toHarnessMcpServerConfig,
  resolveVectorCraftAutoApproveTools,
  type VectorCraftMcpConfig
} from '@eluvix/router-core/vectorcraft-mcp';
import {
  ARTCRAFT_APPS_CATALOG,
  generateArtCraftSetupScript,
  toArtCraftHarnessMcpServers,
  resolveArtCraftAutoApproveTools,
  buildArtCraftCliArgs,
  type ArtCraftAppId,
  type ArtCraftMcpConfig
} from '@eluvix/router-core/artcraft-mcp';
import {
  generateFlashAttentionKernelLaunchScript,
  type AttentionKernelConfig
} from '@eluvix/router-core/flash-attention-kernels';
import {
  generateComfyUISetupScript,
  toComfyMcpServerConfig,
  type ComfyUIConfig
} from '@eluvix/router-core/comfyui';
import {
  generateAudioVoiceSetupScript,
  STT_BACKEND_PRESETS,
  TTS_BACKEND_PRESETS,
  type AudioVoiceConfig,
  type SttBackendPreset,
  type TtsBackendPreset
} from '@eluvix/router-core/audio';
import type { SpeculativeCascadeConfig } from '@eluvix/router-core/cascade';
import {
  analyzeGraphDiagnostics,
  type GraphDiagnosticsReport
} from './diagnostics';

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
  crsSetup?: string;
  vectorcraftSetup?: string;
  artcraftSetup?: string;
  ramalamaSetup?: string;
  comfyuiSetup?: string;
  audioSetup?: string;
  diagnostics?: GraphDiagnosticsReport;
  rawRouterConfig: any;
}

export function compileGraph(nodes: Node[], edges: Edge[]): CompilationResult {
  // 1. Extract Local Engine Nodes (Lemonade, vLLM, SGLang, Ollama, RamaLama, ComfyUI, Audio) and Cloud Providers (Billama, OpenAI, Claude)
  const localEngineNodes = nodes.filter(
    n =>
      n.type === 'lemonadeNode' ||
      n.type === 'vllmNode' ||
      n.type === 'sglangNode' ||
      n.type === 'ollamaNode' ||
      n.type === 'ramalamaNode' ||
      n.type === 'comfyuiNode' ||
      n.type === 'audioVoiceNode'
  );
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
  const speculativeCascadeNodes = nodes.filter(n => n.type === 'speculativeCascadeNode');
  const confidentialEnclaveNodes = nodes.filter(n => n.type === 'confidentialEnclaveNode');
  const crsNodes = nodes.filter(n => n.type === 'crsNode');
  const vectorcraftNodes = nodes.filter(n => n.type === 'vectorcraftNode' || n.type === 'artcraftNode');
  
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
  const agentGatewayConfig = generateAgentGatewayJson(agentGateways, mcpTools, edges, vectorcraftNodes);

  // 7. Extract Observability Configurations
  const observabilityNodes = nodes.filter(n => n.type === 'observabilityNode');
  const observabilityConfig = generateObservabilitySetup(observabilityNodes);

  // 8. Extract Autonomous Agent Configurations (AGY, Codex, Claude Code)
  const antigravityConfig = generateAntigravitySetup(antigravityNodes, edges);
  const codexConfig = generateCodexSetup(codexNodes, edges);
  const claudeCodeConfig = generateClaudeCodeSetup(claudeCodeNodes, edges, vectorcraftNodes);

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
    confidentialEnclaveNodes,
    crsNodes,
    vectorcraftNodes,
    mcpTools,
    agentGateways,
    speculativeCascadeNodes,
    observabilityNodes
  );

  const allUpstreamCapableNodes = [
    ...localEngineNodes,
    ...harnessNodes,
    ...antigravityNodes,
    ...codexNodes,
    ...claudeCodeNodes
  ];
  const vcSetupScript = generateVectorCraftSetup(vectorcraftNodes, allUpstreamCapableNodes);
  const ramalamaNodes = localEngineNodes.filter(n => n.type === 'ramalamaNode');
  const ramalamaSetupScript = generateRamalamaSetup(
    ramalamaNodes,
    edges,
    knowledgeBaseNodes,
    sandboxNodes,
    confidentialEnclaveNodes
  );
  const comfyuiNodes = localEngineNodes.filter(n => n.type === 'comfyuiNode');
  const comfyuiSetupScript = generateComfyUISetup(
    comfyuiNodes,
    localEngineNodes,
    vectorcraftNodes,
    edges
  );
  const audioVoiceNodes = localEngineNodes.filter(n => n.type === 'audioVoiceNode');
  const audioSetupScript = generateAudioSetup(audioVoiceNodes);
  const diagnostics = analyzeGraphDiagnostics(nodes, edges);

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
    crsSetup: generateCrsSetup(crsNodes, allUpstreamCapableNodes),
    vectorcraftSetup: vcSetupScript,
    artcraftSetup: vcSetupScript,
    ramalamaSetup: ramalamaSetupScript,
    comfyuiSetup: comfyuiSetupScript,
    ...(audioSetupScript ? { audioSetup: audioSetupScript } : {}),
    diagnostics,
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
  confidentialEnclaveNodes: Node[] = [],
  crsNodes: Node[] = [],
  vectorcraftNodes: Node[] = [],
  mcpTools: Node[] = [],
  agentGateways: Node[] = [],
  speculativeCascadeNodes: Node[] = [],
  observabilityNodes: Node[] = []
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

  const primaryCrs = crsNodes[0];
  const crsNodeData = (primaryCrs?.data || {}) as Record<string, any>;
  const buildCrsCfgForNode = (node: Node): CrsOverlayConfig | undefined => {
    const nodeCrs = (node.data as any)?.crs;
    const connectedToCrs = crsNodes.some(crs => {
      const direct = edges.some(
        e => (e.source === crs.id && e.target === node.id) || (e.target === crs.id && e.source === node.id)
      );
      if (direct) return true;
      const crsToSwitchyard = edges.some(
        e => (e.source === crs.id && switchyardNodes.some(s => s.id === e.target)) ||
             (e.target === crs.id && switchyardNodes.some(s => s.id === e.source))
      );
      const switchyardToNode = edges.some(
        e => (switchyardNodes.some(s => s.id === e.source) && e.target === node.id) ||
             (switchyardNodes.some(s => s.id === e.target) && e.source === node.id)
      );
      return crsToSwitchyard && switchyardToNode;
    });

    if (nodeCrs?.enabled || connectedToCrs) {
      return {
        enabled: true,
        policy: (nodeCrs?.policy || crsNodeData.crsPolicy || 'slice-and-verify') as any,
        slicerMode: (nodeCrs?.slicerMode || crsNodeData.slicerMode || 'backward-def-use') as any,
        sanitizerArch: (nodeCrs?.sanitizerArch || crsNodeData.sanitizerArch || 'asan-x86_64') as any,
        targetSink: String(nodeCrs?.targetSink || crsNodeData.targetSink || 'memcpy'),
        stallThresholdSeconds: Number(nodeCrs?.stallThresholdSeconds ?? crsNodeData.stallThresholdSeconds ?? 300),
        defaultBitWidth: (Number(nodeCrs?.defaultBitWidth ?? crsNodeData.defaultBitWidth ?? 16) as 8 | 16 | 32 | 64)
      };
    }
    return undefined;
  };

  const normalizeVcNodeData = (vcData: Record<string, any>): VectorCraftMcpConfig => {
    const readRoots = Array.isArray(vcData.readRoots)
      ? vcData.readRoots.map((r: any) => String(r).trim()).filter(Boolean)
      : vcData.readRoot
        ? [String(vcData.readRoot).trim()].filter(Boolean)
        : [];
    const writeRoots = Array.isArray(vcData.writeRoots)
      ? vcData.writeRoots.map((w: any) => String(w).trim()).filter(Boolean)
      : vcData.writeRoot
        ? [String(vcData.writeRoot).trim()].filter(Boolean)
        : [];
    return {
      enabled: true,
      cliCommand: String(vcData.cliCommand || vcData.cliBinary || 'vectorcraft-cli'),
      backendMode: (vcData.backendMode || vcData.mode || 'auto') as any,
      controlAddress: String(vcData.controlAddress || vcData.connectAddress || '127.0.0.1:7979'),
      defaultPromptWorkflow: (vcData.defaultPromptWorkflow || vcData.promptPreset || 'poster') as any,
      autoApproveTier: (vcData.autoApproveTier || 'canvas-draw') as any,
      defaultExportFormat: (vcData.defaultExportFormat || 'svg') as any,
      ...(readRoots.length > 0 ? { readRoots } : {}),
      ...(writeRoots.length > 0 ? { writeRoots } : {})
    };
  };

  const normalizeAcNodeData = (acData: Record<string, any>): ArtCraftMcpConfig => {
    const appId: ArtCraftAppId =
      acData.app && ARTCRAFT_APPS_CATALOG[acData.app as ArtCraftAppId]
        ? (acData.app as ArtCraftAppId)
        : 'vectorcraft';
    const spec = ARTCRAFT_APPS_CATALOG[appId];
    const rawEnabledApps = acData.enabledApps || acData.apps;
    const enabledApps: ArtCraftAppId[] =
      Array.isArray(rawEnabledApps) && rawEnabledApps.length > 0
        ? Array.from(
            new Set(
              rawEnabledApps
                .map((a: any) => String(a) as ArtCraftAppId)
                .filter(a => Boolean(ARTCRAFT_APPS_CATALOG[a]))
            )
          )
        : [appId];
    const readRoots = Array.isArray(acData.readRoots)
      ? acData.readRoots.map((r: any) => String(r).trim()).filter(Boolean)
      : acData.readRoot
        ? [String(acData.readRoot).trim()].filter(Boolean)
        : [];
    const writeRoots = Array.isArray(acData.writeRoots)
      ? acData.writeRoots.map((w: any) => String(w).trim()).filter(Boolean)
      : acData.writeRoot
        ? [String(acData.writeRoot).trim()].filter(Boolean)
        : [];
    const autoTierRaw = String(acData.autoApproveTier || 'workspace-edit');
    const autoApproveTier =
      autoTierRaw === 'readonly-inspect'
        ? 'readonly-inspect'
        : autoTierRaw === 'full-automation'
          ? 'full-automation'
          : 'workspace-edit';
    return {
      enabled: true,
      app: appId,
      ...(enabledApps.length > 1 || enabledApps[0] !== appId ? { enabledApps } : {}),
      cliCommand: String(acData.cliCommand || acData.cliBinary || spec.cliBinary),
      backendMode: (acData.backendMode || acData.mode || 'auto') as any,
      controlAddress: String(
        acData.controlAddress ||
          acData.connectAddress ||
          `127.0.0.1:${spec.defaultControlPort ?? 7979}`
      ),
      ...(acData.defaultPromptWorkflow && acData.defaultPromptWorkflow !== 'none'
        ? { defaultPromptWorkflow: String(acData.defaultPromptWorkflow) }
        : {}),
      autoApproveTier,
      defaultExportFormat: String(acData.defaultExportFormat || spec.defaultExportFormat),
      ...(readRoots.length > 0 ? { readRoots } : {}),
      ...(writeRoots.length > 0 ? { writeRoots } : {})
    };
  };

  const isMultiOrNonVectorCraftNode = (vcNode?: Node): boolean => {
    if (!vcNode) return false;
    if (vcNode.type === 'artcraftNode') return true;
    const d = (vcNode.data || {}) as Record<string, any>;
    if (d.app && d.app !== 'vectorcraft') return true;
    const list = d.enabledApps || d.apps;
    if (Array.isArray(list) && (list.length > 1 || (list.length === 1 && list[0] !== 'vectorcraft'))) {
      return true;
    }
    return false;
  };

  const primaryVcNode = vectorcraftNodes[0];
  const primaryVcConfig = primaryVcNode
    ? normalizeVcNodeData((primaryVcNode.data || {}) as Record<string, any>)
    : undefined;
  const primaryAcConfig =
    primaryVcNode && isMultiOrNonVectorCraftNode(primaryVcNode)
      ? normalizeAcNodeData((primaryVcNode.data || {}) as Record<string, any>)
      : undefined;

  const findConnectedArtCraftNode = (node: Node): Node | undefined => {
    return vectorcraftNodes.find(vc => {
      const direct = edges.some(
        e => (e.source === vc.id && e.target === node.id) || (e.target === vc.id && e.source === node.id)
      );
      if (direct) return true;
      const viaSwitchyard =
        edges.some(
          e =>
            (e.source === vc.id && switchyardNodes.some(s => s.id === e.target)) ||
            (e.target === vc.id && switchyardNodes.some(s => s.id === e.source))
        ) &&
        edges.some(
          e =>
            (switchyardNodes.some(s => s.id === e.source) && e.target === node.id) ||
            (switchyardNodes.some(s => s.id === e.target) && e.source === node.id)
        );
      if (viaSwitchyard) return true;
      const viaGateway =
        edges.some(
          e =>
            (e.source === vc.id && agentGateways.some(g => g.id === e.target)) ||
            (e.target === vc.id && agentGateways.some(g => g.id === e.source))
        ) &&
        edges.some(
          e =>
            (agentGateways.some(g => g.id === e.source) && e.target === node.id) ||
            (agentGateways.some(g => g.id === e.target) && e.source === node.id)
        );
      return viaGateway;
    });
  };

  const buildVectorCraftCfgForNode = (node: Node): VectorCraftMcpConfig | undefined => {
    const nodeVc = (node.data as any)?.vectorcraft;
    if (nodeVc?.enabled) {
      return normalizeVcNodeData(nodeVc);
    }
    const matchingVcNode = findConnectedArtCraftNode(node);
    if (matchingVcNode) {
      return normalizeVcNodeData((matchingVcNode.data || {}) as Record<string, any>);
    }
    return undefined;
  };

  const buildArtCraftCfgForNode = (node: Node): ArtCraftMcpConfig | undefined => {
    const nodeAc = (node.data as any)?.artcraft;
    if (nodeAc?.enabled) {
      return normalizeAcNodeData(nodeAc);
    }
    const matchingVcNode = findConnectedArtCraftNode(node);
    if (matchingVcNode && isMultiOrNonVectorCraftNode(matchingVcNode)) {
      return normalizeAcNodeData((matchingVcNode.data || {}) as Record<string, any>);
    }
    return undefined;
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
    } else if (node.type === 'ramalamaNode') {
      type = 'ramalama';
      defaultEndpoint = 'http://localhost:8080';
      defaultName = 'RamaLama Engine';
    } else if (node.type === 'comfyuiNode') {
      type = 'comfyui';
      defaultEndpoint = 'http://localhost:8188';
      defaultName = 'ComfyUI Engine';
    } else if (node.type === 'audioVoiceNode') {
      type = 'audio';
      defaultEndpoint = 'http://localhost:8005';
      defaultName = 'Sovereign Audio Engine';
    }

    const discovered = Array.isArray(node.data?.models) ? (node.data?.models as string[]) : [];
    const audioRaw = (node.data as any)?.audio || {};
    const defaultAudioModels =
      type === 'audio'
        ? (() => {
            const mode = audioRaw.mode || 'both';
            const sttSpec =
              STT_BACKEND_PRESETS[(audioRaw.sttBackend || audioRaw.sttPreset || 'speaches') as SttBackendPreset] ||
              STT_BACKEND_PRESETS.speaches;
            const ttsSpec =
              TTS_BACKEND_PRESETS[(audioRaw.ttsBackend || audioRaw.ttsPreset || 'kokoro') as TtsBackendPreset] ||
              TTS_BACKEND_PRESETS.kokoro;
            const list: string[] = [];
            if (mode === 'both' || mode === 'stt') list.push(sttSpec.defaultModel, 'whisper-1');
            if (mode === 'both' || mode === 'tts') list.push(ttsSpec.defaultModel, 'tts-1');
            return Array.from(new Set(list));
          })()
        : [];
    const selected = node.data?.selectedModel && node.data.selectedModel !== '*'
      ? [String(node.data.selectedModel)]
      : (discovered.length > 0 ? discovered : type === 'audio' ? defaultAudioModels : ['*']);

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
    const attentionRaw = (node.data as any)?.attentionKernel;
    const attentionKernelConfig: AttentionKernelConfig | undefined =
      attentionRaw && attentionRaw.enabled !== false
        ? { ...attentionRaw, enabled: true }
        : undefined;
    const crsCfg = buildCrsCfgForNode(node);
    const vcCfg = buildVectorCraftCfgForNode(node);
    const acCfg = buildArtCraftCfgForNode(node);
    const ramalamaRaw = (node.data as any)?.ramalama || {};
    const connectedKbNode =
      type === 'ramalama'
        ? knowledgeBaseNodes.find(kb =>
            edges.some(
              e =>
                (e.source === kb.id && e.target === node.id) ||
                (e.target === kb.id && e.source === node.id)
            )
          )
        : undefined;
    const connectedAirgapSandbox =
      type === 'ramalama'
        ? sandboxNodes.some(sb => {
            const sbPolicy = String((sb.data as any)?.networkPolicy || 'none');
            const wired = edges.some(
              e =>
                (e.source === sb.id && e.target === node.id) ||
                (e.target === sb.id && e.source === node.id)
            );
            return wired && sbPolicy === 'none';
          })
        : false;

    const rawRagUri = String(
      ramalamaRaw.ragOciUri || (node.data as any)?.ragOciUri || ''
    ).trim();
    let resolvedRagOciUri = rawRagUri || undefined;
    if (!resolvedRagOciUri && connectedKbNode) {
      const kbUri = String((connectedKbNode.data as any)?.collectionUri || '').trim();
      if (kbUri.startsWith('oci://')) {
        resolvedRagOciUri = kbUri;
      } else {
        const slug = sanitizeSafeIdentifier(
          kbUri.replace(/^[a-z0-9+.-]+:\/\/(?:resources\/)?/i, '') || 'docs',
          'docs'
        ).toLowerCase();
        resolvedRagOciUri = `oci://quay.io/eluvix/${slug}-rag:latest`;
      }
    }

    const effectiveSelinux =
      ramalamaRaw.selinuxEnforcing ??
      (node.data as any)?.selinuxEnforcing ??
      (connectedAirgapSandbox || connectedToEnclave ? true : undefined);
    const effectiveNetIsolation =
      ramalamaRaw.networkIsolation ||
      (node.data as any)?.networkIsolation ||
      (connectedAirgapSandbox || connectedToEnclave ? 'none' : undefined);
    const effectiveReadOnly =
      ramalamaRaw.readOnlyRootfs ??
      (node.data as any)?.readOnlyRootfs ??
      (connectedAirgapSandbox || connectedToEnclave ? true : undefined);
    const effectiveTemp =
      ramalamaRaw.tempContainer ?? (node.data as any)?.tempContainer;
    const effectiveGenerateMode =
      ramalamaRaw.generateMode || (node.data as any)?.generateMode;

    const ramalamaCfg =
      type === 'ramalama'
        ? {
            containerEngine: ramalamaRaw.containerEngine || (node.data as any)?.containerEngine || 'podman',
            runtime: ramalamaRaw.runtime || (node.data as any)?.runtime || 'llama.cpp',
            ociTransport: ramalamaRaw.ociTransport || (node.data as any)?.ociTransport || 'oci',
            accelerator: ramalamaRaw.accelerator || (node.data as any)?.accelerator || 'auto',
            ...(typeof effectiveSelinux === 'boolean'
              ? { selinuxEnforcing: Boolean(effectiveSelinux) }
              : {}),
            ...(effectiveNetIsolation ? { networkIsolation: effectiveNetIsolation } : {}),
            ...(typeof effectiveReadOnly === 'boolean'
              ? { readOnlyRootfs: Boolean(effectiveReadOnly) }
              : {}),
            ...(typeof effectiveTemp === 'boolean'
              ? { tempContainer: Boolean(effectiveTemp) }
              : {}),
            ...(resolvedRagOciUri ? { ragOciUri: resolvedRagOciUri } : {}),
            ...(effectiveGenerateMode ? { generateMode: effectiveGenerateMode } : {}),
            ...(typeof (ramalamaRaw.ctxSize ?? (node.data as any)?.ctxSize) === 'number'
              ? { ctxSize: Number(ramalamaRaw.ctxSize ?? (node.data as any)?.ctxSize) }
              : {}),
            ...(typeof (ramalamaRaw.ngl ?? (node.data as any)?.ngl) === 'number'
              ? { ngl: Number(ramalamaRaw.ngl ?? (node.data as any)?.ngl) }
              : {}),
          }
        : undefined;

    const comfyRaw = (node.data as any)?.comfyui || {};
    const connectedLlmEnhancer =
      type === 'comfyui'
        ? localEngines.find(
            other =>
              other.id !== node.id &&
              other.type !== 'comfyuiNode' &&
              other.type !== 'audioVoiceNode' &&
              edges.some(
                e =>
                  (e.source === other.id && e.target === node.id) ||
                  (e.target === other.id && e.source === node.id)
              )
          )
        : undefined;
    const connectedArtCraftForComfy =
      type === 'comfyui' ? findConnectedArtCraftNode(node) : undefined;
    const hasCoHostedLocalLlm =
      type === 'comfyui' &&
      localEngines.some(
        other => other.id !== node.id && other.type !== 'comfyuiNode' && other.type !== 'audioVoiceNode'
      );

    const comfyuiCfg: ComfyUIConfig | undefined =
      type === 'comfyui'
        ? {
            workflowPreset:
              comfyRaw.workflowPreset || (node.data as any)?.workflowPreset || 'flux-txt2img',
            ...(comfyRaw.checkpoint || (node.data?.selectedModel && node.data.selectedModel !== '*')
              ? { checkpoint: String(comfyRaw.checkpoint || node.data.selectedModel) }
              : {}),
            steps: Number(comfyRaw.steps ?? (node.data as any)?.steps ?? 20),
            cfg: Number(comfyRaw.cfg ?? (node.data as any)?.cfg ?? 3.5),
            samplerName: String(comfyRaw.samplerName || (node.data as any)?.samplerName || 'euler'),
            scheduler: String(comfyRaw.scheduler || (node.data as any)?.scheduler || 'simple'),
            width: Number(comfyRaw.width ?? (node.data as any)?.width ?? 1024),
            height: Number(comfyRaw.height ?? (node.data as any)?.height ?? 1024),
            vramMode:
              comfyRaw.vramMode ||
              (node.data as any)?.vramMode ||
              (hasCoHostedLocalLlm ? 'lowvram' : 'normalvram'),
            reserveVramGb: Number(
              comfyRaw.reserveVramGb ?? (node.data as any)?.reserveVramGb ?? (hasCoHostedLocalLlm ? 6 : 4)
            ),
            ...(comfyRaw.promptEnhancerUpstreamId || connectedLlmEnhancer?.id
              ? {
                  promptEnhancerUpstreamId: String(
                    comfyRaw.promptEnhancerUpstreamId || connectedLlmEnhancer?.id
                  )
                }
              : {}),
            ...(comfyRaw.postProcessArtCraftApp || connectedArtCraftForComfy
              ? {
                  postProcessArtCraftApp: String(
                    comfyRaw.postProcessArtCraftApp ||
                      (connectedArtCraftForComfy?.data as any)?.app ||
                      'vectorcraft'
                  )
                }
              : {}),
            loopbackEluvixUrl: String(
              comfyRaw.loopbackEluvixUrl ||
                (node.data as any)?.loopbackEluvixUrl ||
                'http://127.0.0.1:3588/v1'
            ),
            mcpEnabled: comfyRaw.mcpEnabled !== false
          }
        : undefined;

    const audioCfg: AudioVoiceConfig | undefined =
      type === 'audio'
        ? {
            mode: audioRaw.mode || 'both',
            sttBackend: audioRaw.sttBackend || audioRaw.sttPreset || 'speaches',
            ttsBackend: audioRaw.ttsBackend || audioRaw.ttsPreset || 'kokoro',
            ...(audioRaw.defaultSttModel || audioRaw.sttModel
              ? { defaultSttModel: String(audioRaw.defaultSttModel || audioRaw.sttModel) }
              : {}),
            ...(audioRaw.defaultTtsModel || audioRaw.ttsModel
              ? { defaultTtsModel: String(audioRaw.defaultTtsModel || audioRaw.ttsModel) }
              : {}),
            defaultVoice: String(audioRaw.defaultVoice || 'af_heart'),
            responseFormat: audioRaw.responseFormat || 'mp3',
            ttsEndpoint: String(audioRaw.ttsEndpoint || 'http://localhost:8880'),
            scrubTranscriptPii: audioRaw.scrubTranscriptPii !== false,
          }
        : undefined;

    upstreams.push({
      id: String(node.id),
      name: String(node.data?.label || defaultName),
      type,
      endpoint: String(node.data?.endpoint || defaultEndpoint),
      priority: Number(node.data?.priority || (type === 'lemonade' ? 25 : type === 'sglang' ? 24 : type === 'vllm' ? 22 : type === 'comfyui' ? 22 : type === 'ramalama' ? 21 : 20)),
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
      ...(fabricConfig ? { fabric: fabricConfig } : {}),
      ...(attentionKernelConfig ? { attentionKernel: attentionKernelConfig } : {}),
      ...(crsCfg ? { crs: crsCfg } : {}),
      ...(vcCfg ? { vectorcraft: vcCfg } : {}),
      ...(acCfg ? { artcraft: acCfg } : {}),
      ...(ramalamaCfg ? { ramalama: ramalamaCfg } : {}),
      ...(comfyuiCfg ? { comfyui: comfyuiCfg } : {}),
      ...(audioCfg ? { audio: audioCfg } : {})
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
      'gemini-4-carbon',
      'gemini-4-argon',
      'gemini-3.8-flash',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'gpt-oss-120b',
      '*'
    ]));

    const agyCrs = buildCrsCfgForNode(node);
    const agyVc = buildVectorCraftCfgForNode(node);
    const agyAc = buildArtCraftCfgForNode(node);
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
      ...(agyCrs ? { crs: agyCrs } : {}),
      ...(agyVc ? { vectorcraft: agyVc } : {}),
      ...(agyAc ? { artcraft: agyAc } : {}),
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

    const codexCrs = buildCrsCfgForNode(node);
    const codexVc = buildVectorCraftCfgForNode(node);
    const codexAc = buildArtCraftCfgForNode(node);
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
      ...(codexCrs ? { crs: codexCrs } : {}),
      ...(codexVc ? { vectorcraft: codexVc } : {}),
      ...(codexAc ? { artcraft: codexAc } : {}),
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

    const claudeCodeCrs = buildCrsCfgForNode(node);
    const claudeCodeVc = buildVectorCraftCfgForNode(node);
    const claudeCodeAc = buildArtCraftCfgForNode(node);
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
      ...(claudeCodeCrs ? { crs: claudeCodeCrs } : {}),
      ...(claudeCodeVc ? { vectorcraft: claudeCodeVc } : {}),
      ...(claudeCodeAc ? { artcraft: claudeCodeAc } : {}),
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

    const harnessCrs = buildCrsCfgForNode(node);
    const harnessVc = buildVectorCraftCfgForNode(node);
    const harnessAc = buildArtCraftCfgForNode(node);

    // Discover MCP tools connected directly to this harness or via a connected AgentGateway
    const connectedMcpToolNodes = mcpTools.filter(tool => {
      const direct = edges.some(
        e => (e.source === tool.id && e.target === node.id) || (e.target === tool.id && e.source === node.id)
      );
      if (direct) return true;
      const viaGateway =
        edges.some(
          e =>
            (e.source === tool.id && agentGateways.some(g => g.id === e.target)) ||
            (e.target === tool.id && agentGateways.some(g => g.id === e.source))
        ) &&
        edges.some(
          e =>
            (agentGateways.some(g => g.id === e.source) && e.target === node.id) ||
            (agentGateways.some(g => g.id === e.target) && e.source === node.id)
        );
      return viaGateway;
    });

    const mcpServers: any[] = [];
    for (const tool of connectedMcpToolNodes) {
      const endpoint = String(tool.data?.mcpEndpoint || 'http://localhost:8003/mcp');
      mcpServers.push({
        name: String(tool.data?.toolName || tool.id),
        endpoint,
        transport: endpoint.startsWith('stdio://') ? 'stdio' : 'http'
      });
    }
    if (harnessAc) {
      for (const acServer of toArtCraftHarnessMcpServers(harnessAc)) {
        if (!mcpServers.some(s => s.name === acServer.name)) {
          mcpServers.push(acServer);
        }
      }
    } else if (harnessVc) {
      mcpServers.push(toHarnessMcpServerConfig(harnessVc));
    }

    // Pillar 3: Expose connected ComfyUINode instances as comfyui-mcp servers to agent harnesses
    const connectedComfyNodes = localEngines.filter(
      eng =>
        eng.type === 'comfyuiNode' &&
        (eng.data as any)?.comfyui?.mcpEnabled !== false &&
        edges.some(
          e =>
            (e.source === eng.id && e.target === node.id) ||
            (e.target === eng.id && e.source === node.id)
        )
    );
    for (const cNode of connectedComfyNodes) {
      const cEndpoint = String(cNode.data?.endpoint || 'http://localhost:8188');
      const cMcp = toComfyMcpServerConfig(cNode.id, cEndpoint, (cNode.data as any)?.comfyui);
      if (!mcpServers.some(s => s.name === cMcp.name)) {
        mcpServers.push(cMcp);
      }
    }

    const baseApproveTools = Array.isArray(node.data?.autoApproveTools)
      ? node.data.autoApproveTools.map((t: any) => String(t))
      : [];
    const vcApproveTools = harnessAc
      ? resolveArtCraftAutoApproveTools(harnessAc)
      : harnessVc
        ? resolveVectorCraftAutoApproveTools(harnessVc)
        : [];
    const mergedApproveTools = Array.from(new Set([...baseApproveTools, ...vcApproveTools]));

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
      ...(harnessCrs ? { crs: harnessCrs } : {}),
      ...(harnessVc ? { vectorcraft: harnessVc } : {}),
      ...(harnessAc ? { artcraft: harnessAc } : {}),
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
        ...(mergedApproveTools.length > 0
          ? { autoApproveTools: mergedApproveTools }
          : {}),
        ...(mcpServers.length > 0 ? { mcpServers } : {}),
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
  const resolvedCrsPolicy =
    swData.crsPolicy && swData.crsPolicy !== 'disabled'
      ? String(swData.crsPolicy)
      : crsNodeData.crsPolicy && crsNodeData.crsPolicy !== 'disabled'
      ? String(crsNodeData.crsPolicy)
      : undefined;
  const resolvedAttentionPolicy =
    swData.attentionPolicy && swData.attentionPolicy !== 'disabled'
      ? String(swData.attentionPolicy)
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
    ...(swData.strictModelMatch === true ? { strictModelMatch: true } : {}),
    ...(swData.mediaIntentRouting !== undefined ? { mediaIntentRouting: Boolean(swData.mediaIntentRouting) } : {}),
    ...(resolvedConfidentialPolicy ? { confidentialPolicy: resolvedConfidentialPolicy } : {}),
    ...(resolvedQuantizationPolicy ? { quantizationPolicy: resolvedQuantizationPolicy } : {}),
    ...(resolvedFabricPolicy ? { fabricPolicy: resolvedFabricPolicy } : {}),
    ...(resolvedCrsPolicy ? { crsPolicy: resolvedCrsPolicy } : {}),
    ...(resolvedAttentionPolicy ? { attentionPolicy: resolvedAttentionPolicy } : {}),
    complexityThresholds: {
      moderate: Number(thresholds.moderate ?? 300),
      heavy: Number(thresholds.heavy ?? 1500),
      frontier: Number(thresholds.frontier ?? 6000),
    },
    maxCostPerRequest: swData.maxCostPerRequest !== undefined ? Number(swData.maxCostPerRequest) : 0.05,
    ...(swData.maxDailySpendUsd !== undefined && Number(swData.maxDailySpendUsd) > 0
      ? {
          maxDailySpendUsd: Number(swData.maxDailySpendUsd),
          budgetExhaustedAction: (swData.budgetExhaustedAction || 'prefer-local') as
            | 'prefer-local'
            | 'strict-local'
            | 'reject',
        }
      : {})
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

  const primaryCascadeNode = speculativeCascadeNodes[0];
  let cascadeConfig: SpeculativeCascadeConfig | undefined;
  if (primaryCascadeNode) {
    const casData = (primaryCascadeNode.data || {}) as Record<string, any>;
    const draftEdge = edges.find(
      e => e.source === primaryCascadeNode.id && e.sourceHandle === 'draft'
    );
    const verifierEdge = edges.find(
      e => e.source === primaryCascadeNode.id && e.sourceHandle === 'verifier'
    );
    const shadowEdge = edges.find(
      e => e.source === primaryCascadeNode.id && e.sourceHandle === 'shadow-student'
    );
    const fallbackOutEdges = edges.filter(
      e => e.source === primaryCascadeNode.id && !e.sourceHandle
    );

    const draftUpstreamId =
      draftEdge?.target || casData.draftUpstreamId || fallbackOutEdges[0]?.target;
    const verifierUpstreamId =
      verifierEdge?.target || casData.verifierUpstreamId || fallbackOutEdges[1]?.target;
    const shadowStudentUpstreamId =
      shadowEdge?.target || casData.shadowStudentUpstreamId || undefined;

    cascadeConfig = {
      id: String(primaryCascadeNode.id),
      enabled: casData.enabled !== false,
      ...(draftUpstreamId ? { draftUpstreamId: String(draftUpstreamId) } : {}),
      ...(verifierUpstreamId ? { verifierUpstreamId: String(verifierUpstreamId) } : {}),
      ...(shadowStudentUpstreamId
        ? { shadowStudentUpstreamId: String(shadowStudentUpstreamId) }
        : {}),
      confidenceThreshold: Number(casData.confidenceThreshold ?? 0.78),
      maxDraftLatencyMs: Number(casData.maxDraftLatencyMs ?? 2500),
      validateJsonSchema: casData.validateJsonSchema !== false,
      validateCodeFences: casData.validateCodeFences !== false,
      shadowSampleRate: Number(casData.shadowSampleRate ?? 0.05),
    };
  }

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
    ...(resolvedCrsPolicy ? { crsPolicy: resolvedCrsPolicy } : {}),
    ...(resolvedAttentionPolicy ? { attentionPolicy: resolvedAttentionPolicy } : {}),
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
    ...(cascadeConfig ? { cascade: cascadeConfig } : {}),
    ...(primaryVcConfig ? { vectorcraft: primaryVcConfig } : {}),
    ...(primaryAcConfig ? { artcraft: primaryAcConfig } : {}),
    ...(pgNode && (pgData.outputGuardEnabled === true || pgData.outputGuard?.enabled === true)
      ? {
          outputGuard: {
            enabled: true,
            action: (pgData.outputGuard?.action || pgData.outputGuardAction || 'redact') as
              | 'redact'
              | 'block'
              | 'audit',
            detectSecrets: pgData.outputGuard?.detectSecrets !== false,
            ...(Array.isArray(pgData.outputGuard?.blockedRegexes)
              ? { blockedRegexes: pgData.outputGuard.blockedRegexes }
              : {}),
            redactionStyle: (pgData.redactionStyle || 'token') as 'mask' | 'token' | 'hash',
          },
        }
      : {}),
    ...(observabilityNodes.length > 0 &&
    ((observabilityNodes[0].data as any)?.exporter === 'otlp' ||
      (observabilityNodes[0].data as any)?.exporter === 'langfuse' ||
      Boolean((observabilityNodes[0].data as any)?.otlpEndpoint))
      ? {
          observability: {
            enabled: true,
            projectName: String((observabilityNodes[0].data as any)?.projectName || 'eluvix-desktop'),
            exporter: String((observabilityNodes[0].data as any)?.exporter || 'otlp') as
              | 'sqlite'
              | 'otlp'
              | 'langfuse'
              | 'prometheus',
            ...((observabilityNodes[0].data as any)?.otlpEndpoint
              ? { otlpEndpoint: String((observabilityNodes[0].data as any).otlpEndpoint) }
              : {}),
            samplingRate: Number((observabilityNodes[0].data as any)?.samplingRate ?? 100),
            captureInputs: (observabilityNodes[0].data as any)?.captureInputs !== false,
            scrubPii: (observabilityNodes[0].data as any)?.scrubPii !== false,
          },
        }
      : {}),
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
      : node.type === 'ramalamaNode'
      ? 'ramalama'
      : node.type === 'comfyuiNode'
      ? 'comfyui'
      : node.type === 'audioVoiceNode'
      ? 'audio'
      : 'ollama';
    const endpoint = data.endpoint || (
      type === 'lemonade' ? 'http://localhost:13305' :
      type === 'vllm' ? 'http://localhost:8000' :
      type === 'sglang' ? 'http://localhost:30000' :
      type === 'ramalama' ? 'http://localhost:8080' :
      type === 'comfyui' ? 'http://localhost:8188' :
      type === 'audio' ? 'http://localhost:8005' :
      'http://localhost:11434'
    );
    const selected = data.selectedModel || '*';
    yaml += `  - id: ${node.id}\n`;
    yaml += `    type: ${type}\n`;
    yaml += `    api_base: ${endpoint}\n`;
    yaml += `    selected_model: "${selected}"\n`;
    yaml += `    priority: ${data.priority || 20}\n`;
    if (type === 'ramalama') {
      const rCfg = (data.ramalama || {}) as Record<string, any>;
      yaml += `    container_engine: ${rCfg.containerEngine || data.containerEngine || 'podman'}\n`;
      yaml += `    runtime: ${rCfg.runtime || data.runtime || 'llama.cpp'}\n`;
      yaml += `    oci_transport: ${rCfg.ociTransport || data.ociTransport || 'oci'}\n`;
      yaml += `    accelerator: ${rCfg.accelerator || data.accelerator || 'auto'}\n`;
    }
    if (type === 'comfyui') {
      const cCfg = (data.comfyui || {}) as Record<string, any>;
      yaml += `    workflow_preset: ${cCfg.workflowPreset || 'flux-txt2img'}\n`;
      yaml += `    vram_mode: ${cCfg.vramMode || 'normalvram'}\n`;
    }
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

function generateAgentGatewayJson(
  nodes: Node[],
  mcpTools: Node[],
  edges: Edge[],
  vectorcraftNodes: Node[] = []
): string {
  if (nodes.length === 0) return '{}';

  const gateways = nodes.map(node => {
    const data = (node.data || {}) as Record<string, any>;
    // Find MCP tools connected to this gateway
    const toolEdges = edges.filter(te => te.target === node.id || te.source === node.id);
    const gatewayTools: any[] = toolEdges
      .map(te => {
        const otherId = te.source === node.id ? te.target : te.source;
        const tool = mcpTools.find(t => t.id === otherId);
        if (tool) {
          return {
            name: tool.data?.toolName,
            endpoint: tool.data?.mcpEndpoint,
            executionMode: tool.data?.executionMode || 'auto',
            timeoutMs: tool.data?.timeoutMs ?? 15000
          };
        }
        const vc = vectorcraftNodes.find(v => v.id === otherId);
        if (vc) {
          const vcData = (vc.data || {}) as Record<string, any>;
          const rawApps = vcData.enabledApps || vcData.apps;
          const appList: ArtCraftAppId[] =
            Array.isArray(rawApps) && rawApps.length > 0
              ? (rawApps.filter((a: any) => Boolean(ARTCRAFT_APPS_CATALOG[a as ArtCraftAppId])) as ArtCraftAppId[])
              : [
                  vcData.app && ARTCRAFT_APPS_CATALOG[vcData.app as ArtCraftAppId]
                    ? (vcData.app as ArtCraftAppId)
                    : 'vectorcraft'
                ];
          return appList.map(appId => {
            const spec = ARTCRAFT_APPS_CATALOG[appId];
            const built = buildArtCraftCliArgs({
              app: appId,
              cliCommand: appList.length === 1 ? String(vcData.cliCommand || spec.cliBinary) : spec.cliBinary,
              backendMode: (vcData.backendMode || 'auto') as any,
              controlAddress:
                appList.length === 1
                  ? String(vcData.controlAddress || `127.0.0.1:${spec.defaultControlPort ?? 7979}`)
                  : undefined,
              readRoots: Array.isArray(vcData.readRoots) ? vcData.readRoots.map((r: any) => String(r)) : undefined,
              writeRoots: Array.isArray(vcData.writeRoots) ? vcData.writeRoots.map((w: any) => String(w)) : undefined
            });
            return {
              name: appId,
              endpoint: `stdio://${built.cliCommand} ${built.mcpArgs.join(' ')}`,
              executionMode: 'auto',
              timeoutMs: 30000
            };
          });
        }
        return null;
      })
      .flat()
      .filter(Boolean);

    // Deduplicate tools in case of bidirectional or multiple edges
    const dedupedTools = Array.from(
      new Map(gatewayTools.map(t => [t.name, t])).values()
    );

    if (data.enableNativeTools !== false) {
      dedupedTools.push({ name: 'native_tools', endpoint: 'local:///api/v1/tools', executionMode: 'auto', timeoutMs: 10000 });
    }

    return {
      id: node.id,
      accessPolicy: data.accessPolicy || 'restrictive',
      toolFilterMode: data.toolFilterMode || 'all',
      toolTimeoutMs: Number(data.toolTimeoutMs ?? 10000),
      sanitizeToolOutput: data.sanitizeToolOutput !== false,
      protocols: ['mcp', 'a2a'],
      mcpTools: dedupedTools.length > 0 ? dedupedTools : undefined
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

function generateClaudeCodeSetup(
  nodes: Node[],
  edges: Edge[],
  vectorcraftNodes: Node[] = []
): string {
  if (nodes.length === 0) return '';
  
  let setup = '# ==============================================================================\n';
  setup += '# Claude Code CLI & Agent Orchestration Setup\n';
  setup += '# Generated by Eluvix Visual Routing Editor\n';
  setup += '# ==============================================================================\n\n';

  const vcSourceData = (
    vectorcraftNodes[0]?.data ||
    nodes.find(n => (n.data as any)?.artcraft?.enabled || (n.data as any)?.vectorcraft?.enabled)?.data?.artcraft ||
    nodes.find(n => (n.data as any)?.artcraft?.enabled || (n.data as any)?.vectorcraft?.enabled)?.data?.vectorcraft ||
    null
  ) as Record<string, any> | null;

  if (vcSourceData) {
    const rawApps = vcSourceData.enabledApps || vcSourceData.apps;
    const appList: ArtCraftAppId[] =
      Array.isArray(rawApps) && rawApps.length > 0
        ? (rawApps.filter((a: any) => Boolean(ARTCRAFT_APPS_CATALOG[a as ArtCraftAppId])) as ArtCraftAppId[])
        : [
            vcSourceData.app && ARTCRAFT_APPS_CATALOG[vcSourceData.app as ArtCraftAppId]
              ? (vcSourceData.app as ArtCraftAppId)
              : 'vectorcraft'
          ];
    setup += `# ArtCraft Creative & Technical Suite MCP Server Registration:\n`;
    for (const appId of appList) {
      const spec = ARTCRAFT_APPS_CATALOG[appId] || ARTCRAFT_APPS_CATALOG.vectorcraft;
      const isSingle = appList.length === 1;
      const built = buildArtCraftCliArgs({
        app: appId,
        cliCommand: isSingle && vcSourceData.cliCommand ? String(vcSourceData.cliCommand) : spec.cliBinary,
        backendMode: (vcSourceData.backendMode || 'auto') as any,
        controlAddress:
          isSingle && vcSourceData.controlAddress
            ? String(vcSourceData.controlAddress)
            : `127.0.0.1:${spec.defaultControlPort ?? 7979}`,
        readRoots: Array.isArray(vcSourceData.readRoots) ? vcSourceData.readRoots.map((r: any) => String(r)) : undefined,
        writeRoots: Array.isArray(vcSourceData.writeRoots) ? vcSourceData.writeRoots.map((w: any) => String(w)) : undefined
      });
      setup += `# $ claude mcp add ${appId} -- ${built.cliCommand} ${built.mcpArgs.join(' ')}\n`;
    }
    setup += `\n`;
  }

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

      const attnCfg = (node.data as any)?.attentionKernel;
      if (attnCfg && attnCfg.enabled !== false) {
        parts.push(
          generateFlashAttentionKernelLaunchScript(
            String(node.id),
            'sglang',
            String(rawModel),
            attnCfg
          )
        );
        parts.push('');
      }
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

      const attnCfg = (node.data as any)?.attentionKernel;
      if (attnCfg && attnCfg.enabled !== false) {
        parts.push(
          generateFlashAttentionKernelLaunchScript(
            String(node.id),
            'vllm',
            String(rawModel),
            attnCfg
          )
        );
        parts.push('');
      }
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

function generateCrsSetup(
  crsNodes: Node[],
  localEngines: Node[]
): string {
  const crsNode = crsNodes[0];
  const crsEngines = localEngines.filter((n) => (n.data as any)?.crs?.enabled);

  if (!crsNode && crsEngines.length === 0) {
    return '# No Neuro-Symbolic CRS node or CRS-enabled verifier configured on canvas.';
  }

  const cData = (crsNode?.data || {}) as Record<string, any>;
  const eCrs = (crsEngines[0]?.data as any)?.crs || {};
  const nodeId = String(crsNode?.id || crsEngines[0]?.id || 'crs-verifier');

  return generateCrsVerificationScript(nodeId, {
    enabled: true,
    policy: (cData.crsPolicy || eCrs.policy || 'slice-and-verify') as any,
    slicerMode: (cData.slicerMode || eCrs.slicerMode || 'backward-def-use') as any,
    sanitizerArch: (cData.sanitizerArch || eCrs.sanitizerArch || 'asan-x86_64') as any,
    targetSink: String(cData.targetSink || eCrs.targetSink || 'memcpy'),
    stallThresholdSeconds: Number(cData.stallThresholdSeconds ?? eCrs.stallThresholdSeconds ?? 300),
    defaultBitWidth: (Number(cData.defaultBitWidth ?? eCrs.defaultBitWidth ?? 16) as 8 | 16 | 32 | 64)
  });
}

function generateVectorCraftSetup(
  vectorcraftNodes: Node[],
  localEngines: Node[]
): string {
  const vcNode = vectorcraftNodes[0];
  const vcEngines = localEngines.filter((n) => (n.data as any)?.vectorcraft?.enabled || (n.data as any)?.artcraft?.enabled);

  if (!vcNode && vcEngines.length === 0) {
    return '# No VectorCraft / ArtCraft MCP node configured on canvas.';
  }

  const vData = (
    vcNode?.data ||
    (vcEngines[0]?.data as any)?.artcraft ||
    (vcEngines[0]?.data as any)?.vectorcraft ||
    {}
  ) as Record<string, any>;
  const nodeId = String(vcNode?.id || vcEngines[0]?.id || 'vectorcraft-mcp');
  const readRoots = Array.isArray(vData.readRoots)
    ? vData.readRoots.map((r: any) => String(r).trim()).filter(Boolean)
    : vData.readRoot
      ? [String(vData.readRoot).trim()].filter(Boolean)
      : [];
  const writeRoots = Array.isArray(vData.writeRoots)
    ? vData.writeRoots.map((w: any) => String(w).trim()).filter(Boolean)
    : vData.writeRoot
      ? [String(vData.writeRoot).trim()].filter(Boolean)
      : [];

  const rawApps = vData.enabledApps || vData.apps;
  const isMultiOrOtherApp =
    vcNode?.type === 'artcraftNode' ||
    (vData.app && vData.app !== 'vectorcraft') ||
    (Array.isArray(rawApps) && (rawApps.length > 1 || (rawApps.length === 1 && rawApps[0] !== 'vectorcraft')));

  if (isMultiOrOtherApp) {
    return generateArtCraftSetupScript(nodeId, {
      enabled: true,
      app: (vData.app || 'vectorcraft') as ArtCraftAppId,
      enabledApps: Array.isArray(rawApps) ? (rawApps as ArtCraftAppId[]) : undefined,
      cliCommand: vData.cliCommand ? String(vData.cliCommand) : undefined,
      backendMode: (vData.backendMode || 'auto') as any,
      controlAddress: vData.controlAddress ? String(vData.controlAddress) : undefined,
      readRoots,
      writeRoots
    });
  }

  return generateVectorCraftSetupScript(nodeId, {
    enabled: true,
    cliCommand: String(vData.cliCommand || 'vectorcraft-cli'),
    backendMode: (vData.backendMode || 'auto') as any,
    controlAddress: String(vData.controlAddress || '127.0.0.1:7979'),
    defaultPromptWorkflow: (vData.defaultPromptWorkflow || 'poster') as any,
    autoApproveTier: (vData.autoApproveTier || 'canvas-draw') as any,
    defaultExportFormat: (vData.defaultExportFormat || 'svg') as any,
    readRoots,
    writeRoots
  });
}

function generateRamalamaSetup(
  ramalamaNodes: Node[],
  edges: Edge[] = [],
  knowledgeBaseNodes: Node[] = [],
  sandboxNodes: Node[] = [],
  confidentialEnclaveNodes: Node[] = []
): string {
  if (ramalamaNodes.length === 0) {
    return '# No RamaLama OCI Engine node configured on canvas.';
  }

  const sections: string[] = [
    '#!/usr/bin/env bash',
    '# ============================================================================',
    '# Eluvix — RamaLama (containers/ramalama) OCI Container & Podman Quadlet Setup',
    '# Rootless Podman / Docker OCI Model Serving, RAG Artifacts & SELinux Hardening',
    '# ============================================================================',
    'set -euo pipefail',
    ''
  ];

  ramalamaNodes.forEach((node, idx) => {
    const data = (node.data || {}) as Record<string, any>;
    const rRaw = (data.ramalama || {}) as Record<string, any>;
    const safeId = sanitizeSafeIdentifier(String(node.id || `ramalama-${idx + 1}`), `ramalama-${idx + 1}`);
    const label = String(data.label || 'RamaLama Engine');
    const endpoint = String(data.endpoint || 'http://localhost:8080');
    let port = 8080;
    try {
      const u = new URL(endpoint);
      if (u.port) port = sanitizePositiveInt(u.port, 8080, 1, 65535);
    } catch {}

    const engine = sanitizeSafeIdentifier(
      String(rRaw.containerEngine || data.containerEngine || 'podman'),
      'podman'
    );
    const runtime = String(rRaw.runtime || data.runtime || 'llama.cpp');
    const safeRuntime = runtime === 'vllm' || runtime === 'mlx' ? runtime : 'llama.cpp';
    const transport = sanitizeSafeIdentifier(
      String(rRaw.ociTransport || data.ociTransport || 'oci'),
      'oci'
    );
    const accel = sanitizeSafeIdentifier(
      String(rRaw.accelerator || data.accelerator || 'auto'),
      'auto'
    );

    const connectedKb = knowledgeBaseNodes.find(kb =>
      edges.some(
        e =>
          (e.source === kb.id && e.target === node.id) ||
          (e.target === kb.id && e.source === node.id)
      )
    );
    const connectedAirgap =
      sandboxNodes.some(sb =>
        edges.some(
          e =>
            (e.source === sb.id && e.target === node.id) ||
            (e.target === sb.id && e.source === node.id)
        )
      ) ||
      confidentialEnclaveNodes.some(ce =>
        edges.some(
          e =>
            (e.source === ce.id && e.target === node.id) ||
            (e.target === ce.id && e.source === node.id)
        )
      );

    const selinux = Boolean(rRaw.selinuxEnforcing ?? data.selinuxEnforcing ?? true);
    const netIsolation = String(
      rRaw.networkIsolation || data.networkIsolation || (connectedAirgap ? 'none' : 'bridge')
    );
    const tempContainer = Boolean(rRaw.tempContainer ?? data.tempContainer ?? false);
    const generateMode = String(rRaw.generateMode || data.generateMode || 'quadlet');

    let ragUri = String(rRaw.ragOciUri || data.ragOciUri || '').trim();
    if (!ragUri && connectedKb) {
      const kbUri = String((connectedKb.data as any)?.collectionUri || '').trim();
      if (kbUri.startsWith('oci://')) {
        ragUri = kbUri;
      } else {
        const slug = sanitizeSafeIdentifier(
          kbUri.replace(/^[a-z0-9+.-]+:\/\/(?:resources\/)?/i, '') || 'docs',
          'docs'
        ).toLowerCase();
        ragUri = `oci://quay.io/eluvix/${slug}-rag:latest`;
      }
    }

    const rawModel = String(data.selectedModel && data.selectedModel !== '*' ? data.selectedModel : 'llama3.2:3b');
    const modelTarget = rawModel.includes('://') ? rawModel : `${transport}://${rawModel}`;
    const imageTag =
      accel === 'cuda'
        ? 'quay.io/ramalama/cuda:latest'
        : accel === 'rocm'
        ? 'quay.io/ramalama/rocm:latest'
        : accel === 'vulkan'
        ? 'quay.io/ramalama/vulkan:latest'
        : accel === 'intel'
        ? 'quay.io/ramalama/intel-gpu:latest'
        : 'quay.io/ramalama/ramalama:latest';

    sections.push(`# --- Node [${safeId}]: ${label} (:${port}) ---`);

    if (ragUri) {
      sections.push(
        `# 1. Build & package OCI RAG Vector Database Artifact (--rag)`,
        `# ramalama rag ./docs ${escapeShellArg(ragUri)}`,
        ''
      );
    }

    const cmdParts: string[] = ['ramalama'];
    if (engine === 'nocontainer') {
      cmdParts.push('--nocontainer');
    } else {
      cmdParts.push('--engine', escapeShellArg(engine));
    }
    if (safeRuntime !== 'llama.cpp') {
      cmdParts.push('--runtime', escapeShellArg(safeRuntime));
    }
    if (accel !== 'auto') {
      cmdParts.push('--image', escapeShellArg(imageTag));
    }
    if (engine !== 'nocontainer' && selinux) {
      cmdParts.push('--selinux=true');
    }
    cmdParts.push('serve');
    if (engine !== 'nocontainer' && netIsolation === 'none') {
      cmdParts.push('--network=none');
    }
    if (tempContainer) {
      cmdParts.push('--temp');
    }
    if (ragUri) {
      cmdParts.push('--rag', escapeShellArg(ragUri));
    }
    if (generateMode && generateMode !== 'none') {
      cmdParts.push(`--generate=${escapeShellArg(generateMode)}`);
    }
    cmdParts.push('--port', String(port), '--host', '0.0.0.0', escapeShellArg(modelTarget));

    sections.push(`# Launch Command (${generateMode !== 'none' ? `Generator: ${generateMode}` : 'Direct'}):`);
    sections.push(cmdParts.join(' '));
    sections.push('');

    // Synthesize Rootless Podman Quadlet (.container) Unit
    const unitName = `eluvix-${safeId}`;
    sections.push(`# Rootless Systemd Quadlet: ~/.config/containers/systemd/${unitName}.container`);
    sections.push(`cat << 'EOF' > "\${HOME}/.config/containers/systemd/${unitName}.container"`);
    sections.push(`[Unit]`);
    sections.push(`Description=Eluvix RamaLama OCI Inference Service (${safeId})`);
    sections.push(`After=network-online.target`);
    sections.push(``);
    sections.push(`[Container]`);
    sections.push(`Image=${imageTag}`);
    sections.push(`ContainerName=${unitName}`);
    sections.push(`PublishPort=${port}:8080`);
    sections.push(`AddDevice=/dev/dri`);
    if (accel === 'rocm' || accel === 'auto') {
      sections.push(`AddDevice=/dev/kfd`);
    }
    if (selinux) {
      sections.push(`SecurityLabelType=container_engine_t`);
    }
    if (netIsolation === 'none') {
      sections.push(`Network=none`);
    }
    sections.push(`ReadOnly=true`);
    sections.push(`Exec=ramalama serve --port 8080 --host 0.0.0.0 ${ragUri ? `--rag ${ragUri} ` : ''}${modelTarget}`);
    sections.push(``);
    sections.push(`[Install]`);
    sections.push(`WantedBy=default.target`);
    sections.push(`EOF`);
    sections.push(`# systemctl --user daemon-reload && systemctl --user enable --now ${unitName}.service`);
    sections.push('');
  });

  return sections.join('\n');
}

function generateComfyUISetup(
  comfyuiNodes: Node[],
  localEngineNodes: Node[],
  vectorcraftNodes: Node[],
  edges: Edge[]
): string {
  if (comfyuiNodes.length === 0) return '';

  const sections: string[] = [];
  comfyuiNodes.forEach(node => {
    const data = (node.data || {}) as Record<string, any>;
    const cCfg = (data.comfyui || {}) as ComfyUIConfig;
    const endpoint = String(data.endpoint || 'http://localhost:8188');

    const connectedLlm = localEngineNodes.find(
      other =>
        other.id !== node.id &&
        other.type !== 'comfyuiNode' &&
        edges.some(
          e =>
            (e.source === other.id && e.target === node.id) ||
            (e.target === other.id && e.source === node.id)
        )
    );
    const connectedAc = vectorcraftNodes.find(vc =>
      edges.some(
        e =>
          (e.source === vc.id && e.target === node.id) ||
          (e.target === vc.id && e.source === node.id)
      )
    );
    const hasCoHostedLlm = localEngineNodes.some(
      other => other.id !== node.id && other.type !== 'comfyuiNode'
    );

    const mergedConfig: ComfyUIConfig = {
      ...cCfg,
      checkpoint:
        cCfg.checkpoint ||
        (data.selectedModel && data.selectedModel !== '*' ? String(data.selectedModel) : undefined),
      vramMode: cCfg.vramMode || (hasCoHostedLlm ? 'lowvram' : 'normalvram'),
      reserveVramGb: cCfg.reserveVramGb ?? (hasCoHostedLlm ? 6 : 4),
      promptEnhancerUpstreamId: cCfg.promptEnhancerUpstreamId || connectedLlm?.id,
      postProcessArtCraftApp:
        cCfg.postProcessArtCraftApp ||
        (connectedAc ? String((connectedAc.data as any)?.app || 'vectorcraft') : undefined),
      loopbackEluvixUrl: cCfg.loopbackEluvixUrl || 'http://127.0.0.1:3588/v1'
    };

    sections.push(generateComfyUISetupScript(node.id, endpoint, mergedConfig));
  });

  return sections.join('\n\n');
}

function generateAudioSetup(audioNodes: Node[]): string {
  if (audioNodes.length === 0) return '';
  return generateAudioVoiceSetupScript(
    audioNodes.map(node => {
      const data = (node.data || {}) as Record<string, any>;
      const rawAudio = (data.audio || {}) as Record<string, any>;
      return {
        id: node.id,
        name: typeof data.label === 'string' ? data.label : undefined,
        endpoint: String(data.endpoint || 'http://localhost:8005'),
        audio: {
          ...rawAudio,
          sttBackend: rawAudio.sttBackend || rawAudio.sttPreset || 'speaches',
          ttsBackend: rawAudio.ttsBackend || rawAudio.ttsPreset || 'kokoro',
        } as AudioVoiceConfig,
      };
    })
  );
}



