import { Node, Edge } from '@xyflow/react';

export type DiagnosticFixKind =
  | 'reassign-port'
  | 'set-comfy-lowvram'
  | 'connect-to-switchyard'
  | 'enable-quantization';

export interface DiagnosticFixAction {
  kind: DiagnosticFixKind;
  label: string;
  description: string;
}

export interface GraphDiagnostic {
  id: string;
  severity: 'warning' | 'error';
  code: 'PORT_COLLISION' | 'VRAM_OVERCOMMIT' | 'UNCONNECTED_ENGINE' | 'AIRGAP_VIOLATION';
  message: string;
  nodeIds: string[];
  details?: Record<string, any>;
  fixAction?: DiagnosticFixAction;
}

export interface GraphDiagnosticsReport {
  diagnostics: GraphDiagnostic[];
  estimatedTotalVramGb: number;
  perNodeVramGb: Record<string, number>;
  portMap: Record<string, string[]>;
}

const LOCAL_ENGINE_NODE_TYPES = new Set([
  'lemonadeNode',
  'ollamaNode',
  'ramalamaNode',
  'comfyuiNode',
  'vllmNode',
  'sglangNode',
]);

function defaultEndpointForNodeType(nodeType?: string): string {
  switch (nodeType) {
    case 'lemonadeNode':
      return 'http://localhost:13305';
    case 'vllmNode':
      return 'http://localhost:8000';
    case 'sglangNode':
      return 'http://localhost:30000';
    case 'ramalamaNode':
      return 'http://localhost:8080';
    case 'comfyuiNode':
      return 'http://localhost:8188';
    case 'ollamaNode':
    default:
      return 'http://localhost:11434';
  }
}

function normalizeHostPort(endpointRaw: string): string | null {
  try {
    const trimmed = endpointRaw.trim();
    if (!trimmed || trimmed.startsWith('cli://') || trimmed.startsWith('acp://')) {
      return null;
    }
    const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    const host =
      url.hostname === '127.0.0.1' || url.hostname === '0.0.0.0' || url.hostname === '[::1]'
        ? 'localhost'
        : url.hostname.toLowerCase();
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return `${host}:${port}`;
  } catch {
    return null;
  }
}

/**
 * Estimates GPU VRAM usage (weights + KV cache overhead) in GB for a local engine node.
 */
export function estimateNodeVramGb(node: Node): number {
  const data = (node.data || {}) as Record<string, any>;
  if (node.type === 'comfyuiNode') {
    const cCfg = (data.comfyui || {}) as Record<string, any>;
    const vramMode = String(cCfg.vramMode || data.vramMode || 'normalvram');
    if (vramMode === 'cpu') return 0;
    const preset = String(cCfg.workflowPreset || data.workflowPreset || 'flux-txt2img');
    const ckpt = String(cCfg.checkpoint || data.selectedModel || '').toLowerCase();
    let baseGb = 12.0;
    if (preset === 'sdxl-txt2img' || ckpt.includes('sdxl') || ckpt.includes('sd_xl')) {
      baseGb = 6.5;
    } else if (preset === 'wan21-txt2vid' || ckpt.includes('wan')) {
      baseGb = 14.0;
    } else if (preset === 'hunyuan3d-mesh' || ckpt.includes('hunyuan')) {
      baseGb = 10.0;
    }
    if (vramMode === 'lowvram' || vramMode === 'novram') {
      baseGb *= 0.6;
    }
    return Number(baseGb.toFixed(2));
  }

  const modelStr = String(
    data.selectedModel ||
      (Array.isArray(data.models) && data.models[0]) ||
      '7b'
  ).toLowerCase();

  // Extract parameter count in billions (e.g. "70b", "14b", "8b", "3.2b", "1.5b", "0.5b")
  let paramsB = 7;
  const paramMatch = modelStr.match(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*b(?:[^a-z]|$)/i);
  if (paramMatch) {
    const parsed = parseFloat(paramMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1000) {
      paramsB = parsed;
    }
  } else if (modelStr.includes('mini') || modelStr.includes('tiny') || modelStr.includes('small')) {
    paramsB = 3.8;
  } else if (modelStr.includes('large')) {
    paramsB = 32;
  }

  // Determine bytes per parameter from quantization / engine format
  const quantFmt = String(data.quantization?.format || '').toLowerCase();
  let bytesPerParam = 0.65; // Default ~4.5-bit GGUF/AWQ
  if (quantFmt === 'nvfp4' || quantFmt === 'mxfp4' || modelStr.includes('q4') || modelStr.includes('fp4')) {
    bytesPerParam = 0.55;
  } else if (quantFmt === 'fp8' || modelStr.includes('fp8') || modelStr.includes('q8')) {
    bytesPerParam = 1.05;
  } else if (
    quantFmt === 'bf16' ||
    quantFmt === 'fp16' ||
    ((node.type === 'vllmNode' || node.type === 'sglangNode') && !quantFmt && !modelStr.includes('gguf') && !modelStr.includes('awq') && !modelStr.includes('gptq'))
  ) {
    bytesPerParam = 2.0;
  }

  const weightsGb = paramsB * bytesPerParam;
  const ctxTokens = Number(data.maxContextTokens || data.ramalama?.ctxSize || 8192);
  const kvCacheGb = Math.max(0.5, (ctxTokens / 8192) * (paramsB / 7) * 0.8);

  return Number((weightsGb + kvCacheGb).toFixed(2));
}

