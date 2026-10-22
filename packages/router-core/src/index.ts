import type { PromptGuardConfig, PrivacyGuardConfig } from './guard.js';

export type RoutingStrategy = 
  | 'cost-complexity' 
  | 'cascade-cost' 
  | 'lowest-cost' 
  | 'lowest-latency' 
  | 'round-robin' 
  | 'priority';

export interface SwitchyardConfig {
  strategy?: RoutingStrategy;
  timeoutMs?: number;
  /**
   * Total wall-clock budget for failover, in milliseconds. The first
   * upstream attempt always gets its full timeoutMs; once the budget is
   * exhausted, no further upstream attempts are started, so a request
   * with N dead upstreams fails in ~budget instead of N x timeoutMs.
   * Defaults to 120000.
   */
  failoverBudgetMs?: number;
  retryCount?: number;
  spilloverThresholdMs?: number;
  codeEscalation?: boolean;
  complexityThresholds?: {
    moderate?: number;
    heavy?: number;
    frontier?: number;
  };
  maxCostPerRequest?: number;
}

export interface ModelGatewayConfig {
  primaryModel?: string;
  fallbackStrategy?: 'cheaper' | 'same-tier' | 'fail-fast';
  caching?: {
    enabled?: boolean;
    ttlSeconds?: number;
    similarityThreshold?: number;
  };
  rateLimits?: {
    maxRpm?: number;
  };
  systemPromptPrepend?: string;
}

export type EgressPolicy = 'local-only' | 'allow-egress';

export interface RouterConfig {
  upstreams: UpstreamConfig[];
  defaultModel?: string;
  strategy?: RoutingStrategy;
  /**
   * 'local-only' fails closed: routing only ever considers upstreams served
   * from this machine / LAN, even as a fallback. Absent = 'allow-egress'
   * (legacy behavior) so hand-written configs keep working.
   */
  egressPolicy?: EgressPolicy;
  fallbackStrategy?: 'round-robin' | 'priority';
  switchyard?: SwitchyardConfig;
  modelGateway?: ModelGatewayConfig;
  promptGuard?: PromptGuardConfig & { action?: 'block' | 'strip' | 'divert' | 'warn' };
  privacyGuard?: PrivacyGuardConfig;
  memory?: MemoryConfig;
}

export * from './paths.js';
export * from './db.js';
export * from './tls.js';
export * from './guard.js';
export * from './auth.js';
export * from './context/index.js';
export * from './harness/index.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
export * from './provider.js';
export * from './antigravity-models.js';
import {
  discoverAntigravityModels,
  getCachedAntigravityModels,
  resolveAntigravityEffort,
  prepareCleanAgyHome,
  parseAgyStreamJsonLine
} from './antigravity-models.js';
import { logRequest, getRequestLogs } from './db.js';
import { validateChatPrompt, applyPrivacyGuard, stripPromptThreats } from './guard.js';
import {
  type ContextProvider,
  type MemoryConfig,
  type RequestScope,
  createContextProvider,
  formatMemorySystemBlock,
  injectMemoryIntoMessages,
  stripMemoryFromMessages,
  teeSseStreamForMemory
} from './context/index.js';
import { type HarnessConfig, forwardHarnessRequest } from './harness/index.js';

/** One recorded stage of upstream selection, in execution order. */
export interface RouteTraceStep {
  stage:
    | 'model-match'
    | 'loop-guard'
    | 'egress-policy'
    | 'memory'
    | 'memory-egress'
    | 'vision-filter'
    | 'tools-filter'
    | 'ranking';
  detail: string;
  /** Upstream ids surviving this stage, when the stage filters. */
  kept?: string[];
  /** Upstream ids removed by this stage, when the stage filters. */
  removed?: string[];
}

/**
 * A non-executing explanation of how routeChatCompletion would select an
 * upstream for a request: the deterministic selection stages, the ranked
 * failover order, and the first candidate that would be tried. Runtime
 * adjustments (latency spillover, per-attempt cost ceiling, retries) are
 * not modeled. When selection would fail, `error` carries the message
 * routing would throw and `chosenUpstreamId` is null.
 */
export interface RouteExplanation {
  model: string;
  strategy: RoutingStrategy;
  egressPolicy?: EgressPolicy;
  complexity: {
    score: number;
    label: string;
    tokenEstimate: number;
    hasImages: boolean;
    hasTools: boolean;
  };
  steps: RouteTraceStep[];
  rankedUpstreams: Array<{ id: string; name: string; type: UpstreamType }>;
  chosenUpstreamId: string | null;
  error?: string;
}

export type UpstreamType = 
  | 'openai-compatible'
  | 'billama'
  | 'anthropic'
  | 'vllm-sr'
  | 'vllm'
  | 'switchyard'
  | 'ollama'
  | 'lemonade'
  | 'antigravity'
  | 'harness';

export interface AntigravityConfig {
  model?: string;
  executionMode?: 'cli' | 'agent-router' | 'custom-http';
  cliPath?: string;
  cwd?: string;
  endpoint?: string;
  sandbox?: 'standard' | 'bypass' | 'read-only';
  behavior?: 'autonomous' | 'interactive' | 'planning';
  extendedThinking?: boolean;
  thinkingBudget?: number;
  subagents?: boolean;
  maxSubagentDepth?: number;
  effort?: 'auto' | 'low' | 'medium' | 'high';
  cleanHeadless?: boolean;
  dangerouslySkipPermissions?: boolean;
}

export interface UpstreamConfig {
  id: string;
  name: string;
  type: UpstreamType;
  endpoint: string;
  apiKey?: string;
  priority: number;
  models: string[];
  costPer1kTokens?: number;
  tier?: string;
  tierName?: string;
  maxComplexityScore?: number;
  latencyMs?: number;
  capabilities?: string[];
  antigravity?: AntigravityConfig;
  harness?: HarnessConfig;
}

/**
 * Whether serving a prompt through this upstream keeps the prompt on the
 * user's own machine / LAN. Antigravity and other cli:// agent wrappers are
 * NOT local: the CLI is a front-end for an external service, so the prompt
 * leaves the machine even though the process runs locally.
 * For 'harness' upstreams, an explicit `harness.providerIsLocal` decides.
 * When the flag is absent, locality is derived from the endpoint with the
 * same rule as every other wrapper: cli:// and acp:// endpoints spawn a
 * local process that fronts an external service, so they are NOT local;
 * http(s) endpoints are judged by host like any other upstream. (The flag
 * used to default to local — including a blanket shortcut for ACP — which
 * let the egress policy and the memory-egress guard treat remote or
 * cloud-backed harnesses as on-machine.)
 */
export function isLocalUpstream(upstream: UpstreamConfig): boolean {
  if (!upstream) return false;
  if (upstream.type === 'antigravity') return false;
  if (upstream.type === 'harness' && upstream.harness?.providerIsLocal !== undefined) {
    return upstream.harness.providerIsLocal;
  }
  const endpoint = upstream.endpoint || '';
  if (endpoint.startsWith('cli://')) return false;
  if (endpoint.startsWith('acp://')) {
    // Process-wrapper endpoint (see above): a harness with no explicit
    // providerIsLocal declaration is not local. Non-harness upstreams keep
    // the legacy behavior.
    return upstream.type === 'harness' ? false : upstream.harness?.providerIsLocal !== false;
  }
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
  } catch {
    return false;
  }
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice(7);
    const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const high = parseInt(hexMatch[1], 16);
      const low = parseInt(hexMatch[2], 16);
      host = `${(high >>> 8) & 255}.${high & 255}.${(low >>> 8) & 255}.${low & 255}`;
    } else {
      host = mapped;
    }
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return true;
  return false;
}

/**
 * Whether an upstream can serve requests that contain images. An explicit
 * 'vision' capability wins; otherwise capability is inferred from the
 * provider type and the served model names — the same style of inference
 * routing already applies to tool calling. Inference matters because most
 * configurations declare no capabilities at all: previously every image
 * request dead-ended with "no upstream with vision capability" even when
 * a multimodal provider (OpenAI-compatible, Anthropic, Billama,
 * Antigravity, or a local vision model like llava / *-vl / omni) was
 * configured and reachable.
 */
export function isVisionCapableUpstream(upstream: UpstreamConfig): boolean {
  if (!upstream) return false;
  if (upstream.capabilities?.includes('vision')) return true;
  if (
    upstream.type === 'openai-compatible' ||
    upstream.type === 'anthropic' ||
    upstream.type === 'antigravity' ||
    upstream.type === 'billama'
  ) {
    return true;
  }
  return Array.isArray(upstream.models) && upstream.models.some(m => /gpt-4o|gpt-4-turbo|claude|gemini|llava|-vl\b|vision|omni/i.test(m));
}

export interface PromptComplexityAssessment {
  score: 1 | 2 | 3 | 4;
  label: 'simple' | 'moderate' | 'heavy' | 'frontier';
  tokenEstimate: number;
  features: string[];
  hasImages?: boolean;
  hasTools?: boolean;
}

