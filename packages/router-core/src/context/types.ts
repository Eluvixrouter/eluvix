import type { ChatMessage } from '../index.js';

export interface RequestScope {
  userId: string;
  sessionId?: string;
  agentId?: string;
  origin: 'client' | 'harness' | 'playground';
}

export interface RecallBlock {
  uri?: string;
  text: string;
  score?: number;
  level?: 'L0' | 'L1' | 'L2';
}

export interface RecallResult {
  blocks: RecallBlock[];
  tokenEstimate: number;
  provider: string;
  latencyMs: number;
}

export type MemoryProviderType =
  | 'builtin'
  | 'openviking'
  | 'mem0'
  | 'graphiti'
  | 'lightrag'
  | 'cognee'
  | 'supermemory';

export interface MemoryConfig {
  enabled?: boolean;
  provider?: MemoryProviderType;
  endpoint?: string;
  apiKey?: string;
  recallBudgetTokens?: number;
  recallTimeoutMs?: number;
  writeBack?: boolean;
  autoCommitTurns?: number;
  /**
   * Controls whether recalled memories may be sent to cloud upstreams:
   * - false (default): never allow memory-tainted prompts to hit cloud upstreams unless cloudMode='strip'
   * - true: allow recalled memory blocks to be sent to cloud upstreams
   */
  allowCloudEgress?: boolean;
  /**
   * When allowCloudEgress is false:
   * - 'filter' (default): remove non-local upstreams from consideration when memory is recalled
   * - 'strip': keep non-local upstreams as candidates, but strip the <eluvix-memory> block before sending to them
   */
  cloudMode?: 'filter' | 'strip';
  /**
   * Optional OpenViking-specific settings (e.g. default reading tier L0/L1/L2 or resource roots)
   */
  openviking?: {
    readingLevel?: 'L0' | 'L1' | 'L2';
    scopePrefixes?: string[];
  };
  /**
   * Retention window in days (audit M-20). When set, the builtin provider's
   * recall excludes items older than this many days. Unset (the default)
   * keeps items forever — the previous behavior. External providers
   * (mem0/openviking) manage their own retention server-side.
   */
  retentionDays?: number;
}

/** True for loopback hostnames (localhost, 127.0.0.0/8, ::1). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    /^127\./.test(host)
  );
}

/**
 * Memory-provider endpoint policy (audit H-9/M-18): a provider endpoint
 * receives the user's memory queries and stored turns, so it must be
 * https: — plain http: is allowed only for loopback endpoints (the local
 * default deployment). Enforced at provider construction so a config
 * pointing memory traffic at a remote plaintext endpoint fails fast
 * instead of silently exfiltrating.
 */
export function assertProviderEndpointAllowed(endpoint: string, providerName: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`${providerName} memory provider endpoint is not a valid URL: ${endpoint}`);
  }
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return;
  throw new Error(
    `${providerName} memory provider endpoint must use https: (plain http: is only allowed for loopback hosts): ${endpoint}`
  );
}

export interface KnowledgeBaseConfig {
  enabled?: boolean;
  backend?: 'openviking-resources' | 'lightrag' | 'local-fts';
  endpoint?: string;
  collectionUri?: string;
  topK?: number;
  maxTokens?: number;
  citationMode?: 'inline-uris' | 'silent';
  /**
   * Controls whether retrieved knowledge may be sent to cloud upstreams:
   * - false (default): never allow knowledge-tainted prompts to hit cloud upstreams unless cloudMode='strip'
   * - true: allow retrieved knowledge blocks to be sent to cloud upstreams
   */
  allowCloudEgress?: boolean;
  /**
   * When allowCloudEgress is false:
   * - 'filter' (default): remove non-local upstreams from consideration when knowledge is retrieved
   * - 'strip': keep non-local upstreams as candidates, but strip the <eluvix-knowledge> block before sending to them
   */
  cloudMode?: 'filter' | 'strip';
}

export interface ContextProvider {
  id: string;
  health(): Promise<boolean>;
  recall(
    query: string,
    scope: RequestScope,
    budgetTokens: number,
    signal?: AbortSignal
  ): Promise<RecallResult>;
  remember(
    turn: { user: ChatMessage; assistant: string },
    scope: RequestScope
  ): Promise<void>;
  commit?(scope: RequestScope): Promise<void>;
}