export function analyzeGraphDiagnostics(
  nodes: Node[],
  edges: Edge[],
  vramBudgetGb = 24
): GraphDiagnosticsReport {
  const diagnostics: GraphDiagnostic[] = [];
  const perNodeVramGb: Record<string, number> = {};
  const portMap: Record<string, string[]> = {};
  const portEnginesMap: Record<string, Map<string, string[]>> = {};

  const localNodes = nodes.filter((n) => n.type && LOCAL_ENGINE_NODE_TYPES.has(n.type));
  const countedModelKeys = new Set<string>();
  let totalVram = 0;

  for (const node of localNodes) {
    const vram = estimateNodeVramGb(node);
    perNodeVramGb[node.id] = vram;

    const data = (node.data || {}) as Record<string, any>;
    const endpoint = String(data.endpoint || defaultEndpointForNodeType(node.type));
    const hostPort = normalizeHostPort(endpoint);
    const modelKey = `${node.type}:${hostPort || endpoint}:${String(data.selectedModel || '*')}`;
    if (!countedModelKeys.has(modelKey)) {
      countedModelKeys.add(modelKey);
      totalVram += vram;
    }

    if (hostPort) {
      if (!portMap[hostPort]) portMap[hostPort] = [];
      portMap[hostPort].push(node.id);

      if (!portEnginesMap[hostPort]) portEnginesMap[hostPort] = new Map();
      const byType = portEnginesMap[hostPort];
      const engineType = String(node.type);
      byType.set(engineType, [...(byType.get(engineType) || []), node.id]);
    }
  }

  // Check port collisions across different local engine types on the same host:port
  for (const [hostPort, byType] of Object.entries(portEnginesMap)) {
    if (byType.size > 1) {
      const affectedNodeIds: string[] = [];
      const engineTypes: string[] = [];
      for (const [engineType, ids] of Array.from(byType.entries())) {
        engineTypes.push(engineType.replace(/Node$/, ''));
        affectedNodeIds.push(...ids);
      }
      diagnostics.push({
        id: `port-collision-${hostPort}`,
        severity: 'error',
        code: 'PORT_COLLISION',
        message: `Port collision on ${hostPort}: distinct local engines (${engineTypes.join(' vs ')}) are configured to bind the same endpoint.`,
        nodeIds: affectedNodeIds,
        details: { hostPort, engineTypes },
        fixAction: {
          kind: 'reassign-port',
          label: 'Reassign Conflicting Port',
          description: 'Moves conflicting engine(s) to the next free localhost port.',
        },
      });
    }
  }

  // Check VRAM budget overcommit
  const roundedTotalVram = Number(totalVram.toFixed(2));
  if (roundedTotalVram > vramBudgetGb && localNodes.length > 0) {
    diagnostics.push({
      id: 'vram-overcommit',
      severity: 'warning',
      code: 'VRAM_OVERCOMMIT',
      message: `Estimated aggregate local VRAM (${roundedTotalVram} GB) exceeds target GPU budget (${vramBudgetGb} GB).`,
      nodeIds: localNodes.map((n) => n.id),
      details: { estimatedTotalVramGb: roundedTotalVram, vramBudgetGb },
      fixAction: {
        kind: 'enable-quantization',
        label: 'Apply 4-Bit Quantization & Trim Context',
        description: 'Enables 4-bit quantization (nvfp4) on LLM engines, switches ComfyUI to --lowvram, and caps context to 8192 tokens.',
      },
    });
  }

  // Pillar 4: Warn when ComfyUI uses --highvram or --gpu-only alongside a local LLM
  const comfyNodes = localNodes.filter((n) => n.type === 'comfyuiNode');
  const otherLocalLlms = localNodes.filter((n) => n.type !== 'comfyuiNode');
  if (comfyNodes.length > 0 && otherLocalLlms.length > 0) {
    for (const cNode of comfyNodes) {
      const cData = (cNode.data || {}) as Record<string, any>;
      const vramMode = String(cData.comfyui?.vramMode || cData.vramMode || 'normalvram');
      if (vramMode === 'highvram' || vramMode === 'gpu-only') {
        diagnostics.push({
          id: `comfyui-vram-pin-${cNode.id}`,
          severity: 'warning',
          code: 'VRAM_OVERCOMMIT',
          message: `ComfyUI node "${cNode.id}" is set to --${vramMode} while co-hosted with local LLM engine(s); switch to --normalvram or --lowvram with --reserve-vram to prevent CUDA/ROCm OOM.`,
          nodeIds: [cNode.id, ...otherLocalLlms.map((n) => n.id)],
          details: { vramMode, targetComfyNodeId: cNode.id },
          fixAction: {
            kind: 'set-comfy-lowvram',
            label: 'Set ComfyUI --lowvram + 6GB Reserve',
            description: 'Updates ComfyUI VRAM policy to --lowvram with --reserve-vram 6 for safe LLM co-hosting.',
          },
        });
      }
    }
  }

  // Check unconnected local engines when edges exist on the canvas
  if (edges.length > 0 && nodes.length > 1) {
    for (const node of localNodes) {
      const hasIncoming = edges.some((e) => e.target === node.id);
      if (!hasIncoming) {
        diagnostics.push({
          id: `unconnected-${node.id}`,
          severity: 'warning',
          code: 'UNCONNECTED_ENGINE',
          message: `Local engine "${String((node.data as any)?.label || node.id)}" has no incoming routing edge.`,
          nodeIds: [node.id],
          fixAction: {
            kind: 'connect-to-switchyard',
            label: 'Wire to Switchyard / Input',
            description: 'Connects the orphaned local engine to Switchyard Balancer (or Client Input).',
          },
        });
      }
    }
  }

  return {
    diagnostics,
    estimatedTotalVramGb: roundedTotalVram,
    perNodeVramGb,
    portMap,
  };
}