export function estimatePromptComplexity(
  messages: ChatMessage[],
  customThresholds?: {
    moderate?: number;
    heavy?: number;
    frontier?: number;
    codeEscalation?: boolean;
    hasTools?: boolean;
    toolsCount?: number;
  }
): PromptComplexityAssessment {
  if (!messages || messages.length === 0) {
    const hasTools = customThresholds?.hasTools ?? false;
    return {
      score: hasTools ? 3 : 1,
      label: hasTools ? 'heavy' : 'simple',
      tokenEstimate: 0,
      features: hasTools ? [`tools (${customThresholds?.toolsCount ?? 1})`] : ['empty'],
      hasImages: false,
      hasTools
    };
  }

  let hasImages = false;

  const textContent = messages.map(m => {
    if (typeof m.content === 'string') {
      return m.content;
    } else if (Array.isArray(m.content)) {
      let combined = '';
      for (const part of m.content) {
        if (part.type === 'text') combined += part.text + '\n';
        if (part.type === 'image_url') hasImages = true;
      }
      return combined;
    }
    return '';
  }).join('\n');
  const totalChars = textContent.length;
  const tokenEstimate = Math.ceil(totalChars / 4);
  const features: string[] = [];

  // 1. Code blocks & programming syntax markers
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeMatches = textContent.match(codeBlockRegex);
  const codeBlockMatches = codeMatches ? codeMatches.length : 0;
  if (codeBlockMatches > 0) {
    features.push(`${codeBlockMatches} code block(s)`);
  }

  // 2. Structured schemas (JSON, XML/HTML, structured tables)
  const isStructured = /(\{|\[)\s*"[^"]+"\s*:/g.test(textContent) ||
    /<[a-zA-Z0-9_-]+>[\s\S]*?<\/[a-zA-Z0-9_-]+>/g.test(textContent);
  if (isStructured) {
    features.push('structured schema (json/xml)');
  }

  // 3. Complex reasoning & analytical markers
  const reasoningRegex = /\b(step-by-step|step by step|prove|proof|derive|differential|algorithmic|architecture|refactor|benchmark|root cause|diagnose|formal verification|complexity analysis|edge case|concurrency|mutex|deadlock|quantum|theorem|calculus|linear algebra|optimize|optimization)\b/gi;
  const reasoningMatches = textContent.match(reasoningRegex);
  const reasoningCount = reasoningMatches ? reasoningMatches.length : 0;
  if (reasoningCount > 0) {
    features.push(`reasoning keywords (${reasoningCount})`);
  }

  if (hasImages) {
    features.push('image payload');
  }

  const hasTools = customThresholds?.hasTools ?? false;
  if (hasTools) {
    features.push(`tools (${customThresholds?.toolsCount ?? 1})`);
  }

  const frontierLimit = customThresholds?.frontier ?? 6000;
  const heavyLimit = customThresholds?.heavy ?? 1500;
  const moderateLimit = customThresholds?.moderate ?? 300;
  const codeEscalate = customThresholds?.codeEscalation ?? true;

  let score: 1 | 2 | 3 | 4 = 1;
  let label: 'simple' | 'moderate' | 'heavy' | 'frontier' = 'simple';

  // Level 4: Frontier (Massive token context > frontierLimit tokens or extreme code/reasoning requirements)
  if (tokenEstimate > frontierLimit || hasImages || (tokenEstimate > 2500 && (codeBlockMatches >= 3 || reasoningCount >= 4))) {
    score = 4;
    label = 'frontier';
  }
  // Level 3: Heavy / Coding / In-depth reasoning / Tool-calling
  else if (tokenEstimate > heavyLimit || (codeEscalate && codeBlockMatches >= 1) || reasoningCount >= 2 || isStructured || hasTools) {
    score = 3;
    label = 'heavy';
  }
  // Level 2: Moderate
  else if (tokenEstimate > moderateLimit || reasoningCount >= 1 || messages.length > 5) {
    score = 2;
    label = 'moderate';
  }
  // Level 1: Simple
  else {
    score = 1;
    label = 'simple';
  }

  return {
    score,
    label,
    tokenEstimate,
    features,
    hasImages,
    hasTools
  };
}

export type MessageContentPart = 
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: string;
  content: string | MessageContentPart[];
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  user?: string;
  metadata?: Record<string, any>;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  size?: number | string;
  recipe?: string;
  ownedBy?: string;
  labels?: string[];
  contextLength?: number;
}

export interface UpstreamDiscoveryResult {
  models: string[];
  details: DiscoveredModel[];
}

export async function detectUpstreamModelDetails(upstream: UpstreamConfig, timeoutMs = 5000): Promise<UpstreamDiscoveryResult> {
  if (upstream.type === 'antigravity' || upstream.endpoint.startsWith('cli://')) {
    const cliPath = upstream.antigravity?.cliPath || 'agy';
    const discovered = await discoverAntigravityModels(cliPath);
    const models = [...discovered.models.map(m => m.baseId), '*'];
    const details: DiscoveredModel[] = discovered.models.map(m => ({
      id: m.baseId,
      name: m.displayName,
      recipe: 'antigravity-cli',
      ownedBy: 'antigravity',
      labels: [m.tier, ...m.efforts.map(e => `effort:${e}`)],
      contextLength: m.contextLimit
    }));
    return { models, details };
  }

  if (upstream.type === 'harness' || upstream.endpoint.startsWith('acp://')) {
    const kind = upstream.harness?.kind || (upstream.endpoint.startsWith('acp://') ? 'acp' : 'trueforge');
    if (kind === 'trueforge' && /^https?:\/\//i.test(upstream.endpoint)) {
      const base = upstream.endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(`${base}/v1/models`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
        clearTimeout(timer);
        if (res.ok) {
          const data = await res.json();
          const parsed = parseModelDetails(data);
          if (parsed.models.length > 0) {
            return parsed;
          }
        }
      } catch {
        // Fall through to static harness models when container is offline
      }
    }
    if (kind === 'acp' || kind === 'trueforge') {
      const configured = Array.isArray(upstream.models) && upstream.models.length > 0
        ? upstream.models
        : [`harness/${kind}`, `${kind}/default`];
      const details: DiscoveredModel[] = configured
        .filter(m => m !== '*')
        .map(id => ({
          id,
          name: id,
          recipe: `harness:${kind}`,
          ownedBy: kind
        }));
      return { models: configured, details };
    }
  }

  const trimmed = upstream.endpoint.trim().replace(/\/+$/, '');
  const candidateUrls: string[] = [];
  const baseWithoutV1 = trimmed.replace(/\/v1$/, '');

  // Determine candidate URLs based on type and endpoint structure
  if (upstream.type === 'ollama') {
    candidateUrls.push(
      `${baseWithoutV1}/v1/models`,
      `${baseWithoutV1}/api/tags`,
      `${baseWithoutV1}/models`
    );
  } else if (upstream.type === 'lemonade') {
    // Lemonade router (port 13305) supports /v1/models, /models, /api/models
    candidateUrls.push(
      `${baseWithoutV1}/v1/models`,
      `${baseWithoutV1}/models`,
      `${baseWithoutV1}/api/models`,
      `${baseWithoutV1}/api/tags`
    );
  } else if (trimmed.endsWith('/v1')) {
    candidateUrls.push(
      `${trimmed}/models`,
      `${baseWithoutV1}/models`,
      `${baseWithoutV1}/api/tags`
    );
  } else {
    candidateUrls.push(
      `${trimmed}/v1/models`,
      `${trimmed}/models`,
      `${trimmed}/api/tags`,
      `${trimmed}/api/models`
    );
  }

  const headers: Record<string, string> = {
    'Accept': 'application/json'
  };
  if (upstream.apiKey) {
    headers['Authorization'] = `Bearer ${upstream.apiKey}`;
    if (upstream.type === 'anthropic' || upstream.endpoint.includes('anthropic.com')) {
      headers['x-api-key'] = upstream.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
  }

  for (const url of candidateUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) continue;

      const data = await res.json();
      const result = parseModelDetails(data);
      if (result.models.length > 0) {
        return result;
      }
    } catch {
      // Continue to next candidate endpoint
    }
  }

  return { models: [], details: [] };
}

export async function detectUpstreamModels(upstream: UpstreamConfig, timeoutMs = 5000): Promise<string[]> {
  const result = await detectUpstreamModelDetails(upstream, timeoutMs);
  return result.models;
}

function parseModelDetails(data: any): UpstreamDiscoveryResult {
  if (!data || typeof data !== 'object') return { models: [], details: [] };

  const details: DiscoveredModel[] = [];
  const modelSet = new Set<string>();

  // Standard OpenAI format: { data: [{ id: "..." }] }
  if (Array.isArray(data.data)) {
    data.data.forEach((item: any) => {
      const id = typeof item === 'string' ? item : item?.id || item?.name || item?.model;
      if (typeof id === 'string' && id.length > 0 && !modelSet.has(id)) {
        modelSet.add(id);
        details.push({
          id,
          name: item?.name || id,
          size: typeof item?.size === 'number' ? `${item.size} GB` : item?.size,
          recipe: item?.recipe,
          ownedBy: item?.owned_by,
          labels: Array.isArray(item?.labels) ? item.labels : undefined,
          contextLength: item?.context_length || item?.max_context_window
        });
      }
    });
  }

  // Ollama format: { models: [{ name: "..." }] }
  if (Array.isArray(data.models)) {
    data.models.forEach((item: any) => {
      const id = typeof item === 'string' ? item : item?.name || item?.id || item?.model;
      if (typeof id === 'string' && id.length > 0 && !modelSet.has(id)) {
        modelSet.add(id);
        const labels: string[] = [];
        if (item?.details?.parameter_size) labels.push(item.details.parameter_size);
        if (item?.details?.quantization_level) labels.push(item.details.quantization_level);
        if (item?.details?.family) labels.push(item.details.family);
        
        details.push({
          id,
          name: id,
          size: typeof item?.size === 'number' ? `${(item.size / (1024 * 1024 * 1024)).toFixed(1)} GB` : undefined,
          recipe: 'ollama',
          labels: labels.length > 0 ? labels : undefined
        });
      }
    });
  }

  // Generic router / gateway fields fallback
  for (const key of ['available_models', 'items', 'routes', 'nodes']) {
    if (Array.isArray(data[key])) {
      data[key].forEach((item: any) => {
        const id = typeof item === 'string' ? item : item?.id || item?.name || item?.model;
        if (typeof id === 'string' && id.length > 0 && !modelSet.has(id)) {
          modelSet.add(id);
          details.push({ id, name: id });
        }
      });
    }
  }

  // Plain array: ["model1", "model2"]
  if (Array.isArray(data)) {
    data.forEach((item: any) => {
      const id = typeof item === 'string' ? item : item?.id || item?.name || item?.model;
      if (typeof id === 'string' && id.length > 0 && !modelSet.has(id)) {
        modelSet.add(id);
        details.push({ id, name: id });
      }
    });
  }

  return {
    models: Array.from(modelSet),
    details
  };
}

