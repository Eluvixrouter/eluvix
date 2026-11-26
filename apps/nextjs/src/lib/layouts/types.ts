export interface LayoutViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface LayoutMetadata {
  id: string; // slug, e.g. "cost-cascade"
  name: string;
  description?: string;
  category?: 'starter' | 'local' | 'hybrid' | 'cost' | 'privacy' | 'agent' | 'custom' | string;
  tags?: string[];
  isExample?: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
}

/**
 * Registry of node types the editor renders and the compiler understands
 * (must mirror the `nodeTypes` map in RoutingEditor.tsx). Layout
 * import/save rejects anything else — a crafted layout must not plant an
 * unknown node type whose data later compiles into an upstream (hunt-3
 * C-L12). This lives in types.ts so both the server-side layout store
 * and the browser-side import handler share one list.
 */
export const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set([
  'inputNode',
  'agentNode',
  'switchyardNode',
  'semanticGuardNode',
  'privacyGuardNode',
  'taskRouterNode',
  'agentGatewayNode',
  'mcpToolNode',
  'modelGatewayNode',
  'observabilityNode',
  'lemonadeNode',
  'vllmNode',
  'sglangNode',
  'ollamaNode',
  'ramalamaNode',
  'comfyuiNode',
  'audioVoiceNode',
  'antigravityNode',
  'codexNode',
  'claudeCodeNode',
  'billamaNode',
  'openaiNode',
  'claudeNode',
  'memoryNode',
  'harnessNode',
  'sandboxNode',
  'knowledgeBaseNode',
  'paperclipBridgeNode',
  'semanticCacheNode',
  'consensusNode',
  'speculativeCascadeNode',
  'fallbackChainNode',
  'confidentialEnclaveNode',
  'crsNode',
  'vectorcraftNode',
  'artcraftNode',
]);

/** Endpoint schemes a layout node may carry (anything else is not a routable upstream target). */
export const ALLOWED_NODE_ENDPOINT_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'cli:',
  'acp:',
  'ws:',
  'wss:',
]);

/**
 * Hunt-3 C-L12: validate one imported/saved node's `data` contents. The
 * compiler copies `data.cliPath` and `data.endpoint` verbatim into
 * upstreams, so a crafted layout could otherwise plant an arbitrary
 * executable path or endpoint. This is the import-time check; the strict
 * cliPath allowlist (`router.ts` isValidCliPath) and the router-core spawn
 * gate still apply at Apply/deploy time.
 *
 * Returns an error message, or null when the data is acceptable.
 */
export function validateLayoutNodeData(data: unknown): string | null {
  if (data === undefined || data === null) return null;
  if (typeof data !== 'object' || Array.isArray(data)) {
    return 'node "data" must be an object';
  }
  const d = data as Record<string, unknown>;
  const cliPaths: unknown[] = [d.cliPath, (d.antigravity as any)?.cliPath];
  for (const cliPath of cliPaths) {
    if (cliPath === undefined || cliPath === null) continue;
    if (typeof cliPath !== 'string' || !cliPath.trim()) {
      return 'node "cliPath" must be a non-empty string';
    }
    // No shell metacharacters or whitespace, and the binary must be named
    // `agy` (bare or as an absolute path) — anything else is not an
    // Antigravity executable.
    if (/[;&|`$<>\s]/.test(cliPath) || !(cliPath === 'agy' || /(^|\/)agy$/.test(cliPath))) {
      return `node "cliPath" "${cliPath}" is not an allowed Antigravity executable`;
    }
  }
  const endpoint = d.endpoint;
  if (endpoint !== undefined && endpoint !== null) {
    if (typeof endpoint !== 'string' || !endpoint.trim()) {
      return 'node "endpoint" must be a non-empty string';
    }
    if (endpoint.includes('://')) {
      let scheme = '';
      try {
        scheme = new URL(endpoint).protocol;
      } catch {
        return `node "endpoint" "${endpoint}" is not a valid URL`;
      }
      if (!ALLOWED_NODE_ENDPOINT_SCHEMES.has(scheme)) {
        return `node "endpoint" scheme "${scheme}" is not allowed`;
      }
      // No embedded credentials in the authority (SSRF guard territory,
      // rejected here too so a planted endpoint cannot smuggle them).
      if (/:\/\/[^/]*@/.test(endpoint)) {
        return 'node "endpoint" must not contain embedded credentials';
      }
    }
  }
  return null;
}

export interface Layout {
  id: string; // slug
  name: string;
  description?: string;
  category?: 'starter' | 'local' | 'hybrid' | 'cost' | 'privacy' | 'agent' | 'custom' | string;
  tags?: string[];
  isExample?: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  viewport?: LayoutViewport;
  nodes: any[];
  edges: any[];
}

export interface LayoutsState {
  lastActiveSlug?: string;
  examplesSeededVersion?: number;
}