function collectUsedPorts(nodes: Node[]): Set<number> {
  const used = new Set<number>([3588, 3000]); // Reserve Eluvix Gateway & Next.js UI ports
  for (const n of nodes) {
    const data = (n.data || {}) as Record<string, any>;
    const raw = String(data.endpoint || defaultEndpointForNodeType(n.type));
    const hp = normalizeHostPort(raw);
    if (hp) {
      const port = parseInt(hp.split(':').pop() || '', 10);
      if (Number.isFinite(port) && port > 0) used.add(port);
    }
  }
  return used;
}

function rewriteEndpointPort(endpointRaw: string, nextPort: number): string {
  try {
    const trimmed = endpointRaw.trim();
    const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
    url.port = String(nextPort);
    return url.toString().replace(/\/$/, '');
  } catch {
    return `http://localhost:${nextPort}`;
  }
}

/**
 * Pure immutable transformer that resolves a single `GraphDiagnostic` via its `fixAction`.
 */
export function applyDiagnosticFix(
  nodes: Node[],
  edges: Edge[],
  diagnostic: GraphDiagnostic
): { nodes: Node[]; edges: Edge[]; summary: string } {
  const kind = diagnostic.fixAction?.kind;
  if (!kind) {
    return { nodes, edges, summary: 'No automatic fix available for this diagnostic.' };
  }

  if (kind === 'reassign-port') {
    const usedPorts = collectUsedPorts(nodes);
    // Keep the first node on its current port and reassign subsequent colliding engine types
    const affectedSet = new Set(diagnostic.nodeIds);
    let keptFirst = false;
    const reassigned: string[] = [];

    const nextNodes = nodes.map((n) => {
      if (!affectedSet.has(n.id)) return n;
      if (!keptFirst) {
        keptFirst = true;
        return n;
      }
      const data = { ...(n.data || {}) } as Record<string, any>;
      const currentEp = String(data.endpoint || defaultEndpointForNodeType(n.type));
      const hp = normalizeHostPort(currentEp);
      const basePort = hp ? parseInt(hp.split(':').pop() || '8080', 10) || 8080 : 8080;
      let candidatePort = basePort + 1;
      while (usedPorts.has(candidatePort) && candidatePort < 65530) {
        candidatePort++;
      }
      usedPorts.add(candidatePort);
      data.endpoint = rewriteEndpointPort(currentEp, candidatePort);
      reassigned.push(`${n.id} → :${candidatePort}`);
      return { ...n, data };
    });

    return {
      nodes: nextNodes,
      edges,
      summary:
        reassigned.length > 0
          ? `Reassigned conflicting port(s): ${reassigned.join(', ')}`
          : 'No port reassignment required.',
    };
  }

  if (kind === 'set-comfy-lowvram') {
    const targetId = diagnostic.details?.targetComfyNodeId || diagnostic.nodeIds[0];
    const nextNodes = nodes.map((n) => {
      if (n.id !== targetId || n.type !== 'comfyuiNode') return n;
      const data = { ...(n.data || {}) } as Record<string, any>;
      const prevComfy = (data.comfyui || {}) as Record<string, any>;
      data.vramMode = 'lowvram';
      data.comfyui = {
        ...prevComfy,
        vramMode: 'lowvram',
        reserveVramGb: Math.max(6, Number(prevComfy.reserveVramGb || 0)),
      };
      return { ...n, data };
    });
    return {
      nodes: nextNodes,
      edges,
      summary: `Switched ComfyUI "${targetId}" to --lowvram with 6 GB VRAM reserve.`,
    };
  }

  if (kind === 'connect-to-switchyard') {
    const orphanId = diagnostic.nodeIds[0];
    const orphanNode = nodes.find((n) => n.id === orphanId);
    if (!orphanNode) {
      return { nodes, edges, summary: 'Orphaned node no longer exists.' };
    }
    const sourceNode =
      nodes.find((n) => n.type === 'switchyardNode') ||
      nodes.find((n) => n.type === 'fallbackChainNode') ||
      nodes.find((n) => n.type === 'consensusNode') ||
      nodes.find((n) => n.type === 'inputNode');

    if (!sourceNode || sourceNode.id === orphanId) {
      return { nodes, edges, summary: 'No upstream Switchyard or Input node found to wire from.' };
    }

    const alreadyWired = edges.some(
      (e) => e.source === sourceNode.id && e.target === orphanId
    );
    if (alreadyWired) {
      return { nodes, edges, summary: `${orphanId} is already connected.` };
    }

    const sourceHandle =
      sourceNode.type === 'switchyardNode'
        ? Array.isArray((sourceNode.data as any)?.routes) &&
          (sourceNode.data as any).routes.length > 0
          ? (sourceNode.data as any).routes[0].id
          : 'tier-1'
        : undefined;

    const newEdge: Edge = {
      id: `e-autofix-${sourceNode.id}-${orphanId}`,
      source: sourceNode.id,
      ...(sourceHandle ? { sourceHandle } : {}),
      target: orphanId,
      animated: true,
      style: { stroke: '#10b981', strokeWidth: 3.5 },
    };

    return {
      nodes,
      edges: [...edges, newEdge],
      summary: `Wired ${sourceNode.id}${sourceHandle ? ` (${sourceHandle})` : ''} → ${orphanId}.`,
    };
  }

  if (kind === 'enable-quantization') {
    const affectedSet = new Set(diagnostic.nodeIds);
    const nextNodes = nodes.map((n) => {
      if (!affectedSet.has(n.id)) return n;
      const data = { ...(n.data || {}) } as Record<string, any>;
      if (n.type === 'comfyuiNode') {
        const prevComfy = (data.comfyui || {}) as Record<string, any>;
        data.vramMode = 'lowvram';
        data.comfyui = {
          ...prevComfy,
          vramMode: 'lowvram',
          reserveVramGb: Math.max(6, Number(prevComfy.reserveVramGb || 4)),
        };
        return { ...n, data };
      }
      data.quantization = {
        ...(data.quantization || {}),
        format: 'nvfp4',
        outlierMitigation: data.quantization?.outlierMitigation || 'hadamard-quarot',
      };
      if (!data.maxContextTokens || Number(data.maxContextTokens) > 8192) {
        data.maxContextTokens = 8192;
      }
      if (data.ramalama && Number(data.ramalama.ctxSize || 0) > 8192) {
        data.ramalama = { ...data.ramalama, ctxSize: 8192 };
      }
      return { ...n, data };
    });

    return {
      nodes: nextNodes,
      edges,
      summary: 'Applied 4-bit quantization (nvfp4), --lowvram on ComfyUI, and 8K context cap on local engines.',
    };
  }

  return { nodes, edges, summary: 'Unsupported diagnostic fix action.' };
}

/**
 * Iteratively applies all available one-click diagnostic fixes until clean or no further fixes apply.
 */
export function applyAllDiagnosticFixes(
  nodes: Node[],
  edges: Edge[],
  vramBudgetGb = 24
): { nodes: Node[]; edges: Edge[]; appliedCount: number; summaries: string[] } {
  let curNodes = nodes;
  let curEdges = edges;
  const summaries: string[] = [];
  const seenIds = new Set<string>();

  for (let pass = 0; pass < 12; pass++) {
    const report = analyzeGraphDiagnostics(curNodes, curEdges, vramBudgetGb);
    const nextFixable = report.diagnostics.find(
      (d) => d.fixAction && !seenIds.has(`${d.id}:${d.fixAction.kind}`)
    );
    if (!nextFixable) break;
    seenIds.add(`${nextFixable.id}:${nextFixable.fixAction!.kind}`);
    const res = applyDiagnosticFix(curNodes, curEdges, nextFixable);
    curNodes = res.nodes;
    curEdges = res.edges;
    summaries.push(res.summary);
  }

  return {
    nodes: curNodes,
    edges: curEdges,
    appliedCount: summaries.length,
    summaries,
  };
}