export class Eluvix {
  private config: RouterConfig;
  private roundRobinIndex: number = 0;
  private responseCache: Map<string, { response: any; timestamp: number }> = new Map();
  private requestCounts: Map<string, { count: number; resetTime: number }> = new Map();
  private contextProvider: ContextProvider | null = null;

  constructor(config: RouterConfig) {
    this.config = {
      ...config,
      upstreams: [...(config.upstreams || [])].sort((a, b) => b.priority - a.priority)
    };
    if (this.config.memory?.enabled) {
      this.contextProvider = createContextProvider(this.config.memory);
    }
  }

  public getUpstreams(): UpstreamConfig[] {
    return this.config.upstreams;
  }

  public getContextProvider(): ContextProvider | null {
    return this.contextProvider;
  }

  public async detectModels(upstreamId: string, timeoutMs = 5000): Promise<string[]> {
    const upstream = this.config.upstreams.find(u => u.id === upstreamId);
    if (!upstream) {
      throw new Error(`Upstream ${upstreamId} not found`);
    }
    const detected = await detectUpstreamModels(upstream, timeoutMs);
    if (detected.length > 0) {
      upstream.models = detected;
    }
    return detected;
  }

  public async detectAllModels(timeoutMs = 5000): Promise<Record<string, string[]>> {
    const results: Record<string, string[]> = {};
    await Promise.all(
      this.config.upstreams.map(async (u) => {
        try {
          const detected = await detectUpstreamModels(u, timeoutMs);
          if (detected.length > 0) {
            u.models = detected;
            results[u.id] = detected;
          }
        } catch {
          results[u.id] = [];
        }
      })
    );
    return results;
  }

