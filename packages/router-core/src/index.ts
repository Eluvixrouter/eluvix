import type { PromptGuardConfig, PrivacyGuardConfig } from './guard.js';
import type { EnclaveArchitectureId } from './tee-attestation.js';
import type { QuantizationConfig, QuantizationPolicy } from './microscaling-quantization.js';

export type RoutingStrategy = 
  | 'cost-complexity' 
  | 'cascade-cost' 
  | 'lowest-cost' 
  | 'lowest-latency' 
  | 'round-robin' 
  | 'priority'
  | 'prefill-isolation';

export type ConfidentialPolicy =
  | 'disabled'
  | 'prefer-tee'
  | 'require-tee'
  | 'require-dual-attestation';

export interface ConfidentialComputeConfig {
  enabled?: boolean;
  architecture?: EnclaveArchitectureId;
  cpuTee?: 'amd-sev-snp' | 'intel-tdx' | 'amd-sev-es' | 'none';
  gpuTee?: 'h100-cc-on' | 'h100-ppcie' | 'b200-tee-io' | 'none';
  kbsEndpoint?: string;
  expectedMeasurement?: string;
  vmpl?: number;
  restrictedInjection?: boolean;
  spdmAttested?: boolean;
}

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
  /**
   * Threshold in tokens above which a request is marked as a heavy-prefill burst.
   * Switchyard prioritizes dedicated pd-disaggregated or prefill-pool upstreams
   * to protect interactive decode streams from head-of-line SM stalls.
   * Default: 4096 when disaggregated upstreams are present.
   */
  prefillIsolationThresholdTokens?: number;
  /**
   * Sticky routing based on common system prompt / RAG context prefix hashes to
   * maximize PagedAttention / RadixAttention KV-cache reuse.
   */
  kvPrefixAffinity?: boolean;
  /**
   * Zero-Trust Confidential Computing policy (AMD SEV-SNP / Intel TDX + NVIDIA H100 CC / B200 TEE-I/O).
   */
  confidentialPolicy?: ConfidentialPolicy;
  /**
   * Sub-4-Bit Quantization-Aware routing policy (OCP MXFP4 / NVIDIA Blackwell NVFP4 + Walsh-Hadamard outlier rotation).
   */
  quantizationPolicy?: QuantizationPolicy;
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

export interface CacheConfig {
  enabled?: boolean;
  mode?: 'exact' | 'semantic';
  similarityThreshold?: number;
  scopeIsolation?: 'user' | 'session' | 'global';
  ttlSeconds?: number;
  bypassOnTools?: boolean;
}

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
  confidentialPolicy?: ConfidentialPolicy;
  quantizationPolicy?: QuantizationPolicy;
  fallbackStrategy?: 'round-robin' | 'priority';
  switchyard?: SwitchyardConfig;
  modelGateway?: ModelGatewayConfig;
  promptGuard?: PromptGuardConfig & { action?: 'block' | 'strip' | 'divert' | 'warn' };
  privacyGuard?: PrivacyGuardConfig;
  memory?: MemoryConfig;
  knowledge?: KnowledgeBaseConfig;
  cache?: CacheConfig;
  sandbox?: SandboxConfig;
  consensusGroups?: ConsensusGroupConfig[];
  fallbackChains?: FallbackChainConfig[];
}

export * from './paths.js';
export * from './db.js';
export * from './tls.js';
export * from './guard.js';
export * from './auth.js';
export * from './cli-exec.js';
export * from './local-request-guard.js';
export * from './context/index.js';
export * from './harness/index.js';
export * from './sandbox/index.js';
export * from './circuit-breaker.js';
export * from './consensus.js';
export * from './kv-math.js';
export * from './tee-attestation.js';
export * from './microscaling-quantization.js';
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
import {
  resolveCliExecutable,
  tryResolveCliExecutable,
  ANTIGRAVITY_CLI_BINARIES
} from './cli-exec.js';
import { logRequest, getRequestLogs } from './db.js';
import { validateChatPrompt, applyPrivacyGuard, stripPromptThreats } from './guard.js';
import {
  type ContextProvider,
  type KnowledgeBaseConfig,
  type MemoryConfig,
  type RequestScope,
  createContextProvider,
  formatKnowledgeSystemBlock,
  formatMemorySystemBlock,
  injectKnowledgeIntoMessages,
  injectMemoryIntoMessages,
  recallKnowledgeBase,
  stripMemoryFromMessages,
  stripKnowledgeFromMessages,
  teeSseStreamForMemory
} from './context/index.js';
import { type HarnessConfig, buildChildEnv, forwardHarnessRequest } from './harness/index.js';
import { type SandboxConfig } from './sandbox/index.js';
import { type FallbackChainConfig, globalCircuitBreaker } from './circuit-breaker.js';
import { type ConsensusGroupConfig, executeConsensusGroup } from './consensus.js';
import { estimateKvCacheFootprint } from './kv-math.js';

/** One recorded stage of upstream selection, in execution order. */
export interface RouteTraceStep {
  stage:
    | 'model-match'
    | 'loop-guard'
    | 'egress-policy'
    | 'confidential-enclave'
    | 'quantization-aware-guard'
    | 'quantization-microscaling'
    | 'memory'
    | 'memory-egress'
    | 'knowledge-rag'
    | 'vision-filter'
    | 'tools-filter'
    | 'circuit-breaker'
    | 'fallback-chain'
    | 'consensus'
    | 'prefill-isolation'
    | 'kv-prefix-affinity'
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
  | 'sglang'
  | 'switchyard'
  | 'ollama'
  | 'lemonade'
  | 'antigravity'
  | 'harness';

export interface DisaggregationConfig {
  role?: 'colocated' | 'prefill' | 'decode' | 'pd-disaggregated';
  kvConnector?: 'NixlConnector' | 'LMCacheConnectorV1' | 'mooncake' | 'nixl' | 'none';
  kvCacheDtype?: 'auto' | 'fp8_e4m3' | 'bf16' | 'nvfp4' | 'mxfp4';
  tensorParallelSize?: number;
  gpuMemoryUtilization?: number;
  rdmaDevice?: string;
  sideChannelHost?: string;
  sideChannelPort?: number;
  prefillEndpoint?: string;
  decodeEndpoint?: string;
  chunkedPrefillTokens?: number;
}

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
  disaggregation?: DisaggregationConfig;
  confidential?: ConfidentialComputeConfig;
  quantization?: QuantizationConfig;
}

/**
 * Evaluates whether an upstream uses lossless sub-4-bit microscaling quantization
 * (NVIDIA Blackwell NVFP4 or OCP MXFP4) paired with Walsh-Hadamard outlier rotation
 * (QuaRot / SpinQuant) or SVDQuant low-rank absorption, preserving 99.6% reasoning accuracy.
 */
export function isLosslessSub4BitUpstream(upstream: UpstreamConfig): boolean {
  if (!upstream) return false;
  if (upstream.capabilities?.includes('nvfp4-hadamard')) return true;
  const q = upstream.quantization;
  if (!q || q.enabled === false) return false;
  const isMicroscaledFp4 = q.format === 'nvfp4' || q.format === 'mxfp4';
  const hasOutlierRotation =
    q.outlierMitigation === 'hadamard-quarot' ||
    q.outlierMitigation === 'spinquant' ||
    q.outlierMitigation === 'svdquant';
  return isMicroscaledFp4 && hasOutlierRotation;
}

