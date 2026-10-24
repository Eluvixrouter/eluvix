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
}

export interface KnowledgeBaseConfig {
  enabled?: boolean;
  backend?: 'openviking-resources' | 'lightrag' | 'local-fts';
  endpoint?: string;
  collectionUri?: string;
  topK?: number;
  maxTokens?: number;
  citationMode?: 'inline-uris' | 'silent';
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