  public async routeChatCompletion(
    request: ChatRequest,
    options?: {
      signal?: AbortSignal;
      scope?: Partial<RequestScope>;
      hops?: number;
    }
  ): Promise<Response> {
    const hops = options?.hops ?? 0;
    if (hops >= 2) {
      throw new Error('Routing loop detected: maximum x-eluvix-hops (2) exceeded.');
    }

    const scope: RequestScope = {
      userId: options?.scope?.userId || request.user || 'default',
      sessionId:
        options?.scope?.sessionId ||
        (typeof request.metadata?.sessionId === 'string' ? request.metadata.sessionId : undefined),
      agentId:
        options?.scope?.agentId ||
        (typeof request.metadata?.agentId === 'string' ? request.metadata.agentId : undefined),
      origin: options?.scope?.origin || 'client'
    };

    let effectiveRequest: ChatRequest = {
      ...request,
      model: request.model || this.config.defaultModel || 'auto'
    };

    // 0a. Privacy Guard Check (PII Detection & Anonymization)
    if (this.config.privacyGuard?.enabled && request.messages) {
      const privacyResult = applyPrivacyGuard(request.messages, {
        enabled: true,
        action: this.config.privacyGuard.action || 'anonymize',
        detectPii: this.config.privacyGuard.detectPii,
        customPatterns: this.config.privacyGuard.customPatterns,
        redactionStyle: this.config.privacyGuard.redactionStyle,
        whitelist: this.config.privacyGuard.whitelist,
        auditLogging: this.config.privacyGuard.auditLogging
      });

      if (!privacyResult.passed) {
        console.warn(`[Privacy Guard Blocked] ${privacyResult.reason}`);
        return new Response(
          JSON.stringify({
            error: {
              message: privacyResult.reason,
              type: 'privacy_guard_violation',
              code: 'pii_leakage_detected'
            }
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      }

      effectiveRequest = {
        ...effectiveRequest,
        messages: privacyResult.modifiedMessages
      };
    }

    // 0b. Pre-Flight Prompt Injection Guard Check
    if (this.config.promptGuard?.enabled && effectiveRequest.messages) {
      const guardResult = validateChatPrompt(effectiveRequest.messages, this.config.promptGuard);
      if (!guardResult.passed) {
        console.warn(`[Prompt Guard Rejected] ${guardResult.reason}`);
        const action = this.config.promptGuard.enforcementAction || (this.config.promptGuard as any).action || 'block';
        if (action === 'warn') {
          console.info(`[Prompt Guard Warning] Proceeding despite match: ${guardResult.matchedRule}`);
        } else if (action === 'strip') {
          console.info(`[Prompt Guard Stripping Threat] ${guardResult.matchedRule}`);
          effectiveRequest = {
            ...effectiveRequest,
            messages: effectiveRequest.messages.map(m => {
              if (typeof m.content === 'string') {
                return { ...m, content: stripPromptThreats(m.content, this.config.promptGuard) };
              } else if (Array.isArray(m.content)) {
                return {
                  ...m,
                  content: m.content.map(p => p.type === 'text' ? { ...p, text: stripPromptThreats(p.text, this.config.promptGuard) } : p)
                };
              }
              return m;
            })
          };
        } else if (action === 'divert') {
          console.info(`[Prompt Guard Diverting] Routing to safe quarantine response: ${guardResult.matchedRule}`);
          return new Response(
            JSON.stringify({
              id: `chatcmpl-diverted-${Date.now()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: effectiveRequest.model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: 'I cannot process this request as it violates prompt safety guidelines. The request has been diverted to quarantine.'
                  },
                  finish_reason: 'stop'
                }
              ],
              usage: {
                prompt_tokens: 0,
                completion_tokens: 20,
                total_tokens: 20
              }
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'x-eluvix-guard': 'diverted',
                'x-eluvix-diverted-reason': guardResult.matchedRule || 'prompt_injection'
              }
            }
          );
        } else {
          return new Response(
            JSON.stringify({
              error: {
                message: `Request blocked by Eluvix Semantic Guard: ${guardResult.reason}`,
                type: 'prompt_injection_violation',
                code: 'content_policy_violation',
                param: guardResult.matchedRule
              }
            }),
            {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            }
          );
        }
      }
    }

    // 0b2. Context / Memory Recall (Pre-Routing Context Injection)
    let memoryTainted = false;
    let memoryStatus = 'disabled';
    let memoryTokens = 0;
    let memoryDigest = '';
    let lastUserQuery = '';

    if (effectiveRequest.messages && effectiveRequest.messages.length > 0) {
      for (let i = effectiveRequest.messages.length - 1; i >= 0; i--) {
        const msg = effectiveRequest.messages[i];
        if (msg.role === 'user') {
          if (typeof msg.content === 'string') {
            lastUserQuery = msg.content;
          } else if (Array.isArray(msg.content)) {
            lastUserQuery = msg.content
              .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
              .map(p => p.text)
              .join('\n');
          }
          if (lastUserQuery) break;
        }
      }
    }

    if (
      this.contextProvider &&
      this.config.memory?.enabled &&
      lastUserQuery.trim().length > 0 &&
      effectiveRequest.messages
    ) {
      try {
        const budgetTokens = this.config.memory.recallBudgetTokens ?? 600;
        const recallResult = await this.contextProvider.recall(
          lastUserQuery,
          scope,
          budgetTokens,
          options?.signal
        );

        let usableBlocks = recallResult.blocks;
        if (usableBlocks.length > 0 && this.config.privacyGuard?.enabled) {
          const scrubbed: typeof usableBlocks = [];
          for (const b of usableBlocks) {
            const check = applyPrivacyGuard([{ role: 'system', content: b.text }], {
              enabled: true,
              action: this.config.privacyGuard.action || 'anonymize',
              detectPii: this.config.privacyGuard.detectPii,
              customPatterns: this.config.privacyGuard.customPatterns,
              redactionStyle: this.config.privacyGuard.redactionStyle,
              whitelist: this.config.privacyGuard.whitelist,
              auditLogging: false
            });
            if (check.passed && check.modifiedMessages[0]) {
              scrubbed.push({
                ...b,
                text:
                  typeof check.modifiedMessages[0].content === 'string'
                    ? check.modifiedMessages[0].content
                    : b.text
              });
            }
          }
          usableBlocks = scrubbed;
        }

        if (usableBlocks.length > 0) {
          const memoryBlock = formatMemorySystemBlock(usableBlocks, recallResult.provider);
          if (memoryBlock) {
            effectiveRequest = {
              ...effectiveRequest,
              messages: injectMemoryIntoMessages(effectiveRequest.messages, memoryBlock)
            };
            memoryTainted = true;
            memoryTokens = Math.ceil(
              usableBlocks.reduce((acc, b) => acc + b.text.length, 0) / 4
            );
            memoryStatus = `${recallResult.provider}:hit(${usableBlocks.length})`;
            memoryDigest = crypto.createHash('sha256').update(memoryBlock).digest('hex').slice(0, 12);
          }
        } else {
          memoryStatus = `${recallResult.provider}:miss`;
        }
      } catch (err) {
        console.warn('[ContextProvider] Memory recall error (failing open):', err);
        memoryStatus = `${this.contextProvider.id}:error`;
      }
    }

    // 0c. Rate Limiting Check
    const rateLimit = this.config.modelGateway?.rateLimits?.maxRpm;
    if (rateLimit && rateLimit > 0) {
      const now = Date.now();
      const windowKey = Math.floor(now / 60000).toString();
      const current = this.requestCounts.get(windowKey) || { count: 0, resetTime: (Math.floor(now / 60000) + 1) * 60000 };
      if (current.count >= rateLimit) {
        return new Response(
          JSON.stringify({
            error: {
              message: `Rate limit of ${rateLimit} RPM exceeded on Model Gateway.`,
              type: 'rate_limit_exceeded',
              code: 'rpm_limit_reached'
            }
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '60'
            }
          }
        );
      }
      this.requestCounts.set(windowKey, { count: current.count + 1, resetTime: current.resetTime });
    }

    // 0d. Semantic / Response Cache Check (scoped by userId + memoryDigest when memory or user scope is active)
    const cacheConfig = this.config.modelGateway?.caching;
    let cacheKey = '';
    if (cacheConfig?.enabled && effectiveRequest.messages) {
      const hasUserOrMemoryScope =
        Boolean(this.config.memory?.enabled) ||
        Boolean(options?.scope?.userId) ||
        Boolean(request.user);
      cacheKey = hasUserOrMemoryScope
        ? `${scope.userId}:${memoryDigest || 'nomem'}:${effectiveRequest.model || 'default'}:${JSON.stringify(effectiveRequest.messages)}`
        : `${effectiveRequest.model || 'default'}:${JSON.stringify(effectiveRequest.messages)}`;
      const cached = this.responseCache.get(cacheKey);
      const ttlMs = (cacheConfig.ttlSeconds ?? 3600) * 1000;
      if (cached && (Date.now() - cached.timestamp < ttlMs)) {
        const hitHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Eluvix-Cache': 'HIT'
        };
        if (this.config.memory?.enabled) {
          hitHeaders['x-eluvix-memory'] = memoryStatus;
          hitHeaders['x-eluvix-memory-tokens'] = String(memoryTokens);
        }
        return new Response(JSON.stringify(cached.response), {
          status: 200,
          headers: hitHeaders
        });
      }
    }

    // 0e. System Prompt Prepend (clone messages to avoid mutating caller's request object)
    if (this.config.modelGateway?.systemPromptPrepend && effectiveRequest.messages) {
      const prepend = this.config.modelGateway.systemPromptPrepend;
      const clonedMessages = effectiveRequest.messages.map(m => ({ ...m }));
      const firstSys = clonedMessages.find(m => m.role === 'system');
      if (firstSys && typeof firstSys.content === 'string') {
        firstSys.content = `${prepend}\n\n${firstSys.content}`;
        effectiveRequest = { ...effectiveRequest, messages: clonedMessages };
      } else {
        effectiveRequest = {
          ...effectiveRequest,
          messages: [{ role: 'system', content: prepend }, ...clonedMessages]
        };
      }
    }

    const selection = this.selectTargetUpstreams(effectiveRequest, {
      scope,
      hops,
      memoryTainted,
      memoryTokens
    });
    effectiveRequest = selection.effectiveRequest;
    const complexity = selection.complexity;
    let targetUpstreams = selection.targetUpstreams;
    const switchyardConfig = this.config.switchyard || {};

    // Latency Spillover Filter
    try {
      const recentLogs = getRequestLogs(50);
      const overloadedUpstreams = new Set<string>();
      const spilloverThreshold = switchyardConfig.spilloverThresholdMs ?? 30000;

      for (const upstream of targetUpstreams) {
        if (
          upstream.type === 'openai-compatible' ||
          upstream.type === 'billama' ||
          upstream.type === 'anthropic' ||
          upstream.type === 'antigravity' ||
          upstream.type === 'harness'
        ) continue; // don't punish cloud or agent reasoning endpoints
        const upstreamLogs = recentLogs.filter(l => l.upstream_id === upstream.id);
        if (upstreamLogs.length >= 3) {
          const avg = upstreamLogs.slice(0, 5).reduce((acc, log) => acc + (log.duration_ms || 0), 0) / Math.min(5, upstreamLogs.length);
          if (avg > spilloverThreshold) {
            console.warn(`[Switchyard] Upstream ${upstream.id} is overloaded (avg latency ${Math.round(avg)}ms > ${spilloverThreshold}ms). Deprioritizing.`);
            overloadedUpstreams.add(upstream.id);
          }
        }
      }

      if (overloadedUpstreams.size > 0 && targetUpstreams.length > 1) {
        // Push overloaded upstreams to the bottom
        targetUpstreams.sort((a, b) => {
          const aOver = overloadedUpstreams.has(a.id) ? 1 : 0;
          const bOver = overloadedUpstreams.has(b.id) ? 1 : 0;
          return aOver - bOver;
        });
      }
    } catch (err) {
      console.warn('Failed to evaluate latency spillover, continuing normal routing.');
    }

    const upstreamTimeout = switchyardConfig.timeoutMs ?? 60000;
    const retryCount = Math.max(1, switchyardConfig.retryCount ?? 1);
    // Failover budget: without a bound, N dead upstreams cost N x
    // upstreamTimeout before the request fails (8 shipped defaults x 60s
    // = 8 minutes). The first attempt always runs; once the budget is
    // exhausted no NEW attempt is started.
    const failoverBudgetMs = switchyardConfig.failoverBudgetMs ?? 120000;
    const routeStartTime = Date.now();
    let attemptsMade = 0;
    let budgetExhausted = false;

    const canRemember =
      Boolean(this.contextProvider) &&
      Boolean(this.config.memory?.enabled) &&
      this.config.memory?.writeBack !== false &&
      lastUserQuery.trim().length > 0;

    // Attempt the highest priority upstream first with retry and budget guardrails
    for (const upstream of targetUpstreams) {
      if (attemptsMade > 0 && Date.now() - routeStartTime >= failoverBudgetMs) {
        console.warn(`[Switchyard] Failover budget of ${failoverBudgetMs}ms exhausted after ${attemptsMade} attempt(s); not trying ${upstream.name} or any later candidate.`);
        budgetExhausted = true;
        break;
      }
      // Check max cost ceiling if configured
      if (switchyardConfig.maxCostPerRequest != null && upstream.costPer1kTokens != null) {
        const estimatedCost = (complexity.tokenEstimate / 1000) * upstream.costPer1kTokens;
        if (estimatedCost > switchyardConfig.maxCostPerRequest && targetUpstreams.length > 1) {
          console.warn(`[Switchyard] Upstream ${upstream.name} estimated cost ($${estimatedCost.toFixed(4)}) exceeds ceiling ($${switchyardConfig.maxCostPerRequest}). Skipping to cheaper candidate.`);
          continue;
        }
      }

      // If memory-tainted and cloudMode === 'strip' and this upstream is non-local, strip <eluvix-memory> before sending
      let requestForUpstream = effectiveRequest;
      let strippedMemoryForCloud = false;
      if (
        memoryTainted &&
        !this.config.memory?.allowCloudEgress &&
        this.config.memory?.cloudMode === 'strip' &&
        !isLocalUpstream(upstream) &&
        effectiveRequest.messages
      ) {
        requestForUpstream = {
          ...effectiveRequest,
          messages: stripMemoryFromMessages(effectiveRequest.messages)
        };
        strippedMemoryForCloud = true;
      }

      for (let attempt = 1; attempt <= retryCount; attempt++) {
        if (attempt > 1 && Date.now() - routeStartTime >= failoverBudgetMs) {
          budgetExhausted = true;
          break;
        }
        attemptsMade++;
        const startTime = Date.now();
        try {
          console.log(`Attempting to route to upstream: ${upstream.name}${retryCount > 1 ? ` (attempt ${attempt}/${retryCount})` : ''}`);
          const response = await this.forwardRequest(
            upstream,
            requestForUpstream,
            upstreamTimeout,
            options?.signal,
            complexity.score,
            scope,
            hops
          );
          const duration_ms = Date.now() - startTime;
          
          if (response.ok) {
            let completionTokens = parseInt(response.headers.get('x-eluvix-completion-tokens') || '0', 10);
            let promptTokens = parseInt(response.headers.get('x-eluvix-prompt-tokens') || '0', 10) || complexity.tokenEstimate;
            const servedModel = response.headers.get('x-eluvix-model') || effectiveRequest.model;
            const effortHeader = response.headers.get('x-eluvix-effort');
            
            let responseBody: any = response.body;
            let assistantOutputText = '';
            if (!effectiveRequest.stream && response.headers.get('content-type')?.includes('application/json')) {
              try {
                const rawData = await response.text();
                const parsed = JSON.parse(rawData);
                if (parsed.usage?.completion_tokens != null) {
                  completionTokens = parsed.usage.completion_tokens;
                }
                if (parsed.usage?.prompt_tokens != null) {
                  promptTokens = parsed.usage.prompt_tokens;
                }
                if (typeof parsed.choices?.[0]?.message?.content === 'string') {
                  assistantOutputText = parsed.choices[0].message.content;
                }
                if (cacheConfig?.enabled && cacheKey) {
                  this.responseCache.set(cacheKey, { response: parsed, timestamp: Date.now() });
                }
                responseBody = new Blob([rawData]).stream();
              } catch {}
            } else if (
              effectiveRequest.stream &&
              responseBody &&
              canRemember &&
              typeof (responseBody as any).getReader === 'function'
            ) {
              const providerRef = this.contextProvider!;
              responseBody = teeSseStreamForMemory(
                responseBody as ReadableStream<Uint8Array>,
                (fullAssistantText) => {
                  void providerRef
                    .remember(
                      {
                        user: { role: 'user', content: lastUserQuery },
                        assistant: fullAssistantText
                      },
                      scope
                    )
                    .catch(() => {});
                }
              );
            }

            if (!effectiveRequest.stream && canRemember && assistantOutputText.trim().length > 0 && this.contextProvider) {
              void this.contextProvider
                .remember(
                  {
                    user: { role: 'user', content: lastUserQuery },
                    assistant: assistantOutputText
                  },
                  scope
                )
                .catch(() => {});
            }

            // Fire and forget logging (for non-streaming or non-agy streaming; agy streaming logs exact tokens on stream completion)
            if (!(effectiveRequest.stream && (upstream.type === 'antigravity' || upstream.endpoint.startsWith('cli://')))) {
              logRequest({
                model: servedModel,
                upstream_id: upstream.id,
                status: response.status,
                duration_ms,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens
              });
            }
            
            const newResponse = new Response(responseBody, {
              status: response.status,
              statusText: response.statusText,
              headers: new Headers(response.headers)
            });
            newResponse.headers.set('x-eluvix-upstream', upstream.id);
            newResponse.headers.set('x-eluvix-model', servedModel);
            newResponse.headers.set('x-eluvix-complexity', complexity.score.toString());
            newResponse.headers.set('x-eluvix-tokens', promptTokens.toString());
            if (effortHeader) {
              newResponse.headers.set('x-eluvix-effort', effortHeader);
            }
            if (this.config.memory?.enabled) {
              newResponse.headers.set(
                'x-eluvix-memory',
                strippedMemoryForCloud ? `${memoryStatus};stripped-for-cloud` : memoryStatus
              );
              newResponse.headers.set('x-eluvix-memory-tokens', String(strippedMemoryForCloud ? 0 : memoryTokens));
            }
            
            return newResponse;
          } else {
            console.warn(`Upstream ${upstream.name} failed with status ${response.status}${retryCount > 1 ? ` (attempt ${attempt}/${retryCount})` : ''}`);
            try {
              await response.text();
            } catch {}
          }
        } catch (err) {
          console.error(`Error connecting to upstream ${upstream.name}${retryCount > 1 ? ` (attempt ${attempt}/${retryCount})` : ''}:`, err);
        }
      }
    }

    if (budgetExhausted) {
      throw new Error(`All upstreams failed to process the request. Failover timed out after ${Date.now() - routeStartTime}ms (budget ${failoverBudgetMs}ms, ${attemptsMade} attempt(s) made); remaining candidates were not tried.`);
    }
    throw new Error('All upstreams failed to process the request.');
  }

  /**
   * Explain how a request would be routed, without executing it: no
   * upstream is contacted and nothing is logged to the request history.
   * Useful for dashboards, debugging "why did my prompt go there?", and
   * previewing a configuration before applying it.
   */
  public explainRoute(
    request: ChatRequest,
    options?: {
      scope?: Partial<RequestScope>;
      hops?: number;
      memoryTainted?: boolean;
      memoryTokens?: number;
    }
  ): RouteExplanation {
    const effectiveRequest: ChatRequest = {
      ...request,
      model: request.model || this.config.defaultModel || 'auto'
    };
    try {
      const selection = this.selectTargetUpstreams(effectiveRequest, {
        silent: true,
        scope: options?.scope,
        hops: options?.hops,
        memoryTainted: options?.memoryTainted,
        memoryTokens: options?.memoryTokens
      });
      return {
        model: effectiveRequest.model,
        strategy: selection.strategy,
        egressPolicy: this.config.egressPolicy,
        complexity: {
          score: selection.complexity.score,
          label: selection.complexity.label,
          tokenEstimate: selection.complexity.tokenEstimate,
          hasImages: !!selection.complexity.hasImages,
          hasTools: !!selection.complexity.hasTools
        },
        steps: selection.steps,
        rankedUpstreams: selection.targetUpstreams.map(u => ({ id: u.id, name: u.name, type: u.type })),
        chosenUpstreamId: selection.targetUpstreams[0]?.id ?? null
      };
    } catch (err: any) {
      return {
        model: effectiveRequest.model,
        strategy: this.config.switchyard?.strategy || this.config.strategy || 'cost-complexity',
        egressPolicy: this.config.egressPolicy,
        complexity: { score: 0, label: 'unknown', tokenEstimate: 0, hasImages: false, hasTools: false },
        steps: err?.routeSteps ?? [],
        rankedUpstreams: [],
        chosenUpstreamId: null,
        error: err?.message || 'Routing failed'
      };
    }
  }

  /**
   * The deterministic core of routing: model matching, loop guard, egress
   * enforcement, memory-egress enforcement, complexity estimation, context
   * truncation, vision/tools filtering, and strategy ranking.
   */
  private selectTargetUpstreams(
    effectiveRequest: ChatRequest,
    options?: {
      silent?: boolean;
      scope?: Partial<RequestScope>;
      hops?: number;
      memoryTainted?: boolean;
      memoryTokens?: number;
    }
  ): {
    effectiveRequest: ChatRequest;
    complexity: PromptComplexityAssessment;
    strategy: RoutingStrategy;
    targetUpstreams: UpstreamConfig[];
    steps: RouteTraceStep[];
  } {
    const steps: RouteTraceStep[] = [];
    const fail = (message: string): never => {
      const err: any = new Error(message);
      err.routeSteps = steps;
      throw err;
    };
    let matchingUpstreams = this.config.upstreams.filter(u =>
      this.matchesModel(u, effectiveRequest.model)
    );
    steps.push({
      stage: 'model-match',
      detail: `model "${effectiveRequest.model}" matched ${matchingUpstreams.length} of ${this.config.upstreams.length} upstreams`,
      kept: matchingUpstreams.map(u => u.id),
      removed: this.config.upstreams.filter(u => !matchingUpstreams.includes(u)).map(u => u.id)
    });

    if (matchingUpstreams.length === 0) {
      fail(`No upstream available for model: ${effectiveRequest.model}`);
    }

    // Loop Guard: requests originating from an agent harness (or with hops > 0)
    // must never route back into another harness upstream, preventing recursive loops.
    const hops = options?.hops ?? 0;
    const isHarnessOrigin = options?.scope?.origin === 'harness' || hops > 0;
    if (isHarnessOrigin) {
      const nonHarness = matchingUpstreams.filter(u => u.type !== 'harness' && !u.endpoint.startsWith('acp://'));
      const removedHarness = matchingUpstreams.filter(u => u.type === 'harness' || u.endpoint.startsWith('acp://'));
      if (removedHarness.length > 0) {
        steps.push({
          stage: 'loop-guard',
          detail: `origin=${options?.scope?.origin || 'client'} (hops=${hops}): excluded agent harness upstreams to prevent recursive routing loops`,
          kept: nonHarness.map(u => u.id),
          removed: removedHarness.map(u => u.id)
        });
      }
      if (nonHarness.length === 0) {
        fail(`No non-harness upstream available for model: ${effectiveRequest.model} (loop-guard excluded harness upstreams)`);
      }
      matchingUpstreams = nonHarness;
    }

    // Egress policy enforcement: a local-only configuration must never send
    // prompts to external services — not as the primary pick, and not as a
    // fallback when the local engines are down. Fail closed instead.
    if (this.config.egressPolicy === 'local-only') {
      const localUpstreams = matchingUpstreams.filter(u => isLocalUpstream(u));
      const excluded = matchingUpstreams.filter(u => !isLocalUpstream(u));
      if (excluded.length > 0) {
        console.warn(`[Switchyard Egress] egressPolicy=local-only excluded non-local upstreams: ${excluded.map(u => u.id).join(', ')}`);
      }
      steps.push({
        stage: 'egress-policy',
        detail: 'egressPolicy=local-only: only local upstreams may serve this request',
        kept: localUpstreams.map(u => u.id),
        removed: excluded.map(u => u.id)
      });
      if (localUpstreams.length === 0) {
        fail(`No local upstream available for model: ${effectiveRequest.model} (egressPolicy: local-only)`);
      }
      matchingUpstreams = localUpstreams;
    }

    // Memory-Taint Egress Guard: when recalled personal/workspace memories are injected,
    // prevent silent exfiltration to cloud upstreams unless allowCloudEgress=true.
    if (options?.memoryTainted && !this.config.memory?.allowCloudEgress) {
      const cloudMode = this.config.memory?.cloudMode || 'filter';
      if (cloudMode === 'strip') {
        steps.push({
          stage: 'memory-egress',
          detail: 'memory-tainted request with cloudMode=strip: <eluvix-memory> block will be stripped before forwarding to non-local upstreams',
          kept: matchingUpstreams.map(u => u.id),
          removed: []
        });
      } else {
        const localOnly = matchingUpstreams.filter(u => isLocalUpstream(u));
        const removedCloud = matchingUpstreams.filter(u => !isLocalUpstream(u));
        steps.push({
          stage: 'memory-egress',
          detail: 'memory-tainted request with allowCloudEgress=false (cloudMode=filter): only local upstreams may receive recalled memories',
          kept: localOnly.map(u => u.id),
          removed: removedCloud.map(u => u.id)
        });
        if (localOnly.length === 0) {
          fail(`No local upstream available to serve memory-tainted request for model: ${effectiveRequest.model} (memory.allowCloudEgress=false)`);
        }
        matchingUpstreams = localOnly;
      }
    }

    const switchyardConfig = this.config.switchyard || {};
    const strategy: RoutingStrategy = switchyardConfig.strategy || this.config.strategy || 'cost-complexity';
    const hasTools = Array.isArray(effectiveRequest.tools) && effectiveRequest.tools.length > 0;
    const toolsCount = hasTools ? effectiveRequest.tools!.length : 0;
    // Evaluate complexity on the user prompt WITHOUT the injected <eluvix-memory> block
    // so recalled memories do not artificially escalate simple prompts to expensive frontier models.
    const messagesWithoutMemory = stripMemoryFromMessages(effectiveRequest.messages || []);
    const complexity = estimatePromptComplexity(messagesWithoutMemory, {
      ...switchyardConfig.complexityThresholds,
      codeEscalation: switchyardConfig.codeEscalation,
      hasTools,
      toolsCount
    });
    if (options?.memoryTokens && options.memoryTokens > 0) {
      complexity.tokenEstimate += options.memoryTokens;
    }
    if (!options?.silent) console.log(
      `[Switchyard Balancer] Routing Strategy: ${strategy} | Prompt Complexity: Score ${complexity.score} (${complexity.label}, tokens ~${complexity.tokenEstimate}, features: [${complexity.features.join(', ')}])`
    );

    // Context Truncation Logic: Only truncate for small local-only pools where no frontier/large-context upstream exists
    const MAX_LOCAL_TOKENS = 8000;
    const hasLargeContextUpstream = matchingUpstreams.some(
      u =>
        (u.maxComplexityScore ?? 2) >= 4 ||
        u.type === 'antigravity' ||
        u.type === 'harness' ||
        u.type === 'openai-compatible' ||
        u.type === 'anthropic' ||
        u.type === 'billama'
    );
    if (!hasLargeContextUpstream && complexity.tokenEstimate > MAX_LOCAL_TOKENS && effectiveRequest.messages) {
      console.warn(`[Switchyard] Local context window exceeded (${complexity.tokenEstimate} > ${MAX_LOCAL_TOKENS}). Truncating...`);
      const msgs = effectiveRequest.messages;
      if (msgs.length > 3) {
        effectiveRequest = {
          ...effectiveRequest,
          messages: [
            msgs[0],
            { role: 'system', content: '[System Note: Middle conversation history truncated to preserve context window]' },
            ...msgs.slice(-2)
          ]
        };
        const newComplexity = estimatePromptComplexity(stripMemoryFromMessages(effectiveRequest.messages), {
          ...switchyardConfig.complexityThresholds,
          codeEscalation: switchyardConfig.codeEscalation,
          hasTools,
          toolsCount
        });
        complexity.tokenEstimate = newComplexity.tokenEstimate + (options?.memoryTokens || 0);
      }
    }

    let targetUpstreams = [...matchingUpstreams];

    if (complexity.hasImages) {
      const beforeVision = targetUpstreams;
      targetUpstreams = targetUpstreams.filter(u => isVisionCapableUpstream(u));
      steps.push({
        stage: 'vision-filter',
        detail: 'request contains images: only vision-capable upstreams (explicit capability, vision-capable provider type, or vision model) may serve it',
        kept: targetUpstreams.map(u => u.id),
        removed: beforeVision.filter(u => !targetUpstreams.includes(u)).map(u => u.id)
      });
      if (targetUpstreams.length === 0) {
        fail(`No upstream available for model: ${effectiveRequest.model} with vision capability.`);
      }
    }

    if (complexity.hasTools) {
      const toolCapable = targetUpstreams.filter(u =>
        u.capabilities?.includes('tool-calling') ||
        u.capabilities?.includes('tools') ||
        u.type === 'antigravity' ||
        u.type === 'harness' ||
        u.type === 'openai-compatible' ||
        u.type === 'anthropic' ||
        (Array.isArray(u.models) && u.models.some(m => /qwen|coder|tool|gemini|claude|gpt-4|gpt-oss/i.test(m)))
      );
      if (toolCapable.length > 0) {
        steps.push({
          stage: 'tools-filter',
          detail: 'request uses tools: preferring tool-capable upstreams',
          kept: toolCapable.map(u => u.id),
          removed: targetUpstreams.filter(u => !toolCapable.includes(u)).map(u => u.id)
        });
        targetUpstreams = toolCapable;
      }
    }

    const hasExactModelMatch = (u: UpstreamConfig, model: string): number => {
      if (u.models?.includes(model)) return 1;
      if ((u.type === 'antigravity' || u.endpoint?.startsWith('cli://')) && isAntigravitySupportedModel(model, u.models)) {
        return 1;
      }
      if (u.type === 'harness' && u.harness?.kind && model === `harness/${u.harness.kind}`) {
        return 1;
      }
      return 0;
    };

    if (strategy === 'cost-complexity') {
      targetUpstreams.sort((a, b) => {
        // 0. Exact model match takes precedence over wildcard '*' match
        if (effectiveRequest.model !== 'auto') {
          const exactA = hasExactModelMatch(a, effectiveRequest.model);
          const exactB = hasExactModelMatch(b, effectiveRequest.model);
          if (exactA !== exactB) {
            return exactB - exactA;
          }
        }

        // Evaluate capability score (local engines default to 2-3, cloud/harness gateways default to 4)
        const capA = a.maxComplexityScore ?? (a.type === 'openai-compatible' || a.type === 'billama' || a.type === 'antigravity' || a.type === 'harness' ? 4 : 2);
        const capB = b.maxComplexityScore ?? (b.type === 'openai-compatible' || b.type === 'billama' || b.type === 'antigravity' || b.type === 'harness' ? 4 : 2);

        const capableA = capA >= complexity.score ? 1 : 0;
        const capableB = capB >= complexity.score ? 1 : 0;

        // 1. Capable upstreams come first
        if (capableA !== capableB) {
          return capableB - capableA;
        }

        // 2. Lowest cost per 1k tokens first ($0 local engines prioritized)
        const costA = a.costPer1kTokens ?? (a.type === 'openai-compatible' || a.type === 'billama' ? 0.005 : 0);
        const costB = b.costPer1kTokens ?? (b.type === 'openai-compatible' || b.type === 'billama' ? 0.005 : 0);
        if (costA !== costB) {
          return costA - costB;
        }

        // 3. Tie-breaker by priority
        return b.priority - a.priority;
      });
    } else if (strategy === 'lowest-cost') {
      targetUpstreams.sort((a, b) => {
        if (effectiveRequest.model !== 'auto') {
          const exactA = hasExactModelMatch(a, effectiveRequest.model);
          const exactB = hasExactModelMatch(b, effectiveRequest.model);
          if (exactA !== exactB) return exactB - exactA;
        }
        const costA = a.costPer1kTokens ?? (a.type === 'openai-compatible' || a.type === 'billama' ? 0.005 : 0);
        const costB = b.costPer1kTokens ?? (b.type === 'openai-compatible' || b.type === 'billama' ? 0.005 : 0);
        if (costA !== costB) return costA - costB;
        return b.priority - a.priority;
      });
    } else if (strategy === 'cascade-cost') {
      targetUpstreams.sort((a, b) => {
        if (effectiveRequest.model !== 'auto') {
          const exactA = hasExactModelMatch(a, effectiveRequest.model);
          const exactB = hasExactModelMatch(b, effectiveRequest.model);
          if (exactA !== exactB) return exactB - exactA;
        }
        const tierOrderA = a.tier ? parseInt(a.tier.replace(/\D/g, ''), 10) || 99 : 99;
        const tierOrderB = b.tier ? parseInt(b.tier.replace(/\D/g, ''), 10) || 99 : 99;
        if (tierOrderA !== tierOrderB) return tierOrderA - tierOrderB;

        const costA = a.costPer1kTokens ?? 0;
        const costB = b.costPer1kTokens ?? 0;
        if (costA !== costB) return costA - costB;

        return b.priority - a.priority;
      });
    } else if (strategy === 'lowest-latency') {
      targetUpstreams.sort((a, b) => {
        if (effectiveRequest.model !== 'auto') {
          const exactA = hasExactModelMatch(a, effectiveRequest.model);
          const exactB = hasExactModelMatch(b, effectiveRequest.model);
          if (exactA !== exactB) return exactB - exactA;
        }
        const latA = a.latencyMs ?? (a.type === 'openai-compatible' || a.type === 'billama' ? 500 : 25);
        const latB = b.latencyMs ?? (b.type === 'openai-compatible' || b.type === 'billama' ? 500 : 25);
        if (latA !== latB) return latA - latB;
        return b.priority - a.priority;
      });
    } else if (strategy === 'round-robin') {
      const idx = this.roundRobinIndex % targetUpstreams.length;
      this.roundRobinIndex++;
      targetUpstreams = [...targetUpstreams.slice(idx), ...targetUpstreams.slice(0, idx)];
    } else {
      targetUpstreams.sort((a, b) => {
        if (effectiveRequest.model !== 'auto') {
          const exactA = hasExactModelMatch(a, effectiveRequest.model);
          const exactB = hasExactModelMatch(b, effectiveRequest.model);
          if (exactA !== exactB) return exactB - exactA;
        }
        return b.priority - a.priority;
      });
    }

    steps.push({
      stage: 'ranking',
      detail: `strategy "${strategy}" ranked the surviving upstreams; the first is tried first, the rest are failover order`,
      kept: targetUpstreams.map(u => u.id)
    });
    return { effectiveRequest, complexity, strategy, targetUpstreams, steps };
  }

  public matchesModel(upstream: UpstreamConfig, requestedModel: string): boolean {
    if (!upstream || !Array.isArray(upstream.models)) return false;
    if (requestedModel === 'auto') return upstream.models.length > 0;
    if (upstream.models.includes(requestedModel)) return true;
    if (upstream.type === 'harness' && upstream.harness?.kind && requestedModel === `harness/${upstream.harness.kind}`) {
      return true;
    }
    if (upstream.type === 'antigravity' || upstream.endpoint?.startsWith('cli://')) {
      return isAntigravitySupportedModel(requestedModel, upstream.models);
    }
    if (upstream.models.includes('*')) {
      // Local inference engines shouldn't greedily capture explicit cloud/agent/harness models
      if (['lemonade', 'ollama', 'vllm', 'vllm-sr', 'switchyard'].includes(upstream.type)) {
        if (/^(gemini-|claude-|gpt-oss-120b|harness\/)/i.test(requestedModel)) return false;
      }
      return true;
    }
    return false;
  }

  private async forwardRequest(
    upstream: UpstreamConfig,
    request: ChatRequest,
    timeoutMs = 60000,
    clientSignal?: AbortSignal,
    complexityScore: 1 | 2 | 3 | 4 = 1,
    scope?: RequestScope,
    hops = 0
  ): Promise<Response> {
    // Translate 'auto' to a concrete model that this upstream supports
    let effectiveModel = request.model;
    if (request.model === 'auto') {
      const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
      if (hasTools) {
        effectiveModel = upstream.models.find(m =>
          m !== '*' && m !== 'auto' && /qwen|coder|tool|gemini|claude|gpt-4|gpt-oss/i.test(m)
        ) || upstream.models.find(m => m !== '*' && m !== 'auto') || upstream.antigravity?.model || 'default';
      } else {
        effectiveModel = upstream.models.find(m => m !== '*' && m !== 'auto') || upstream.antigravity?.model || 'default';
      }
    } else if (upstream.type === 'antigravity' || upstream.endpoint.startsWith('cli://')) {
      if (!isAntigravitySupportedModel(request.model, upstream.models)) {
        effectiveModel = upstream.antigravity?.model || 'gemini-4-argon';
      }
    }
    const effectiveRequest: ChatRequest = {
      ...request,
      model: effectiveModel
    };

    if (upstream.type === 'harness' || upstream.endpoint.startsWith('acp://')) {
      return forwardHarnessRequest(upstream, effectiveRequest, timeoutMs, clientSignal, scope, hops);
    }

    if (upstream.type === 'antigravity' || upstream.endpoint.startsWith('cli://')) {
      return this.forwardAntigravityCli(upstream, effectiveRequest, complexityScore, clientSignal, timeoutMs);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    
    if (upstream.apiKey) {
      headers['Authorization'] = `Bearer ${upstream.apiKey}`;
      if (upstream.type === 'anthropic' || upstream.endpoint.includes('anthropic.com')) {
        headers['x-api-key'] = upstream.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      }
    }

    // Clean trailing slashes and ensure OpenAI-compatible completion path
    const trimmed = upstream.endpoint.trim().replace(/\/+$/, '');
    const url = trimmed.endsWith('/v1')
      ? `${trimmed}/chat/completions`
      : `${trimmed}/v1/chat/completions`;

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(effectiveRequest)
    };

    const controller = new AbortController();
    let timeoutTimer: NodeJS.Timeout | null = null;

    const resetTimeout = (ms: number, reason: string) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      timeoutTimer = setTimeout(() => {
        controller.abort(new DOMException(reason, 'TimeoutError'));
      }, ms);
    };

    if (clientSignal) {
      if (clientSignal.aborted) {
        throw new DOMException('Client aborted request', 'AbortError');
      }
      clientSignal.addEventListener('abort', () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        controller.abort(clientSignal.reason || new DOMException('Client aborted request', 'AbortError'));
      }, { once: true });
    }

    // Initial connection / TTFT timeout
    resetTimeout(timeoutMs, `Connection or first token timed out after ${timeoutMs}ms`);

    try {
      const res = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal
      });

      if (!res.ok) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        return res;
      }

      // If streaming, verify that the upstream can produce the first chunk before returning
      // This enables transparent Switchyard failover if an upstream accepts headers but hangs during TTFT
      if (effectiveRequest.stream && res.body && typeof (res.body as any).getReader === 'function') {
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const firstRead = await reader.read();

        if (firstRead.done) {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          throw new Error(`Upstream ${upstream.name} closed stream before producing any tokens`);
        }

        // Successfully received first chunk!
        const idleTimeoutMs = Math.max(60000, timeoutMs);
        const stream = new ReadableStream({
          async start(streamController) {
            // Deliver the first chunk
            streamController.enqueue(firstRead.value);

            try {
              while (true) {
                resetTimeout(idleTimeoutMs, `Stream idle timeout (${idleTimeoutMs}ms with no chunks)`);
                const { done, value } = await reader.read();
                if (done) {
                  if (timeoutTimer) clearTimeout(timeoutTimer);
                  streamController.close();
                  break;
                }
                streamController.enqueue(value);
              }
            } catch (err) {
              if (timeoutTimer) clearTimeout(timeoutTimer);
              streamController.error(err);
            }
          },
          cancel(reason) {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            reader.cancel(reason).catch(() => {});
            controller.abort(reason);
          }
        });

        const resHeaders = new Headers(res.headers);
        resHeaders.set('x-eluvix-model', effectiveModel);
        return new Response(stream, {
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders
        });
      }

      // Non-streaming response: clear timeout once headers and body are ready
      if (timeoutTimer) clearTimeout(timeoutTimer);

      const resHeaders = new Headers(res.headers);
      resHeaders.set('x-eluvix-model', effectiveModel);
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: resHeaders
      });
    } catch (err) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      throw err;
    }
  }

  private async forwardAntigravityCli(
    upstream: UpstreamConfig,
    request: ChatRequest,
    complexityScore: 1 | 2 | 3 | 4 = 1,
    clientSignal?: AbortSignal,
    upstreamTimeoutMs = 60000
  ): Promise<Response> {
    const startTime = Date.now();
    const rawCli = (upstream.antigravity?.cliPath || 'agy').trim();
    const baseCli = path.basename(rawCli);
    if (!['agy', 'antigravity'].includes(baseCli)) {
      throw new Error(`Execution denied: '${baseCli}' is not an authorized Antigravity CLI binary.`);
    }
    const cliPath = rawCli;

    const isAgyModel = isAntigravitySupportedModel(request.model, upstream.models);
    const requestedModel = isAgyModel ? request.model : (upstream.antigravity?.model || 'gemini-4-argon');
    const { baseModel: model, effort } = resolveAntigravityEffort(
      requestedModel,
      upstream.antigravity?.effort,
      complexityScore
    );

    // Working directory isolation
    const homeDir = os.homedir();
    const defaultWorkspace = path.join(homeDir, '.eluvix', 'workspace');
    const workingDir = upstream.antigravity?.cwd || defaultWorkspace;
    try {
      if (!fs.existsSync(workingDir)) {
        fs.mkdirSync(workingDir, { recursive: true });
      }
    } catch {}

    // Clean Headless Mode: isolate .gemini config to prevent IDE plugin SessionStart hooks & 28k token bloat
    const useCleanHeadless = upstream.antigravity?.cleanHeadless !== false;
    const effectiveHome = useCleanHeadless ? prepareCleanAgyHome(homeDir) : homeDir;

    // Build prompt with system instructions preserved and byte budgeting under 100KB
    const promptText = buildCliPrompt(request.messages || [], 100000);

    const printTimeoutSec = Math.max(15, Math.floor(upstreamTimeoutMs / 1000));
    const processTimeoutMs = Math.max(20000, upstreamTimeoutMs + 5000);

    const args: string[] = [
      '--disable-slash-commands',
      '--print-timeout',
      `${printTimeoutSec}s`,
      '--output-format',
      'stream-json'
    ];
    if (upstream.antigravity?.dangerouslySkipPermissions === true) {
      args.push('--dangerously-skip-permissions');
    }
    if (model && model !== 'default') {
      args.push('--model', model);
      args.push('--effort', effort);
    }
    // Always enforce sandbox execution
    args.push('--sandbox');
    args.push('--print', promptText);

    const childEnv = {
      ...process.env,
      HOME: effectiveHome
    };

    // Real-time SSE Streaming Mode
    if (request.stream) {
      return new Promise((resolve) => {
        const child = spawn(cliPath, args, {
          cwd: workingDir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true
        });

        let resolvedInitial = false;
        let streamClosed = false;
        let emittedDelta = false;
        let killTimer: NodeJS.Timeout | null = null;
        const timeoutMs = processTimeoutMs;
        const completionId = `chatcmpl-agy-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const encoder = new TextEncoder();
        let streamControllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

        const killProcessGroup = () => {
          try {
            if (child.pid) {
              process.kill(-child.pid, 'SIGTERM');
              killTimer = setTimeout(() => {
                try {
                  if (child.pid) process.kill(-child.pid, 'SIGKILL');
                } catch {}
              }, 2000);
            }
          } catch {}
        };

        if (clientSignal) {
          clientSignal.addEventListener('abort', () => {
            clearTimeout(timer);
            if (killTimer) clearTimeout(killTimer);
            killProcessGroup();
            if (!resolvedInitial) {
              resolvedInitial = true;
              resolve(new Response(JSON.stringify({
                error: {
                  message: 'Client aborted request',
                  type: 'client_closed_request',
                  code: 'request_cancelled'
                }
              }), { status: 499, headers: { 'Content-Type': 'application/json' } }));
            } else if (!streamClosed && streamControllerRef) {
              streamClosed = true;
              try { streamControllerRef.close(); } catch {}
            }
          }, { once: true });
        }

        const timer = setTimeout(() => {
          if (!resolvedInitial) {
            resolvedInitial = true;
            killProcessGroup();
            resolve(new Response(JSON.stringify({
              error: {
                message: `agy CLI execution timed out after ${timeoutMs / 1000}s`,
                type: 'timeout_error',
                code: 'gateway_timeout'
              }
            }), { status: 504, headers: { 'Content-Type': 'application/json' } }));
          } else if (!streamClosed && streamControllerRef) {
            streamClosed = true;
            killProcessGroup();
            try { streamControllerRef.close(); } catch {}
          }
        }, timeoutMs);

        let lineBuffer = '';
        let rawStdout = '';
        let stderr = '';
        let exactPromptTokens = Math.ceil(promptText.length / 4);
        let exactCompletionTokens = 0;

        const ensureStreamStarted = () => {
          if (resolvedInitial) return;
          resolvedInitial = true;
          const sseStream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamControllerRef = controller;
              const roleChunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                  index: 0,
                  delta: { role: 'assistant', content: '' },
                  finish_reason: null
                }]
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));
            },
            cancel() {
              streamClosed = true;
              clearTimeout(timer);
              killProcessGroup();
            }
          });

          resolve(new Response(sseStream, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              'Connection': 'keep-alive',
              'x-eluvix-model': model,
              'x-eluvix-effort': effort
            }
          }));
        };

        const enqueueContentDelta = (text: string) => {
          if (!text || streamClosed || !streamControllerRef) return;
          emittedDelta = true;
          const deltaChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: { content: text },
              finish_reason: null
            }]
          };
          streamControllerRef.enqueue(encoder.encode(`data: ${JSON.stringify(deltaChunk)}\n\n`));
        };

        const processLine = (line: string) => {
          const ev = parseAgyStreamJsonLine(line);
          if (ev.type === 'delta' && ev.textDelta) {
            ensureStreamStarted();
            enqueueContentDelta(ev.textDelta);
          } else if (ev.type === 'result') {
            if (ev.usage) {
              exactPromptTokens = ev.usage.prompt_tokens;
              exactCompletionTokens = ev.usage.completion_tokens;
            }
            if (ev.status && ev.status.toUpperCase() === 'ERROR') {
              return;
            }
            ensureStreamStarted();
            if (!emittedDelta && ev.response) {
              enqueueContentDelta(ev.response);
            }
          }
        };

        child.stdout.on('data', (chunk) => {
          const str = chunk.toString();
          rawStdout += str;
          lineBuffer += str;
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop() || '';
          for (const line of lines) {
            processLine(line);
          }
        });

        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          killProcessGroup();
          if (!resolvedInitial) {
            resolvedInitial = true;
            resolve(new Response(JSON.stringify({
              error: {
                message: `Failed to execute agy CLI (${cliPath}): ${err.message}`,
                type: 'antigravity_cli_error'
              }
            }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
          } else if (!streamClosed && streamControllerRef) {
            streamClosed = true;
            try { streamControllerRef.close(); } catch {}
          }
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          try {
            if (child.pid) process.kill(-child.pid, 'SIGTERM');
          } catch {}

          if (lineBuffer.trim()) {
            processLine(lineBuffer);
            lineBuffer = '';
          }

          if (!resolvedInitial) {
            const cleanStdout = rawStdout.trim();
            if (code === 0 && cleanStdout) {
              ensureStreamStarted();
              enqueueContentDelta(cleanStdout);
            } else {
              resolvedInitial = true;
              const errDetail = stderr.trim() || `Process exited with code ${code}`;
              resolve(new Response(JSON.stringify({
                error: {
                  message: `agy CLI exited with code ${code}: ${errDetail}`,
                  type: 'antigravity_cli_error'
                }
              }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
              return;
            }
          }

          if (!streamClosed && streamControllerRef) {
            streamClosed = true;
            const stopChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: 'stop'
              }],
              usage: {
                prompt_tokens: exactPromptTokens,
                completion_tokens: exactCompletionTokens,
                total_tokens: exactPromptTokens + exactCompletionTokens
              }
            };
            try {
              streamControllerRef.enqueue(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
              streamControllerRef.enqueue(encoder.encode('data: [DONE]\n\n'));
              streamControllerRef.close();
            } catch {}
          }

          logRequest({
            model,
            upstream_id: upstream.id,
            status: code === 0 ? 200 : 502,
            duration_ms: Date.now() - startTime,
            prompt_tokens: exactPromptTokens,
            completion_tokens: exactCompletionTokens
          });
        });
      });
    }

    // Non-Streaming Execution Mode (parses stream-json for exact response & token telemetry)
    return new Promise((resolve) => {
      const child = spawn(cliPath, args, {
        cwd: workingDir,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
      });

      let resolved = false;
      let killTimer: NodeJS.Timeout | null = null;
      const timeoutMs = processTimeoutMs;

      const killProcessGroup = () => {
        try {
          if (child.pid) {
            process.kill(-child.pid, 'SIGTERM');
            killTimer = setTimeout(() => {
              try {
                if (child.pid) process.kill(-child.pid, 'SIGKILL');
              } catch {}
            }, 2000);
          }
        } catch {}
      };

      if (clientSignal) {
        clientSignal.addEventListener('abort', () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          killProcessGroup();
          resolve(new Response(JSON.stringify({
            error: {
              message: 'Client aborted request',
              type: 'client_closed_request',
              code: 'request_cancelled'
            }
          }), { status: 499, headers: { 'Content-Type': 'application/json' } }));
        }, { once: true });
      }

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          killProcessGroup();
          resolve(new Response(JSON.stringify({
            error: {
              message: `agy CLI execution timed out after ${timeoutMs / 1000}s`,
              type: 'timeout_error',
              code: 'gateway_timeout'
            }
          }), { status: 504, headers: { 'Content-Type': 'application/json' } }));
        }
      }, timeoutMs);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });

      child.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        killProcessGroup();
        resolve(new Response(JSON.stringify({
          error: {
            message: `Failed to execute agy CLI (${cliPath}): ${err.message}`,
            type: 'antigravity_cli_error'
          }
        }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
      });

      child.on('close', (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        try {
          if (child.pid) process.kill(-child.pid, 'SIGTERM');
        } catch {}

        const cleanStdout = stdout.trim();
        const cleanStderr = stderr.trim();

        if (code !== 0 || (!cleanStdout && cleanStderr)) {
          const errDetail = cleanStderr || `Process exited with code ${code}`;
          resolve(new Response(JSON.stringify({
            error: {
              message: `agy CLI exited with code ${code}: ${errDetail}`,
              type: 'antigravity_cli_error'
            }
          }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
          return;
        }

        // Parse stream-json NDJSON lines if present, with plain text fallback
        let deltaAccumulated = '';
        let finalResultText: string | undefined;
        let exactUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
        const plainLines: string[] = [];

        for (const line of cleanStdout.split('\n')) {
          const ev = parseAgyStreamJsonLine(line);
          if (ev.type === 'delta' && ev.textDelta) {
            deltaAccumulated += ev.textDelta;
          } else if (ev.type === 'result') {
            if (ev.response !== undefined) {
              finalResultText = ev.response.trim();
            }
            if (ev.usage) {
              exactUsage = {
                prompt_tokens: ev.usage.prompt_tokens,
                completion_tokens: ev.usage.completion_tokens,
                total_tokens: ev.usage.total_tokens
              };
            }
          } else if (ev.type === 'ignore' && !line.trim().startsWith('{')) {
            plainLines.push(line);
          }
        }

        const responseContent =
          finalResultText ??
          (deltaAccumulated.trim() || plainLines.join('\n').trim() || cleanStderr);

        const usage = exactUsage || {
          prompt_tokens: Math.ceil(promptText.length / 4),
          completion_tokens: Math.ceil(responseContent.length / 4),
          total_tokens: Math.ceil((promptText.length + responseContent.length) / 4)
        };

        const payload = {
          id: `chatcmpl-agy-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: responseContent
              },
              finish_reason: 'stop'
            }
          ],
          usage
        };

        resolve(new Response(JSON.stringify(payload), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'x-eluvix-model': model,
            'x-eluvix-effort': effort,
            'x-eluvix-prompt-tokens': usage.prompt_tokens.toString(),
            'x-eluvix-completion-tokens': usage.completion_tokens.toString()
          }
        }));
      });
    });
  }
}

export function isAntigravitySupportedModel(modelName: string, upstreamModels: string[] = []): boolean {
  if (!modelName || modelName === 'auto') return false;
  if (upstreamModels.includes(modelName)) return true;

  // Reject explicitly retired Google Gemini models (3.1, 3.6, 3.7, 2.5)
  if (/^gemini-(?:3\.1|3\.6|3\.7|2\.5)/i.test(modelName)) return false;

  // Check dynamically discovered / cached Antigravity catalog
  const catalog = getCachedAntigravityModels();
  const lower = modelName.toLowerCase();
  for (const entry of catalog) {
    if (entry.baseId.toLowerCase() === lower) return true;
    if (entry.variants.some(v => v.toLowerCase() === lower)) return true;
  }

  // Gemini models: gemini-4-argon (and variants: gemini-4-argo, gemini-4-argon-high/medium/low), gemini-3.8-flash (and variants)
  if (/^gemini-(?:4-argon|4-argo|3\.8)/i.test(modelName)) return true;
  // Claude models supported by Antigravity: claude-opus-5-5, claude-sonnet-5-5
  if (/^claude-(?:opus|sonnet)/i.test(modelName)) return true;
  // GPT-OSS: only 120b
  if (/^gpt-oss-120b/i.test(modelName)) return true;
  return false;
}

export function buildCliPrompt(messages: ChatMessage[], maxBytes = 100000): string {
  if (!messages || messages.length === 0) return 'Hello';

  const systemParts: string[] = [];
  const conversationTurns: { role: string; text: string }[] = [];

  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (m.role && m.role.toLowerCase() === 'system') {
      systemParts.push(`[SYSTEM]: ${text}`);
    } else {
      conversationTurns.push({ role: (m.role || 'user').toUpperCase(), text });
    }
  }

  const systemBlock = systemParts.join('\n\n');
  const systemBytes = Buffer.byteLength(systemBlock, 'utf8');

  // If system instructions alone exceed maxBytes, truncate system instructions by bytes
  if (systemBytes >= maxBytes - 1000) {
    const buf = Buffer.from(systemBlock, 'utf8');
    return buf.subarray(0, maxBytes - 100).toString('utf8') + '\n\n[System truncated]';
  }

  const remainingBudget = maxBytes - (systemBytes > 0 ? systemBytes + 2 : 0);
  const includedTurns: string[] = [];
  let currentBytes = 0;
  let omittedTurns = false;

  for (let i = conversationTurns.length - 1; i >= 0; i--) {
    const turn = `[${conversationTurns[i].role}]: ${conversationTurns[i].text}`;
    const turnBytes = Buffer.byteLength(turn, 'utf8') + 2;
    if (currentBytes + turnBytes <= remainingBudget) {
      includedTurns.unshift(turn);
      currentBytes += turnBytes;
    } else {
      omittedTurns = true;
      break;
    }
  }

  const parts: string[] = [];
  if (systemBlock) {
    parts.push(systemBlock);
  }
  if (omittedTurns) {
    parts.push('[Eluvix Note: Prior conversation history omitted to stay within argument limit]');
  }
  if (includedTurns.length > 0) {
    parts.push(includedTurns.join('\n\n'));
  }

  return parts.join('\n\n');
}

export { Eluvix as LibreRouter, Eluvix as NodeRouter };
