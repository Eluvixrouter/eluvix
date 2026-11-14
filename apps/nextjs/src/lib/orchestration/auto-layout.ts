import { Node, Edge } from '@xyflow/react';

export interface AutoLayoutOptions {
  /** Leftmost X coordinate for Rank 0 (`inputNode`). Default: 80 */
  startX?: number;
  /** Center spine Y coordinate around which each column is balanced. Default: 320 */
  centerY?: number;
  /** Horizontal pixel distance between adjacent topological ranks. Default: 430 */
  rankSpacingX?: number;
  /** Vertical pixel padding between adjacent node cards in the same column. Default: 56 */
  nodeGapY?: number;
}

const NODE_CARD_HEIGHT_ESTIMATE: Record<string, number> = {
  inputNode: 190,
  privacyGuardNode: 290,
  semanticGuardNode: 290,
  memoryNode: 310,
  knowledgeBaseNode: 320,
  paperclipBridgeNode: 340,
  semanticCacheNode: 290,
  confidentialEnclaveNode: 330,
  crsNode: 330,
  taskRouterNode: 300,
  modelGatewayNode: 290,
  agentGatewayNode: 300,
  mcpToolNode: 250,
  switchyardNode: 580,
  speculativeCascadeNode: 360,
  consensusNode: 320,
  fallbackChainNode: 300,
  lemonadeNode: 350,
  ollamaNode: 350,
  ramalamaNode: 430,
  vllmNode: 360,
  sglangNode: 390,
  comfyuiNode: 470,
  audioVoiceNode: 390,
  antigravityNode: 440,
  codexNode: 360,
  claudeCodeNode: 360,
  harnessNode: 400,
  billamaNode: 300,
  openaiNode: 300,
  claudeNode: 300,
  agentNode: 300,
  vectorcraftNode: 360,
  artcraftNode: 360,
  sandboxNode: 310,
  observabilityNode: 210,
};

const UPSTREAM_RANK_4_TYPES = new Set([
  'lemonadeNode',
  'ollamaNode',
  'ramalamaNode',
  'audioVoiceNode',
  'vllmNode',
  'sglangNode',
  'antigravityNode',
  'codexNode',
  'claudeCodeNode',
  'harnessNode',
  'billamaNode',
  'openaiNode',
  'claudeNode',
  'agentNode',
]);

/**
 * Returns the canonical base topological rank (0..6) for an Eluvix node type.
 */
export function getSemanticBaseRank(node: Node, incomingSources: Node[]): number {
  const t = node.type || '';
  if (t === 'inputNode') return 0;

  if (
    t === 'privacyGuardNode' ||
    t === 'semanticGuardNode' ||
    t === 'memoryNode' ||
    t === 'knowledgeBaseNode' ||
    t === 'paperclipBridgeNode' ||
    t === 'semanticCacheNode'
  ) {
    return 1;
  }

  if (
    t === 'confidentialEnclaveNode' ||
    t === 'crsNode' ||
    t === 'taskRouterNode' ||
    t === 'modelGatewayNode' ||
    t === 'agentGatewayNode' ||
    t === 'mcpToolNode'
  ) {
    return 2;
  }

  if (
    t === 'switchyardNode' ||
    t === 'speculativeCascadeNode' ||
    t === 'consensusNode' ||
    t === 'fallbackChainNode'
  ) {
    return 3;
  }

  if (t === 'comfyuiNode') {
    // When ComfyUI receives a prompt-enhancement edge from a Rank-4 LLM engine, place it in Rank 5
    const fedByLlmEngine = incomingSources.some((src) => UPSTREAM_RANK_4_TYPES.has(src.type || ''));
    return fedByLlmEngine ? 5 : 4;
  }

  if (UPSTREAM_RANK_4_TYPES.has(t)) {
    return 4;
  }

  if (t === 'vectorcraftNode' || t === 'artcraftNode' || t === 'sandboxNode') {
    return 5;
  }

  if (t === 'observabilityNode') {
    return 6;
  }

  return 4;
}

function estimateCardHeight(node: Node): number {
  const measured = (node as any).measured?.height ?? node.height;
  if (typeof measured === 'number' && measured > 80) {
    return measured;
  }
  return NODE_CARD_HEIGHT_ESTIMATE[node.type || ''] ?? 320;
}