/**
 * Evaluates whether an upstream is running naive / weight-only 4-bit quantization
 * (INT4-AWQ, INT4-GPTQ, or unrotated MXFP4/NVFP4 without Walsh-Hadamard outlier smoothing)
 * which suffers -5.2% to -7.5% accuracy degradation on reasoning/coding workloads due to
 * emergent SiLU_and_Mul activation spikes.
 */
export function isNaiveSub4BitUpstream(upstream: UpstreamConfig): boolean {
  if (!upstream) return false;
  const q = upstream.quantization;
  if (!q || q.enabled === false) return false;
  if (q.format === 'int4_awq' || q.format === 'int4_gptq') {
    return !q.outlierMitigation || q.outlierMitigation === 'none';
  }
  if (q.format === 'mxfp4' || q.format === 'nvfp4') {
    return !q.outlierMitigation || q.outlierMitigation === 'none';
  }
  return false;
}

/**
 * Evaluates whether an upstream is running inside an attested Confidential Computing
 * enclave (AMD SEV-SNP / Intel TDX) or dual CPU+GPU TEE (NVIDIA H100 CC-On / Blackwell TEE-I/O).
 */
export function isConfidentialEnclaveUpstream(
  upstream: UpstreamConfig,
  mode: 'require-tee' | 'require-dual-attestation' = 'require-tee'
): boolean {
  if (!upstream) return false;
  if (upstream.capabilities?.includes('confidential-dual-attestation')) return true;
  if (mode === 'require-tee' && upstream.capabilities?.includes('confidential-tee')) return true;
  const cc = upstream.confidential;
  if (!cc?.enabled) return false;

  const arch = cc.architecture;
  const cpuTee =
    cc.cpuTee ||
    (arch === 'sev-snp-h100-cc'
      ? 'amd-sev-snp'
      : arch === 'tdx-b200-tee-io'
      ? 'intel-tdx'
      : arch === 'sev-es-passthrough'
      ? 'amd-sev-es'
      : 'none');
  const gpuTee =
    cc.gpuTee ||
    (arch === 'sev-snp-h100-cc'
      ? 'h100-cc-on'
      : arch === 'tdx-b200-tee-io'
      ? 'b200-tee-io'
      : 'none');

  // Legacy SEV-ES without RMP or standard-kvm fails strict integrity attestation
  const validCpu = cpuTee === 'amd-sev-snp' || cpuTee === 'intel-tdx';
  if (!validCpu) return false;
  if (cc.vmpl !== undefined && cc.vmpl !== 0) return false;
  if (cc.restrictedInjection === false) return false;

  if (mode === 'require-dual-attestation') {
    const validGpu = gpuTee === 'h100-cc-on' || gpuTee === 'h100-ppcie' || gpuTee === 'b200-tee-io';
    if (!validGpu) return false;
    if (cc.spdmAttested === false) return false;
  }

  return true;
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
  if (
    upstream.harness?.embedded === true ||
    endpoint.startsWith('trueforge://') ||
    endpoint.startsWith('inprocess://') ||
    endpoint.startsWith('opencode-eluvix://') ||
    endpoint.startsWith('aider://') ||
    endpoint.startsWith('swe-agent://') ||
    endpoint.startsWith('cline://') ||
    endpoint.startsWith('plandex://')
  ) {
    return true;
  }
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

/**
 * Computes a deterministic 32-bit hex hash over static system prompts,
 * knowledge blocks, or initial message turns to support KV-cache prefix affinity.
 */
export function computeKvPrefixHash(messages: ChatMessage[], maxChars = 2048): string {
  if (!messages || messages.length === 0) return 'empty';
  let prefix = '';
  const hasSystem = messages.some(m => m.role === 'system');

  if (hasSystem) {
    for (const m of messages) {
      if (m.role === 'system') {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        prefix += `[${m.role}]${c}\n`;
        if (prefix.length >= maxChars) break;
      }
    }
  } else {
    // No explicit system prompt: hash initial context turn
    for (const m of messages) {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      prefix += `[${m.role}]${c}\n`;
      if (prefix.length >= 512) break;
    }
  }

  if (!prefix) return 'empty';

  let h = 0x811c9dc5;
  for (let i = 0; i < prefix.length; i++) {
    h ^= prefix.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
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
  // Optional: the runtime falls back to config.defaultModel, then 'auto'
  // (see routeChatCompletion/explainRoute). The repo's own tests rely on
  // omitting it.
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
  // Advisory only (forwarded to upstreams that understand it); NEVER
  // used as the caller's identity — identity is options.scope.userId.
  user?: string;
  metadata?: Record<string, any>;
}

/**
 * A ChatRequest whose model has been resolved. The public entry points
 * (routeChatCompletion, explainRoute) accept an optional model and default
 * it immediately (`request.model || config.defaultModel || 'auto'`); all
 * internal routing/forwarding code works with this type, so `model` is a
 * string there — exactly what the runtime already guarantees.
 */
export type ResolvedChatRequest = ChatRequest & { model: string };

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
    // Model discovery spawns the CLI (via discoverAntigravityModels), so
    // the config-supplied path goes through the same executable gate as
    // forwarding — previously this path spawned it with no check at all
    // (audit M-2). An unresolvable/denied path degrades to the cached /
    // default catalog, exactly like a failed probe did before.
    const cliPath = tryResolveCliExecutable(upstream.antigravity?.cliPath || 'agy', {
      allowedBasenames: ANTIGRAVITY_CLI_BINARIES
    });
    const discovered = cliPath
      ? await discoverAntigravityModels(cliPath)
      : { models: getCachedAntigravityModels(), cachedAt: new Date().toISOString(), source: 'default' as const };
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
    if (kind) {
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

/**
 * Upper bound on the in-memory response cache. Entries hold full response
 * bodies, so without a cap the map grows for the life of the process.
 * Oldest entries (Map insertion order) are evicted on insert.
 */
export const MAX_RESPONSE_CACHE_ENTRIES = 500;

/**
 * Live router instances, for process-wide per-user cache invalidation
 * (see invalidateUserCache). WeakRefs so short-lived instances — tests,
 * preview routers — are not retained by the registry.
 */
const liveRouterInstances = new Set<WeakRef<Eluvix>>();

/** JSON.stringify with recursively sorted object keys, for cache keys. */
function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export class Eluvix {
  private config: RouterConfig;
  private roundRobinIndex: number = 0;
  private responseCache: Map<string, { response: any; timestamp: number; lastUserQuery?: string }> = new Map();
  private requestCounts: Map<string, { count: number; resetTime: number }> = new Map();
  private contextProvider: ContextProvider | null = null;
  private kvPrefixAffinityMap: Map<string, { upstreamId: string; timestamp: number }> = new Map();

  /** Bounded prefix affinity lookup for KV cache reuse (30-min TTL). */
  private getAffinityUpstream(prefixHash: string, ttlMs = 1800000): string | null {
    const entry = this.kvPrefixAffinityMap.get(prefixHash);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > ttlMs) {
      this.kvPrefixAffinityMap.delete(prefixHash);
      return null;
    }
    return entry.upstreamId;
  }

  /** Record upstream used for this prefix hash. */
  private setAffinityUpstream(prefixHash: string, upstreamId: string) {
    if (this.kvPrefixAffinityMap.size >= 1024) {
      const oldest = this.kvPrefixAffinityMap.keys().next().value;
      if (oldest !== undefined) this.kvPrefixAffinityMap.delete(oldest);
    }
    this.kvPrefixAffinityMap.set(prefixHash, { upstreamId, timestamp: Date.now() });
  }

  /** Insert into the response cache, evicting oldest entries past the cap. */
  private setCachedResponse(cacheKey: string, response: any, lastUserQuery?: string) {
    this.responseCache.delete(cacheKey); // refresh recency on overwrite
    while (this.responseCache.size >= MAX_RESPONSE_CACHE_ENTRIES) {
      const oldest = this.responseCache.keys().next().value;
      if (oldest === undefined) break;
      this.responseCache.delete(oldest);
    }
    this.responseCache.set(cacheKey, { response, timestamp: Date.now(), lastUserQuery });
  }

  /**
   * Drop every cached response in one user's identity partition and
   * return how many entries were removed. Wired to memory deletion so
   * answers derived from deleted memories stop being served immediately
   * instead of at TTL expiry (audit M-10).
   */
  public invalidateUserCache(userId: string): number {
    const prefix = `v2:${encodeURIComponent(userId)}:`;
    let removed = 0;
    for (const key of [...this.responseCache.keys()]) {
      if (key.startsWith(prefix)) {
        this.responseCache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  constructor(config: RouterConfig) {
    liveRouterInstances.add(new WeakRef(this));
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

  public getConfig(): RouterConfig {
    return this.config;
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
      // Identity comes ONLY from the caller's proven scope (audit H-2):
      // request.user is a client-supplied body field and must never
      // select a cache/memory partition. Callers that authenticate pass
      // scope.userId explicitly; unscoped calls land in the shared,
      // visible 'default' partition.
      userId: options?.scope?.userId || 'default',
      sessionId:
        options?.scope?.sessionId ||
        (typeof request.metadata?.sessionId === 'string' ? request.metadata.sessionId : undefined),
      agentId:
        options?.scope?.agentId ||
        (typeof request.metadata?.agentId === 'string' ? request.metadata.agentId : undefined),
      origin: options?.scope?.origin || 'client'
    };

    let effectiveRequest: ResolvedChatRequest = {
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

    // Neutralize any client-supplied delimiter tags so user input cannot forge memory or knowledge blocks
    if (effectiveRequest.messages && effectiveRequest.messages.length > 0) {
      effectiveRequest = {
        ...effectiveRequest,
        messages: effectiveRequest.messages.map(m => {
          if (typeof m.content === 'string' && (m.content.includes('<eluvix-memory') || m.content.includes('<eluvix-knowledge'))) {
            return {
              ...m,
              content: m.content
                .replace(/<(\/)?eluvix-memory([^>]*)>/gi, '&lt;$1eluvix-memory$2&gt;')
                .replace(/<(\/)?eluvix-knowledge([^>]*)>/gi, '&lt;$1eluvix-knowledge$2&gt;')
            };
          }
          return m;
        })
      };
    }

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

        // Recalled memory is stored, attacker-influenceable content
        // (audit H-4): turns are auto-written from ordinary chat, so a
        // planted instruction would otherwise be re-injected below with
        // system-role privilege, after the pre-flight guard (step 0b)
        // has already run. Scan every block with the prompt guard
        // before injection and drop blocks that trip it. Note the
        // residual limits, accepted for this tier: the guard is a
        // heuristic regex scan (Tier 5 hardens it), and the surviving
        // block is still injected in the system role for consumer
        // compatibility — the mitigations are this scan plus the
        // delimiter-escaped block format (context/index.ts, audit H-5).
        if (usableBlocks.length > 0 && this.config.promptGuard?.enabled) {
          const kept: typeof usableBlocks = [];
          for (const b of usableBlocks) {
            const scan = validateChatPrompt(
              [{ role: 'user', content: b.text }],
              this.config.promptGuard
            );
            if (scan.passed) {
              kept.push(b);
            } else {
              console.warn(
                `[Prompt Guard] Dropping recalled memory block from ${recallResult.provider}: ${scan.reason || 'heuristic match'} (${scan.matchedRule || 'unknown rule'})`
              );
            }
          }
          usableBlocks = kept;
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

    // 0b3. Knowledge Base RAG Recall (Static Project / Docs RAG)
    let knowledgeStatus = 'disabled';
    let knowledgeTokens = 0;
    if (
      this.config.knowledge?.enabled &&
      lastUserQuery.trim().length > 0 &&
      effectiveRequest.messages
    ) {
      try {
        const kbResult = await recallKnowledgeBase(
          lastUserQuery,
          this.config.knowledge,
          scope,
          options?.signal
        );
        let usableKbBlocks = kbResult.blocks;
        if (usableKbBlocks.length > 0 && this.config.privacyGuard?.enabled) {
          const scrubbed: typeof usableKbBlocks = [];
          for (const b of usableKbBlocks) {
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
          usableKbBlocks = scrubbed;
        }

        if (usableKbBlocks.length > 0 && this.config.promptGuard?.enabled) {
          const kept: typeof usableKbBlocks = [];
          for (const b of usableKbBlocks) {
            const scan = validateChatPrompt(
              [{ role: 'user', content: b.text }],
              this.config.promptGuard
            );
            if (scan.passed) {
              kept.push(b);
            } else {
              console.warn(
                `[Prompt Guard] Dropping recalled knowledge block from ${kbResult.provider}: ${scan.reason || 'heuristic match'} (${scan.matchedRule || 'unknown rule'})`
              );
            }
          }
          usableKbBlocks = kept;
        }

        if (usableKbBlocks.length > 0) {
          const kbBlock = formatKnowledgeSystemBlock(usableKbBlocks, this.config.knowledge);
          if (kbBlock) {
            effectiveRequest = {
              ...effectiveRequest,
              messages: injectKnowledgeIntoMessages(effectiveRequest.messages, kbBlock)
            };
            knowledgeTokens = kbResult.tokenEstimate;
            knowledgeStatus = `${kbResult.provider}:hit(${usableKbBlocks.length})`;
          }
        } else {
          knowledgeStatus = `${kbResult.provider}:miss`;
        }
      } catch (err) {
        console.warn('[KnowledgeBase] RAG recall error (failing open):', err);
        knowledgeStatus = 'error';
      }
    }

    // 0c. Rate Limiting Check
    const rateLimit = this.config.modelGateway?.rateLimits?.maxRpm;
    if (rateLimit && rateLimit > 0) {
      const now = Date.now();
      // Prune expired minute windows: one entry is added per minute and,
      // without this, the map grows for the life of the process.
      for (const [key, entry] of this.requestCounts) {
        if (entry.resetTime <= now) {
          this.requestCounts.delete(key);
        }
      }
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

    // The response cache is consulted only after the routing context is
    // known (step 0e2, after upstream selection): its key must capture
    // the caller's identity partition and everything about the routing
    // decision that shapes the response (audit H-2/H-3/M-9).
    // Accepts both the top-level config.cache block and
    // modelGateway.caching, whichever is explicitly enabled.
    const cacheConfig = this.config.cache?.enabled !== undefined
      ? this.config.cache
      : this.config.modelGateway?.caching;
    let cacheKey = '';

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

    let selection;
    try {
      selection = this.selectTargetUpstreams(effectiveRequest, {
        scope,
        hops,
        memoryTainted,
        memoryTokens: memoryTokens + knowledgeTokens
      });
    } catch (err: any) {
      if (err?.confidentialUnavailable) {
        return new Response(
          JSON.stringify({
            error: {
              message: err.message,
              type: 'confidential_enclave_unavailable',
              code: 'rats_attestation_required'
            }
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'x-eluvix-tee-posture': 'DENIED_UNATTESTED'
            }
          }
        );
      }
      throw err;
    }
    effectiveRequest = selection.effectiveRequest;
    const complexity = selection.complexity;
    let targetUpstreams = selection.targetUpstreams;

    // 0e2. Semantic / Response Cache Check. The key ALWAYS carries the
    // identity partition (scope.userId — proven identity only; unscoped
    // calls share the 'default' partition: per decision D4 the cache is
    // partitioned for them rather than disabled), the memory digest, and
    // a digest of the routing context: the selected upstream id set, the
    // system-prompt prepend, and the egress state — including, per
    // candidate upstream, whether recalled memory would be stripped
    // before forwarding to it. A body produced under one context (e.g.
    // memory stripped for a cloud upstream) is therefore never replayed
    // under another (e.g. memory intact for a local one), and a hit can
    // never cross identity partitions.
    if (cacheConfig?.enabled && effectiveRequest.messages) {
      // bypassOnTools: opt-in safety valve — set to true to never serve
      // tool-bearing requests (or harness-origin traffic) from the cache.
      // Default is false: the variant key already captures the tools, so
      // tool variants are cached under their own keys.
      const hasActiveTools = Array.isArray(effectiveRequest.tools) && effectiveRequest.tools.length > 0;
      const bypassCache =
        (cacheConfig as CacheConfig).bypassOnTools === true && (hasActiveTools || scope.origin === 'harness');
      if (bypassCache) {
        cacheKey = '';
      } else {
      // The variant segment must capture everything else that changes
      // the response. Keying only on model + messages served a buffered
      // non-streaming body to streaming requests (as application/json,
      // not SSE) and a tool-less answer to requests that differed only
      // by tools or sampling params.
      const variantKey = stableStringify({
        stream: effectiveRequest.stream === true,
        tools: effectiveRequest.tools ?? null,
        toolChoice: effectiveRequest.tool_choice ?? null,
        temperature: effectiveRequest.temperature ?? null,
        topP: (effectiveRequest as any).top_p ?? null,
        maxTokens: (effectiveRequest as any).max_tokens ?? null
      });
      const stripByUpstream = [...targetUpstreams]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(u => ({
          id: u.id,
          strip:
            memoryTainted &&
            !this.config.memory?.allowCloudEgress &&
            this.config.memory?.cloudMode === 'strip' &&
            !isLocalUpstream(u)
        }));
      const routingDigest = crypto
        .createHash('sha256')
        .update(
          stableStringify({
            upstreams: [...targetUpstreams].map(u => u.id).sort(),
            systemPromptPrepend: this.config.modelGateway?.systemPromptPrepend ?? null,
            egressPolicy: this.config.egressPolicy ?? null,
            memoryAllowCloudEgress: this.config.memory?.allowCloudEgress ?? null,
            memoryCloudMode: this.config.memory?.cloudMode ?? null,
            memoryTainted,
            stripByUpstream
          })
        )
        .digest('hex')
        .slice(0, 16);
      // Scope granularity (config.cache.scopeIsolation): 'session' keys
      // per conversation, 'global' shares across users only while the
      // answer carries no recalled memory, 'user' (default) always
      // partitions by proven identity + memory digest.
      const isolation = (cacheConfig as CacheConfig).scopeIsolation || 'user';
      const scopePrefix =
        isolation === 'session'
          ? `${encodeURIComponent(scope.userId)}:${scope.sessionId || 'default'}`
          : isolation === 'global' && !memoryTainted
          ? 'global'
          : `${encodeURIComponent(scope.userId)}:${memoryDigest || 'nomem'}`;
      cacheKey = `v2:${scopePrefix}:${routingDigest}:${effectiveRequest.model || 'default'}:${variantKey}:${JSON.stringify(effectiveRequest.messages)}`;
      let cached = this.responseCache.get(cacheKey) as
        | { response: any; timestamp: number }
        | undefined;
      const ttlMs = (cacheConfig.ttlSeconds ?? 3600) * 1000;
      if (cached && Date.now() - cached.timestamp >= ttlMs) {
        // Expired entries are deleted, not just ignored — otherwise they
        // accumulate forever behind keys that are never asked for again.
        this.responseCache.delete(cacheKey);
      }
      // Optional semantic similarity match across the same scope prefix,
      // routing context, and request variant when mode === 'semantic' (config.cache).
      if (
        (cacheConfig as CacheConfig).mode === 'semantic' && 
        !cached &&
        lastUserQuery.trim().length > 0
      ) {
        const threshold = (cacheConfig as CacheConfig).similarityThreshold ?? 0.9;
        const queryTokens = new Set(lastUserQuery.toLowerCase().split(/\W+/).filter(Boolean));
        if (queryTokens.size > 0) {
          const scanPrefix = `v2:${scopePrefix}:${routingDigest}:${effectiveRequest.model || 'default'}:${variantKey}:`;
          for (const [k, entry] of this.responseCache.entries()) {
            if (!k.startsWith(scanPrefix)) continue;
            if (Date.now() - entry.timestamp >= ttlMs) continue;
            const targetQuery = entry.lastUserQuery || '';
            const entryTokens = new Set(targetQuery.toLowerCase().split(/\W+/).filter(Boolean));
            if (entryTokens.size === 0) continue;
            let intersection = 0;
            queryTokens.forEach((w) => {
              if (entryTokens.has(w)) intersection++;
            });
            const unionSize = new Set([...queryTokens, ...entryTokens]).size;
            const jaccard = unionSize > 0 ? intersection / unionSize : 0;
            if (jaccard >= threshold) {
              cached = entry;
              break;
            }
          }
        }
      }
      if (cached && Date.now() - cached.timestamp < ttlMs) {
        const hitHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          'X-Eluvix-Cache': 'HIT'
        };
        if (this.config.memory?.enabled) {
          hitHeaders['x-eluvix-memory'] = memoryStatus;
          hitHeaders['x-eluvix-memory-tokens'] = String(memoryTokens);
        }
        if (this.config.knowledge?.enabled) {
          hitHeaders['x-eluvix-knowledge'] = knowledgeStatus;
        }
        return new Response(JSON.stringify(cached.response), {
          status: 200,
          headers: hitHeaders
        });
      }
      }
    }

    const switchyardConfig = this.config.switchyard || {};

    // Consensus Group Execution (Mixture-of-Agents / Parallel Judge / Fastest-First)
    const activeConsensus = this.config.consensusGroups?.[0];
    if (
      activeConsensus &&
      Array.isArray(activeConsensus.candidateUpstreamIds) &&
      activeConsensus.candidateUpstreamIds.length >= 2
    ) {
      const idSet = new Set(activeConsensus.candidateUpstreamIds);
      const consensusCandidates = targetUpstreams.filter((u) => idSet.has(u.id));
      if (consensusCandidates.length >= 2) {
        try {
          const consensusTimeout = activeConsensus.timeoutMs ?? switchyardConfig.timeoutMs ?? 45000;
          const consensusRes = await executeConsensusGroup(
            activeConsensus,
            consensusCandidates,
            effectiveRequest,
            (u, req, sig) => {
              let reqForCandidate = req as ResolvedChatRequest;
              if (
                memoryTainted &&
                !this.config.memory?.allowCloudEgress &&
                this.config.memory?.cloudMode === 'strip' &&
                !isLocalUpstream(u) &&
                reqForCandidate.messages
              ) {
                reqForCandidate = {
                  ...reqForCandidate,
                  messages: stripMemoryFromMessages(reqForCandidate.messages)
                };
              }
              return this.forwardRequest(u, reqForCandidate, consensusTimeout, sig, complexity.score, scope, hops);
            },
            options?.signal
          );
          if (this.config.memory?.enabled) {
            consensusRes.headers.set('x-eluvix-memory', memoryStatus);
          }
          if (this.config.knowledge?.enabled) {
            consensusRes.headers.set('x-eluvix-knowledge', knowledgeStatus);
          }
          return consensusRes;
        } catch (err) {
          console.warn('[ConsensusGroup] Consensus execution failed, falling back to standard routing:', err);
        }
      }
    }

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
    const failoverBudgetMs = switchyardConfig.failoverBudgetMs ?? 120000;
    const routeStartTime = Date.now();
    let attemptsMade = 0;
    let budgetExhausted = false;
    const activeChain = this.config.fallbackChains?.[0];

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
            globalCircuitBreaker.recordSuccess(upstream.id);
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
                  this.setCachedResponse(cacheKey, parsed, lastUserQuery);
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

            const ttftHeader = response.headers.get('x-eluvix-ttft-ms');
            const ttftMs = ttftHeader ? parseInt(ttftHeader, 10) : duration_ms;
            let itlMs: number | undefined = undefined;
            if (completionTokens > 0) {
              const decodeMs = Math.max(0, duration_ms - ttftMs);
              itlMs = completionTokens > 1
                ? Number((decodeMs / (completionTokens - 1)).toFixed(2))
                : Number((decodeMs || duration_ms).toFixed(2));
            }
            const kvDtype = upstream.disaggregation?.kvCacheDtype === 'bf16' ? 'bf16' : 'fp8_e4m3';
            const kvFootprint = estimateKvCacheFootprint(servedModel, promptTokens, kvDtype);
            const kvCacheKb = Number((kvFootprint.totalBytes / 1024).toFixed(1));

            // Fire and forget logging (for non-streaming or non-agy streaming; agy streaming logs exact tokens on stream completion)
            if (!(effectiveRequest.stream && (upstream.type === 'antigravity' || upstream.endpoint.startsWith('cli://')))) {
              logRequest({
                model: servedModel,
                upstream_id: upstream.id,
                status: response.status,
                duration_ms,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                ttft_ms: ttftMs,
                itl_ms: itlMs,
                kv_cache_kb: kvCacheKb
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
            newResponse.headers.set('x-eluvix-ttft-ms', String(ttftMs));
            if (itlMs !== undefined) {
              newResponse.headers.set('x-eluvix-itl-ms', String(itlMs));
            }
            newResponse.headers.set('x-eluvix-kv-cache-kb', String(kvCacheKb));
            if (upstream.disaggregation?.role) {
              newResponse.headers.set('x-eluvix-pd-role', upstream.disaggregation.role);
            }
            const teePosture = isConfidentialEnclaveUpstream(upstream, 'require-dual-attestation')
              ? 'ATTESTED_DUAL_ENCLAVE'
              : isConfidentialEnclaveUpstream(upstream, 'require-tee')
              ? 'ATTESTED_CPU_ONLY'
              : 'PLAINTEXT';
            newResponse.headers.set('x-eluvix-tee-posture', teePosture);
            if (upstream.confidential?.enabled) {
              newResponse.headers.set('x-eluvix-tee-arch', upstream.confidential.architecture || 'sev-snp-h100-cc');
              newResponse.headers.set(
                'x-eluvix-rats-kbs',
                teePosture === 'ATTESTED_DUAL_ENCLAVE' ? 'GRANTED' : 'UNATTESTED'
              );
            }
            if (upstream.quantization?.format) {
              newResponse.headers.set('x-eluvix-quantization-format', upstream.quantization.format);
              newResponse.headers.set(
                'x-eluvix-outlier-rotation',
                upstream.quantization.outlierMitigation || 'none'
              );
              const defaultPtx =
                upstream.quantization.format === 'nvfp4'
                  ? 'tcgen05.mma.kind::mxf4nvf4'
                  : upstream.quantization.format === 'mxfp4'
                  ? 'tcgen05.mma.kind::mxf4'
                  : upstream.quantization.format === 'int4_awq' || upstream.quantization.format === 'int4_gptq'
                  ? 'dequant-fp16'
                  : 'wgmma.mma_async';
              newResponse.headers.set(
                'x-eluvix-tensor-core-ptx',
                upstream.quantization.ptxInstruction || defaultPtx
              );
            }
            const reqPrefixHash = computeKvPrefixHash(effectiveRequest.messages || []);
            if (reqPrefixHash !== 'empty') {
              newResponse.headers.set('x-eluvix-kv-prefix-hash', reqPrefixHash);
              if (this.config.switchyard?.kvPrefixAffinity) {
                this.setAffinityUpstream(reqPrefixHash, upstream.id);
              }
            }
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
            if (this.config.knowledge?.enabled) {
              newResponse.headers.set('x-eluvix-knowledge', knowledgeStatus);
              newResponse.headers.set('x-eluvix-knowledge-tokens', String(knowledgeTokens));
            }
            
            return newResponse;
          } else {
            globalCircuitBreaker.recordFailure(upstream.id, activeChain?.failureThreshold ?? 3);
            console.warn(`Upstream ${upstream.name} failed with status ${response.status}${retryCount > 1 ? ` (attempt ${attempt}/${retryCount})` : ''}`);
            try {
              await response.text();
            } catch {}
            if (response.status === 429 && activeChain?.retryOn429 !== false) {
              break; // Immediately advance to next upstream in fallback chain on 429
            }
          }
        } catch (err) {
          globalCircuitBreaker.recordFailure(upstream.id, activeChain?.failureThreshold ?? 3);
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
    const effectiveRequest: ResolvedChatRequest = {
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
    effectiveRequest: ResolvedChatRequest,
    options?: {
      silent?: boolean;
      scope?: Partial<RequestScope>;
      hops?: number;
      memoryTainted?: boolean;
      memoryTokens?: number;
    }
  ): {
    effectiveRequest: ResolvedChatRequest;
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

    // Zero-Trust Confidential Computing Policy Enforcement (AMD SEV-SNP / Intel TDX + NVIDIA H100 CC / B200 TEE-I/O)
    // Server-configured policy cannot be downgraded by client metadata; clients can only request stricter enforcement.
    const POLICY_RANKS: Record<ConfidentialPolicy, number> = {
      'disabled': 0,
      'prefer-tee': 1,
      'require-tee': 2,
      'require-dual-attestation': 3
    };
    const serverPolicy: ConfidentialPolicy =
      this.config.switchyard?.confidentialPolicy ||
      this.config.confidentialPolicy ||
      'disabled';
    const clientPolicy = effectiveRequest.metadata?.confidentialPolicy as ConfidentialPolicy | undefined;
    const confidentialPolicy: ConfidentialPolicy =
      clientPolicy && POLICY_RANKS[clientPolicy] != null
        ? (POLICY_RANKS[clientPolicy] > POLICY_RANKS[serverPolicy] ? clientPolicy : serverPolicy)
        : serverPolicy;

    if (confidentialPolicy === 'require-dual-attestation' || confidentialPolicy === 'require-tee') {
      const teeUpstreams = matchingUpstreams.filter(u => isConfidentialEnclaveUpstream(u, confidentialPolicy));
      const excluded = matchingUpstreams.filter(u => !isConfidentialEnclaveUpstream(u, confidentialPolicy));
      steps.push({
        stage: 'confidential-enclave',
        detail: `confidentialPolicy=${confidentialPolicy}: only RATS-attested ${
          confidentialPolicy === 'require-dual-attestation'
            ? 'Dual CPU+GPU Confidential Enclave (SEV-SNP/TDX + H100 CC/B200 TEE-I/O)'
            : 'CPU TEE (SEV-SNP/TDX)'
        } upstreams may serve this request`,
        kept: teeUpstreams.map(u => u.id),
        removed: excluded.map(u => u.id)
      });
      if (teeUpstreams.length === 0) {
        const err: any = new Error(
          `No attested confidential enclave upstream available for model: ${effectiveRequest.model} (confidentialPolicy: ${confidentialPolicy})`
        );
        err.routeSteps = steps;
        err.confidentialUnavailable = true;
        throw err;
      }
      matchingUpstreams = teeUpstreams;
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
    // Evaluate complexity on the user prompt WITHOUT injected memory or knowledge blocks
    // so recalled memories/docs do not artificially escalate simple prompts to expensive frontier models.
    const messagesWithoutContext = stripKnowledgeFromMessages(stripMemoryFromMessages(effectiveRequest.messages || []));
    const complexity = estimatePromptComplexity(messagesWithoutContext, {
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
      const systemMsgs = msgs.filter(m => m.role === 'system');
      const nonSystemMsgs = msgs.filter(m => m.role !== 'system');
      if (nonSystemMsgs.length > 2) {
        effectiveRequest = {
          ...effectiveRequest,
          messages: [
            ...systemMsgs,
            { role: 'system', content: '[System Note: Middle conversation history truncated to preserve context window]' },
            ...nonSystemMsgs.slice(-2)
          ]
        };
        const newComplexity = estimatePromptComplexity(stripKnowledgeFromMessages(stripMemoryFromMessages(effectiveRequest.messages)), {
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
        const capA = a.maxComplexityScore ?? (a.type === 'openai-compatible' || a.type === 'billama' || a.type === 'anthropic' || a.type === 'antigravity' || a.type === 'harness' ? 4 : 2);
        const capB = b.maxComplexityScore ?? (b.type === 'openai-compatible' || b.type === 'billama' || b.type === 'anthropic' || b.type === 'antigravity' || b.type === 'harness' ? 4 : 2);

        const capableA = capA >= complexity.score ? 1 : 0;
        const capableB = capB >= complexity.score ? 1 : 0;

        // 1. Capable upstreams come first
        if (capableA !== capableB) {
          return capableB - capableA;
        }

        // 2. Lowest cost per 1k tokens first ($0 local engines prioritized)
        const costA = a.costPer1kTokens ?? (a.type === 'openai-compatible' || a.type === 'billama' || a.type === 'anthropic' ? 0.005 : 0);
        const costB = b.costPer1kTokens ?? (b.type === 'openai-compatible' || b.type === 'billama' || b.type === 'anthropic' ? 0.005 : 0);
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
        const costA = a.costPer1kTokens ?? (a.type === 'openai-compatible' || a.type === 'billama' || a.type === 'anthropic' ? 0.005 : 0);
        const costB = b.costPer1kTokens ?? (b.type === 'openai-compatible' || b.type === 'billama' || b.type === 'anthropic' ? 0.005 : 0);
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
        const latA = a.latencyMs ?? (a.type === 'openai-compatible' || a.type === 'billama' || a.type === 'anthropic' ? 500 : 25);
        const latB = b.latencyMs ?? (b.type === 'openai-compatible' || b.type === 'billama' || b.type === 'anthropic' ? 500 : 25);
        if (latA !== latB) return latA - latB;
        return b.priority - a.priority;
      });
    } else if (strategy === 'round-robin') {
      const idx = this.roundRobinIndex % targetUpstreams.length;
      if (!options?.silent) {
        this.roundRobinIndex++;
      }
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

    if (confidentialPolicy === 'prefer-tee') {
      const teePreferred = targetUpstreams.filter(u => isConfidentialEnclaveUpstream(u, 'require-tee'));
      if (teePreferred.length > 0 && teePreferred.length < targetUpstreams.length) {
        steps.push({
          stage: 'confidential-enclave',
          detail: 'confidentialPolicy=prefer-tee: prioritizing attested SEV-SNP/TDX confidential enclave upstreams ahead of plaintext workers',
          kept: teePreferred.map(u => u.id)
        });
        targetUpstreams = [
          ...teePreferred,
          ...targetUpstreams.filter(u => !teePreferred.includes(u))
        ];
      }
    }

    // Sub-4-Bit Microscaling & Walsh-Hadamard Quantization-Aware Routing Policy
    const QUANT_RANKS: Record<QuantizationPolicy, number> = {
      'disabled': 0,
      'prefer-nvfp4-hadamard': 1,
      'lossless-reasoning': 2
    };
    const serverQuantPolicy: QuantizationPolicy =
      switchyardConfig.quantizationPolicy ||
      this.config.quantizationPolicy ||
      'disabled';
    const clientQuantPolicy = effectiveRequest.metadata?.quantizationPolicy as QuantizationPolicy | undefined;
    const quantizationPolicy: QuantizationPolicy =
      clientQuantPolicy && QUANT_RANKS[clientQuantPolicy] != null
        ? (QUANT_RANKS[clientQuantPolicy] > QUANT_RANKS[serverQuantPolicy] ? clientQuantPolicy : serverQuantPolicy)
        : serverQuantPolicy;

    if (quantizationPolicy === 'lossless-reasoning') {
      const losslessUpstreams = targetUpstreams.filter(u => !isNaiveSub4BitUpstream(u));
      const excludedNaive = targetUpstreams.filter(u => isNaiveSub4BitUpstream(u));
      if (excludedNaive.length > 0 || losslessUpstreams.length === 0) {
        steps.push({
          stage: 'quantization-aware-guard',
          detail: 'quantizationPolicy=lossless-reasoning: excluding unrotated/weight-only 4-bit upstreams (INT4-AWQ/GPTQ or naive MXFP4 without Hadamard rotation) to prevent emergent SiLU_and_Mul activation outlier collapse',
          kept: losslessUpstreams.map(u => u.id),
          removed: excludedNaive.map(u => u.id)
        });
      }
      if (losslessUpstreams.length === 0) {
        const err: any = new Error(
          `No lossless reasoning upstream (NVFP4+Hadamard, FP8 E4M3, or BF16) available for model: ${effectiveRequest.model} (quantizationPolicy: lossless-reasoning)`
        );
        err.routeSteps = steps;
        err.quantizationUnavailable = true;
        throw err;
      }
      targetUpstreams = losslessUpstreams;
    }

    if (quantizationPolicy === 'prefer-nvfp4-hadamard' || quantizationPolicy === 'lossless-reasoning') {
      const nvfp4Hadamard = targetUpstreams.filter(u => isLosslessSub4BitUpstream(u));
      if (nvfp4Hadamard.length > 0 && nvfp4Hadamard.length < targetUpstreams.length) {
        const rest = targetUpstreams.filter(u => !nvfp4Hadamard.includes(u));
        const nonNaiveRest = rest.filter(u => !isNaiveSub4BitUpstream(u));
        const naiveRest = rest.filter(u => isNaiveSub4BitUpstream(u));
        steps.push({
          stage: 'quantization-microscaling',
          detail: `quantizationPolicy=${quantizationPolicy}: prioritizing Blackwell NVFP4 / MXFP4 + Walsh-Hadamard (W4A4 tcgen05.mma) upstreams for 3.42x throughput at 99.6% accuracy retention`,
          kept: nvfp4Hadamard.map(u => u.id)
        });
        targetUpstreams = [...nvfp4Hadamard, ...nonNaiveRest, ...naiveRest];
      }
    }

    // Prefill-Isolation: Separate compute-bound heavy prompt prefills from latency-critical decode streams
    const prefillThreshold = switchyardConfig.prefillIsolationThresholdTokens ?? 4096;
    const isHeavyPrefill = complexity.tokenEstimate >= prefillThreshold;

    if (isHeavyPrefill) {
      const disaggPrefill = targetUpstreams.filter(u =>
        u.disaggregation?.role === 'pd-disaggregated' ||
        u.disaggregation?.role === 'prefill'
      );
      if (disaggPrefill.length > 0) {
        steps.push({
          stage: 'prefill-isolation',
          detail: `tokenEstimate=${complexity.tokenEstimate} >= ${prefillThreshold}: heavy-prefill burst routed to dedicated disaggregated/prefill upstreams to protect decode streams from head-of-line SM stalls`,
          kept: disaggPrefill.map(u => u.id),
          removed: targetUpstreams.filter(u => !disaggPrefill.includes(u)).map(u => u.id)
        });
        targetUpstreams = [
          ...disaggPrefill,
          ...targetUpstreams.filter(u => !disaggPrefill.includes(u) && u.disaggregation?.role !== 'decode')
        ];
      }
    } else {
      const purePrefill = targetUpstreams.filter(u => u.disaggregation?.role === 'prefill');
      if (purePrefill.length > 0 && targetUpstreams.length > purePrefill.length) {
        steps.push({
          stage: 'prefill-isolation',
          detail: `tokenEstimate=${complexity.tokenEstimate} < ${prefillThreshold}: interactive prompt preferring decode/colocated upstreams over pure prefill workers`,
          kept: targetUpstreams.filter(u => !purePrefill.includes(u)).map(u => u.id),
          removed: purePrefill.map(u => u.id)
        });
        targetUpstreams = [
          ...targetUpstreams.filter(u => !purePrefill.includes(u)),
          ...purePrefill
        ];
      }
    }

    // KV Prefix Affinity: Sticky routing for common prompt prefixes to maximize PagedAttention / RadixAttention reuse
    const prefixHash = computeKvPrefixHash(effectiveRequest.messages || []);
    if (switchyardConfig.kvPrefixAffinity && prefixHash !== 'empty') {
      const cachedUpstreamId = this.getAffinityUpstream(prefixHash);
      if (cachedUpstreamId) {
        const cachedIdx = targetUpstreams.findIndex(u => u.id === cachedUpstreamId);
        if (cachedIdx > 0) {
          const preferred = targetUpstreams[cachedIdx];
          const cannotPromoteDueToPrefill = !isHeavyPrefill && preferred.disaggregation?.role === 'prefill';
          const isPreferredTee = isConfidentialEnclaveUpstream(preferred, 'require-tee');
          const hasPrioritizedTee = confidentialPolicy === 'prefer-tee' && isConfidentialEnclaveUpstream(targetUpstreams[0], 'require-tee');
          const cannotPromoteDueToTee = hasPrioritizedTee && !isPreferredTee;

          if (!cannotPromoteDueToPrefill && !cannotPromoteDueToTee) {
            targetUpstreams = [preferred, ...targetUpstreams.filter(u => u.id !== cachedUpstreamId)];
            steps.push({
              stage: 'kv-prefix-affinity',
              detail: `prefixHash=${prefixHash} hit warm KV-cache affinity; prioritised upstream ${preferred.name} (${preferred.id})`,
              kept: [preferred.id]
            });
          }
        }
      }
    }

    // Apply FallbackChain ordering and Circuit Breaker filtering when configured
    const activeChain = this.config.fallbackChains?.[0];
    if (activeChain) {
      const explicitOrder = (Array.isArray(activeChain.orderedUpstreamIds) && activeChain.orderedUpstreamIds.length > 0)
        ? activeChain.orderedUpstreamIds
        : [activeChain.primaryUpstreamId, activeChain.secondaryUpstreamId, activeChain.tertiaryUpstreamId].filter(Boolean) as string[];
      if (explicitOrder.length > 0) {
        const orderMap = new Map<string, number>();
        explicitOrder.forEach((id, idx) => orderMap.set(id, idx));
        targetUpstreams.sort((a, b) => {
          const idxA = orderMap.has(a.id) ? orderMap.get(a.id)! : 999;
          const idxB = orderMap.has(b.id) ? orderMap.get(b.id)! : 999;
          return idxA - idxB;
        });
        const threshold = activeChain.failureThreshold ?? 3;
        const cooldown = activeChain.cooldownSeconds ?? 60;
        const healthy = targetUpstreams.filter((u) =>
          globalCircuitBreaker.isAllowed(u.id, threshold, cooldown)
        );
        steps.push({
          stage: 'fallback-chain',
          detail: `fallbackChain=${activeChain.id}: enforced priority order [${explicitOrder.join(', ')}] with failureThreshold=${threshold}`,
          kept: (healthy.length > 0 ? healthy : targetUpstreams).map(u => u.id)
        });
        if (healthy.length > 0) {
          targetUpstreams = healthy;
        }
      }
    }

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
      if (['lemonade', 'ollama', 'vllm', 'vllm-sr', 'sglang', 'switchyard'].includes(upstream.type)) {
        if (/^(gemini-|claude-|gpt-oss-120b|harness\/)/i.test(requestedModel)) return false;
      }
      return true;
    }
    return false;
  }

  private async forwardRequest(
    upstream: UpstreamConfig,
    request: ResolvedChatRequest,
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
    const effectiveRequest: ResolvedChatRequest = {
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
    const fetchStartTime = Date.now();

    try {
      const res = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal
      });
      const headersReceivedMs = Date.now() - fetchStartTime;

      if (!res.ok) {
        // Consume the error body under the still-armed deadline too, so a
        // stalled error body cannot hang the attempt either.
        const errorText = await res.text();
        if (timeoutTimer) clearTimeout(timeoutTimer);
        return new Response(errorText, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers
        });
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

        const ttftMs = Date.now() - fetchStartTime;

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
        resHeaders.set('x-eluvix-ttft-ms', String(ttftMs));
        return new Response(stream, {
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders
        });
      }

      // Non-streaming response: keep the attempt deadline armed while the
      // body is consumed. Clearing it when headers arrive (the old
      // behavior) left the caller's body read unbounded — an upstream
      // that sent headers and then stalled hung the request forever,
      // and the failover budget only gates NEW attempts. Aborting the
      // controller rejects the pending read, failing this attempt so
      // failover can proceed; the buffered body is returned instead.
      const bodyText = await res.text();
      if (timeoutTimer) clearTimeout(timeoutTimer);

      const ttftMs = headersReceivedMs;
      const resHeaders = new Headers(res.headers);
      resHeaders.set('x-eluvix-model', effectiveModel);
      resHeaders.set('x-eluvix-ttft-ms', String(ttftMs));
      return new Response(bodyText, {
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
    request: ResolvedChatRequest,
    complexityScore: 1 | 2 | 3 | 4 = 1,
    clientSignal?: AbortSignal,
    upstreamTimeoutMs = 60000
  ): Promise<Response> {
    const startTime = Date.now();
    // The config-supplied cliPath is resolved through the central gate:
    // basename allowlist + canonical-path checks (exists, executable, not
    // under a world-writable or config-controlled dir). The basename-only
    // check that stood here before let `/any/dir/agy` execute (audit M-2,
    // and the router-core half of C-1). Spawn sites below use the RESOLVED
    // path, never the raw config value.
    const cliPath = resolveCliExecutable(upstream.antigravity?.cliPath || 'agy', {
      allowedBasenames: ANTIGRAVITY_CLI_BINARIES
    });

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

    // Spawn-boundary env scrub (audit H-1 / D3): the agy child never
    // inherits the router's own credentials — see harness/env.ts.
    const childEnv = buildChildEnv({ HOME: effectiveHome });

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
        let streamError: string | null = null;
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
              // An ERROR result is a failed attempt, not a successful
              // empty reply: record it so the close handler can surface
              // a stream error (or a 502 if nothing was streamed yet)
              // instead of a clean finish_reason 'stop' logged as 200.
              streamError = ev.response?.trim() || 'agy CLI reported an ERROR result';
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

          if (streamError) {
            if (!resolvedInitial) {
              resolvedInitial = true;
              resolve(new Response(JSON.stringify({
                error: {
                  message: `agy CLI reported an error: ${streamError}`,
                  type: 'antigravity_cli_error'
                }
              }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
            } else if (!streamClosed && streamControllerRef) {
              streamClosed = true;
              try {
                streamControllerRef.error(new Error(`agy CLI reported an error: ${streamError}`));
              } catch {}
            }
            logRequest({
              model,
              upstream_id: upstream.id,
              status: 502,
              duration_ms: Date.now() - startTime,
              prompt_tokens: exactPromptTokens,
              completion_tokens: exactCompletionTokens
            });
            return;
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
            if (code === 0) {
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
            } else {
              const errDetail = stderr.trim() || `Process exited with code ${code}`;
              try {
                streamControllerRef.error(new Error(`agy CLI exited prematurely with code ${code}: ${errDetail}`));
              } catch {}
            }
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
        let resultError: string | null = null;
        let exactUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
        const plainLines: string[] = [];

        for (const line of cleanStdout.split('\n')) {
          const ev = parseAgyStreamJsonLine(line);
          if (ev.type === 'delta' && ev.textDelta) {
            deltaAccumulated += ev.textDelta;
          } else if (ev.type === 'result') {
            if (ev.status && ev.status.toUpperCase() === 'ERROR') {
              resultError = ev.response?.trim() || 'agy CLI reported an ERROR result';
            }
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

        // A stream-json result with status ERROR is a failed attempt: its
        // text is an error message, not an assistant reply. Returning it
        // as a 200 (the old behavior) also blocked failover, since the
        // attempt looked successful. Same for agy exiting 0 while
        // producing no output at all — fail the attempt with a 502.
        if (resultError) {
          resolve(new Response(JSON.stringify({
            error: {
              message: `agy CLI reported an error: ${resultError}`,
              type: 'antigravity_cli_error'
            }
          }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
          return;
        }

        const responseContent =
          finalResultText ??
          (deltaAccumulated.trim() || plainLines.join('\n').trim() || cleanStderr);

        if (!responseContent) {
          resolve(new Response(JSON.stringify({
            error: {
              message: 'agy CLI exited with code 0 but produced no output',
              type: 'antigravity_cli_error'
            }
          }), { status: 502, headers: { 'Content-Type': 'application/json' } }));
          return;
        }

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
    } else if (i === conversationTurns.length - 1 && includedTurns.length === 0) {
      // The newest turn ALONE exceeds the remaining budget. Dropping it
      // (the old behavior) sent the CLI a prompt containing none of the
      // user's message — only the history-omitted note below. Truncate
      // the turn byte-safely instead and mark the truncation inline.
      // (4 spare bytes cover a multibyte codepoint split by the cut
      // decoding to U+FFFD.)
      const prefix = `[${conversationTurns[i].role}]: `;
      const truncNote = '\n[Eluvix Note: Latest message truncated to stay within argument limit]';
      // When older turns exist they are omitted, which adds the
      // history-omitted note (plus its separator) to the assembled
      // prompt — reserve room for it so the total stays within budget.
      const omitReserve = i > 0
        ? Buffer.byteLength('[Eluvix Note: Prior conversation history omitted to stay within argument limit]', 'utf8') + 2
        : 0;
      const avail =
        remainingBudget - 2 - Buffer.byteLength(prefix, 'utf8') - Buffer.byteLength(truncNote, 'utf8') - omitReserve - 4;
      if (avail > 0) {
        const textBuf = Buffer.from(conversationTurns[i].text, 'utf8');
        const truncated = prefix + textBuf.subarray(0, avail).toString('utf8') + truncNote;
        includedTurns.unshift(truncated);
        currentBytes += Buffer.byteLength(truncated, 'utf8') + 2;
        if (i > 0) omittedTurns = true;
      } else {
        omittedTurns = true;
      }
      break;
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

/**
 * Invalidate one user's cached responses on every live router instance
 * in this process (audit M-10). Callers that delete or clear a user's
 * memories (the Next.js memory routes) invoke this so answers derived
 * from those memories stop being served immediately. Returns the total
 * number of entries removed.
 */
export function invalidateUserCache(userId: string): number {
  let removed = 0;
  for (const ref of [...liveRouterInstances]) {
    const router = ref.deref();
    if (!router) {
      liveRouterInstances.delete(ref);
      continue;
    }
    removed += router.invalidateUserCache(userId);
  }
  return removed;
}

export { Eluvix as LibreRouter, Eluvix as NodeRouter };
