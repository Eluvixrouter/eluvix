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

export interface RouterConfig {
  upstreams: UpstreamConfig[];
  defaultModel?: string;
  strategy?: RoutingStrategy;
  fallbackStrategy?: 'round-robin' | 'priority';
  switchyard?: SwitchyardConfig;
  modelGateway?: ModelGatewayConfig;
  promptGuard?: PromptGuardConfig & { action?: 'block' | 'strip' | 'divert' | 'warn' };
  privacyGuard?: PrivacyGuardConfig;
}

export * from './paths.js';
export * from './db.js';
export * from './tls.js';
export * from './guard.js';
export * from './auth.js';
import { spawn } from 'node:child_process';
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
import { validateChatPrompt, applyPrivacyGuard } from './guard.js';

export type UpstreamType = 
  | 'openai-compatible'
  | 'billama'
  | 'anthropic'
  | 'vllm-sr'
  | 'vllm'
  | 'switchyard'
  | 'ollama'
  | 'lemonade'
  | 'antigravity';

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
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
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

  constructor(config: RouterConfig) {
    this.config = config;
    // Default sort upstreams by priority
    this.config.upstreams.sort((a, b) => b.priority - a.priority);
  }

  public getUpstreams(): UpstreamConfig[] {
    return this.config.upstreams;
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

  public async routeChatCompletion(request: ChatRequest, options?: { signal?: AbortSignal }): Promise<Response> {
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
        ...request,
        messages: privacyResult.modifiedMessages
      };
    }

    // 0b. Pre-Flight Prompt Injection Guard Check
    if (this.config.promptGuard?.enabled && effectiveRequest.messages) {
      const guardResult = validateChatPrompt(effectiveRequest.messages, this.config.promptGuard);
      if (!guardResult.passed) {
        console.warn(`[Prompt Guard Rejected] ${guardResult.reason}`);
        const action = this.config.promptGuard.enforcementAction || this.config.promptGuard.action || 'block';
        if (action === 'warn') {
          console.info(`[Prompt Guard Warning] Proceeding despite match: ${guardResult.matchedRule}`);
        } else if (action === 'strip') {
          console.info(`[Prompt Guard Stripping Threat] ${guardResult.matchedRule}`);
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

    // 0d. Semantic / Response Cache Check
    const cacheConfig = this.config.modelGateway?.caching;
    let cacheKey = '';
    if (cacheConfig?.enabled && effectiveRequest.messages) {
      cacheKey = `${effectiveRequest.model || 'default'}:${JSON.stringify(effectiveRequest.messages)}`;
      const cached = this.responseCache.get(cacheKey);
      const ttlMs = (cacheConfig.ttlSeconds ?? 3600) * 1000;
      if (cached && (Date.now() - cached.timestamp < ttlMs)) {
        return new Response(JSON.stringify(cached.response), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Eluvix-Cache': 'HIT'
          }
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

    const matchingUpstreams = this.config.upstreams.filter(u => 
      this.matchesModel(u, effectiveRequest.model)
    );

    if (matchingUpstreams.length === 0) {
      throw new Error(`No upstream available for model: ${effectiveRequest.model}`);
    }

    const switchyardConfig = this.config.switchyard || {};
    const strategy: RoutingStrategy = switchyardConfig.strategy || this.config.strategy || 'cost-complexity';
    const hasTools = Array.isArray(effectiveRequest.tools) && effectiveRequest.tools.length > 0;
    const toolsCount = hasTools ? effectiveRequest.tools!.length : 0;
    const complexity = estimatePromptComplexity(effectiveRequest.messages || [], {
      ...switchyardConfig.complexityThresholds,
      codeEscalation: switchyardConfig.codeEscalation,
      hasTools,
      toolsCount
    });
    console.log(
      `[Switchyard Balancer] Routing Strategy: ${strategy} | Prompt Complexity: Score ${complexity.score} (${complexity.label}, tokens ~${complexity.tokenEstimate}, features: [${complexity.features.join(', ')}])`
    );

    // Context Truncation Logic: Only truncate for small local-only pools where no frontier/large-context upstream exists
    const MAX_LOCAL_TOKENS = 8000;
    const hasLargeContextUpstream = matchingUpstreams.some(
      u =>
        (u.maxComplexityScore ?? 2) >= 4 ||
        u.type === 'antigravity' ||
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
        const newComplexity = estimatePromptComplexity(effectiveRequest.messages, {
          ...switchyardConfig.complexityThresholds,
          codeEscalation: switchyardConfig.codeEscalation,
          hasTools,
          toolsCount
        });
        complexity.tokenEstimate = newComplexity.tokenEstimate;
      }
    }

    let targetUpstreams = [...matchingUpstreams];

    if (complexity.hasImages) {
      targetUpstreams = targetUpstreams.filter(u => u.capabilities?.includes('vision'));
      if (targetUpstreams.length === 0) {
        throw new Error(`No upstream available for model: ${effectiveRequest.model} with vision capability.`);
      }
    }

    if (complexity.hasTools) {
      const toolCapable = targetUpstreams.filter(u =>
        u.capabilities?.includes('tool-calling') ||
        u.capabilities?.includes('tools') ||
        u.type === 'antigravity' ||
        u.type === 'openai-compatible' ||
        u.type === 'anthropic' ||
        (Array.isArray(u.models) && u.models.some(m => /qwen|coder|tool|gemini|claude|gpt-4|gpt-oss/i.test(m)))
      );
      if (toolCapable.length > 0) {
        targetUpstreams = toolCapable;
      }
    }

    const hasExactModelMatch = (u: UpstreamConfig, model: string): number => {
      if (u.models?.includes(model)) return 1;
      if ((u.type === 'antigravity' || u.endpoint?.startsWith('cli://')) && isAntigravitySupportedModel(model, u.models)) {
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

        // Evaluate capability score (local engines default to 2-3, cloud gateways default to 4)
        const capA = a.maxComplexityScore ?? (a.type === 'openai-compatible' || a.type === 'billama' || a.type === 'antigravity' ? 4 : 2);
        const capB = b.maxComplexityScore ?? (b.type === 'openai-compatible' || b.type === 'billama' || b.type === 'antigravity' ? 4 : 2);

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

    // Latency Spillover Filter
    try {
      const recentLogs = getRequestLogs(50);
      const overloadedUpstreams = new Set<string>();
      const spilloverThreshold = switchyardConfig.spilloverThresholdMs ?? 30000;

      for (const upstream of targetUpstreams) {
        if (upstream.type === 'openai-compatible' || upstream.type === 'billama' || upstream.type === 'anthropic' || upstream.type === 'antigravity') continue; // don't punish cloud or agent reasoning endpoints
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

    // Attempt the highest priority upstream first with retry and budget guardrails
    for (const upstream of targetUpstreams) {
      // Check max cost ceiling if configured
      if (switchyardConfig.maxCostPerRequest != null && upstream.costPer1kTokens != null) {
        const estimatedCost = (complexity.tokenEstimate / 1000) * upstream.costPer1kTokens;
        if (estimatedCost > switchyardConfig.maxCostPerRequest && targetUpstreams.length > 1) {
          console.warn(`[Switchyard] Upstream ${upstream.name} estimated cost ($${estimatedCost.toFixed(4)}) exceeds ceiling ($${switchyardConfig.maxCostPerRequest}). Skipping to cheaper candidate.`);
          continue;
        }
      }

      for (let attempt = 1; attempt <= retryCount; attempt++) {
        const startTime = Date.now();
        try {
          console.log(`Attempting to route to upstream: ${upstream.name}${retryCount > 1 ? ` (attempt ${attempt}/${retryCount})` : ''}`);
          const response = await this.forwardRequest(upstream, effectiveRequest, upstreamTimeout, options?.signal, complexity.score);
          const duration_ms = Date.now() - startTime;
          
          if (response.ok) {
            let completionTokens = parseInt(response.headers.get('x-eluvix-completion-tokens') || '0', 10);
            let promptTokens = parseInt(response.headers.get('x-eluvix-prompt-tokens') || '0', 10) || complexity.tokenEstimate;
            const servedModel = response.headers.get('x-eluvix-model') || effectiveRequest.model;
            const effortHeader = response.headers.get('x-eluvix-effort');
            
            let responseBody: any = response.body;
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
                if (cacheConfig?.enabled && cacheKey) {
                  this.responseCache.set(cacheKey, { response: parsed, timestamp: Date.now() });
                }
                responseBody = new Blob([rawData]).stream();
              } catch {}
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

    throw new Error('All upstreams failed to process the request.');
  }

  public matchesModel(upstream: UpstreamConfig, requestedModel: string): boolean {
    if (!upstream || !Array.isArray(upstream.models)) return false;
    if (requestedModel === 'auto') return upstream.models.length > 0;
    if (upstream.models.includes(requestedModel)) return true;
    if (upstream.type === 'antigravity' || upstream.endpoint?.startsWith('cli://')) {
      return isAntigravitySupportedModel(requestedModel, upstream.models);
    }
    if (upstream.models.includes('*')) {
      // Local inference engines shouldn't greedily capture explicit cloud/agent models
      if (['lemonade', 'ollama', 'vllm', 'vllm-sr', 'switchyard'].includes(upstream.type)) {
        if (/^(gemini-|claude-|gpt-oss-120b)/i.test(requestedModel)) return false;
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
    complexityScore: 1 | 2 | 3 | 4 = 1
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
    const cliPath = upstream.antigravity?.cliPath || 'agy';
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
      '--dangerously-skip-permissions',
      '--print-timeout',
      `${printTimeoutSec}s`,
      '--output-format',
      'stream-json'
    ];
    if (model && model !== 'default') {
      args.push('--model', model);
      args.push('--effort', effort);
    }
    if (upstream.antigravity?.sandbox !== 'bypass') {
      args.push('--sandbox');
    }
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