function parseHandleOrder(sourceHandle?: string | null): number {
  if (!sourceHandle) return 0;
  const tierMatch = sourceHandle.match(/tier-(\d+)/i);
  if (tierMatch) return parseInt(tierMatch[1], 10) * 10;
  if (sourceHandle === 'draft') return 10;
  if (sourceHandle === 'verifier') return 20;
  if (sourceHandle === 'shadow-student') return 30;
  if (sourceHandle === 'clean' || sourceHandle === 'safe' || sourceHandle === 'hit') return -5;
  if (sourceHandle === 'blocked' || sourceHandle === 'divert' || sourceHandle === 'miss') return 25;
  return 0;
}

/**
 * Deterministic Sugiyama-style topological DAG auto-layout tailored for the
 * Eluvix Visual Node Routing Editor.
 *
 * Guarantees:
 * 1. Monotonic left-to-right flow across pipeline stages (Input -> Guards -> Enclave/CRS -> Switchyard -> Engines -> Post-Process -> Observability).
 * 2. Two-pass barycentric crossing minimization respecting Switchyard `tier-1..N` handle ordering.
 * 3. Zero vertical bounding-box overlap within every rank column.
 */
export function autoLayoutGraph(
  nodes: Node[],
  edges: Edge[],
  options?: AutoLayoutOptions
): Node[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];

  const startX = options?.startX ?? 80;
  const centerY = options?.centerY ?? 340;
  const rankSpacingX = options?.rankSpacingX ?? 430;
  const nodeGapY = options?.nodeGapY ?? 56;

  const nodeMap = new Map<string, Node>();
  nodes.forEach((n) => nodeMap.set(n.id, n));

  const incomingEdges = new Map<string, Edge[]>();
  const outgoingEdges = new Map<string, Edge[]>();
  for (const n of nodes) {
    incomingEdges.set(n.id, []);
    outgoingEdges.set(n.id, []);
  }
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!nodeMap.has(e.source) || !nodeMap.has(e.target)) continue;
    incomingEdges.get(e.target)!.push(e);
    outgoingEdges.get(e.source)!.push(e);
  }

  // Step 1: Assign initial semantic ranks
  const rankById = new Map<string, number>();
  for (const n of nodes) {
    const preds = (incomingEdges.get(n.id) || [])
      .map((e) => nodeMap.get(e.source))
      .filter((x): x is Node => Boolean(x));
    rankById.set(n.id, getSemanticBaseRank(n, preds));
  }

  // Step 2:Bounded longest-path relaxation so chained guards or chained post-processors
  // strictly advance left-to-right without infinite loops if user created a cycle.
  const maxRelaxPasses = Math.min(nodes.length, 8);
  for (let pass = 0; pass < maxRelaxPasses; pass++) {
    let changed = false;
    for (const e of edges) {
      if (!rankById.has(e.source) || !rankById.has(e.target)) continue;
      const srcNode = nodeMap.get(e.source)!;
      const tgtNode = nodeMap.get(e.target)!;
      // Only relax within compatible forward flow (do not push Switchyard past Engines on reverse MCP/tool edges)
      const srcBase = rankById.get(e.source)!;
      const tgtBase = rankById.get(e.target)!;
      const isReverseAuxiliary =
        (srcNode.type === 'mcpToolNode' && tgtBase <= srcBase) ||
        (srcNode.type === 'sandboxNode' && UPSTREAM_RANK_4_TYPES.has(tgtNode.type || ''));
      if (isReverseAuxiliary) continue;

      if (tgtBase <= srcBase && srcBase < 8) {
        rankById.set(e.target, srcBase + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Ensure observabilityNode is always placed in the rightmost active rank + 1 (if connected)
  let maxNonObsRank = 0;
  for (const n of nodes) {
    if (n.type !== 'observabilityNode') {
      maxNonObsRank = Math.max(maxNonObsRank, rankById.get(n.id) ?? 0);
    }
  }
  for (const n of nodes) {
    if (n.type === 'observabilityNode') {
      rankById.set(n.id, Math.max(rankById.get(n.id) ?? 6, maxNonObsRank + 1));
    }
  }

  // Step 3: Compact empty intermediate ranks so columns have uniform visual rhythm
  const occupiedRanks = Array.from(new Set(Array.from(rankById.values()))).sort((a, b) => a - b);
  const compactedRankMap = new Map<number, number>();
  occupiedRanks.forEach((origRank, idx) => compactedRankMap.set(origRank, idx));

  const columns = new Map<number, Node[]>();
  for (const n of nodes) {
    const cRank = compactedRankMap.get(rankById.get(n.id)!) ?? 0;
    rankById.set(n.id, cRank);
    if (!columns.has(cRank)) columns.set(cRank, []);
    columns.get(cRank)!.push(n);
  }

  const numCols = occupiedRanks.length;

  // Preserve deterministic initial order within each column by existing Y then ID
  for (let c = 0; c < numCols; c++) {
    const col = columns.get(c) || [];
    col.sort((a, b) => {
      const dy = (a.position?.y ?? 0) - (b.position?.y ?? 0);
      if (Math.abs(dy) > 1) return dy;
      return a.id.localeCompare(b.id);
    });
  }

  const orderIndex = new Map<string, number>();
  const refreshOrderIndices = () => {
    for (let c = 0; c < numCols; c++) {
      const col = columns.get(c) || [];
      col.forEach((n, idx) => orderIndex.set(n.id, idx * 100));
    }
  };
  refreshOrderIndices();

  // Step 4: Two-pass barycentric crossing minimization (Forward + Backward + Forward)
  for (let sweep = 0; sweep < 2; sweep++) {
    // Forward sweep (left -> right): order by predecessor position + Switchyard handle tier
    for (let c = 1; c < numCols; c++) {
      const col = columns.get(c) || [];
      if (col.length <= 1) continue;
      const barycenter = new Map<string, number>();
      for (const n of col) {
        const inEdges = (incomingEdges.get(n.id) || []).filter(
          (e) => (rankById.get(e.source) ?? 0) < c
        );
        if (inEdges.length === 0) {
          barycenter.set(n.id, orderIndex.get(n.id) ?? 0);
        } else {
          const sum = inEdges.reduce(
            (acc, e) =>
              acc + (orderIndex.get(e.source) ?? 0) + parseHandleOrder(e.sourceHandle),
            0
          );
          barycenter.set(n.id, sum / inEdges.length);
        }
      }
      col.sort((a, b) => {
        const diff = (barycenter.get(a.id) ?? 0) - (barycenter.get(b.id) ?? 0);
        if (Math.abs(diff) > 0.01) return diff;
        const prioA = Number((a.data as any)?.priority ?? 0);
        const prioB = Number((b.data as any)?.priority ?? 0);
        if (prioA !== prioB) return prioB - prioA;
        return a.id.localeCompare(b.id);
      });
      refreshOrderIndices();
    }

    // Backward sweep (right -> left): align upstream guards/routers with downstream targets
    for (let c = numCols - 2; c >= 0; c--) {
      const col = columns.get(c) || [];
      if (col.length <= 1) continue;
      const barycenter = new Map<string, number>();
      for (const n of col) {
        const outEdges = (outgoingEdges.get(n.id) || []).filter(
          (e) => (rankById.get(e.target) ?? 0) > c
        );
        if (outEdges.length === 0) {
          barycenter.set(n.id, orderIndex.get(n.id) ?? 0);
        } else {
          const sum = outEdges.reduce(
            (acc, e) =>
              acc + (orderIndex.get(e.target) ?? 0) - parseHandleOrder(e.sourceHandle) * 0.25,
            0
          );
          barycenter.set(n.id, sum / outEdges.length);
        }
      }
      col.sort((a, b) => {
        const diff = (barycenter.get(a.id) ?? 0) - (barycenter.get(b.id) ?? 0);
        return Math.abs(diff) > 0.01 ? diff : a.id.localeCompare(b.id);
      });
      refreshOrderIndices();
    }
  }

  // Step 5: Compute collision-free (x, y) coordinates per column centered around centerY
  const positionById = new Map<string, { x: number; y: number }>();
  for (let c = 0; c < numCols; c++) {
    const col = columns.get(c) || [];
    if (col.length === 0) continue;
    const heights = col.map((n) => estimateCardHeight(n));
    const totalColumnHeight =
      heights.reduce((sum, h) => sum + h, 0) + Math.max(0, col.length - 1) * nodeGapY;

    let cursorY = Math.round(centerY - totalColumnHeight / 2);
    // Keep top margin >= 40px when a column has many stacked engines
    if (cursorY < 40) cursorY = 40;

    const colX = startX + c * rankSpacingX;
    col.forEach((n, idx) => {
      positionById.set(n.id, { x: colX, y: cursorY });
      cursorY += heights[idx] + nodeGapY;
    });
  }

  return nodes.map((n) => {
    const nextPos = positionById.get(n.id);
    if (!nextPos) return n;
    return {
      ...n,
      position: { x: nextPos.x, y: nextPos.y },
    };
  });
}
