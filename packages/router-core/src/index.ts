import type { PromptGuardConfig, PrivacyGuardConfig } from './guard.js';
import type { EnclaveArchitectureId } from './tee-attestation.js';
import type { QuantizationConfig, QuantizationPolicy } from './microscaling-quantization.js';
import type { FabricOverlayConfig, FabricRoutingPolicy } from './clos-fabric-routing.js';
import {
  type CrsOverlayConfig,
  type CrsPolicy,
  analyzePromptForCrsTriage
} from './neuro-symbolic-crs.js';
import {
  type VectorCraftMcpConfig,
  buildVectorCraftSystemInstructions,
  buildVectorCraftCliArgs,
  isVectorArtPrompt
} from './vectorcraft-mcp.js';
import {
  type ArtCraftMcpConfig,
  buildArtCraftSystemInstructions,
  buildArtCraftCliArgs,
  detectArtCraftAppsForPrompt,
  isArtCraftPrompt,
  resolveSelectedArtCraftApps
} from './artcraft-mcp.js';
import {
  type AttentionKernelBackend,
  type AttentionKernelConfig,
  type AttentionRoutingPolicy,
  FLASH_ATTENTION_BENCHMARK_TABLE
} from './flash-attention-kernels.js';

export type RoutingStrategy = 
  | 'cost-complexity' 
  | 'cascade-cost' 
  | 'lowest-cost' 
  | 'lowest-latency' 
  | 'round-robin' 
  | 'priority'
  | 'prefill-isolation'
  | 'stall-escalation'
  | 'thompson-bandit';

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
  /**
   * Rail-Optimized Clos Fabric routing policy (NCCL PxN, BGP Unnumbered EVPN, SRv6 uSID, DLB + OOO-DDP).
   */
  fabricPolicy?: FabricRoutingPolicy;
  /**
   * Neuro-Symbolic Cyber Reasoning System (CRS) & Backward Program Slicing policy.
   */
  crsPolicy?: CrsPolicy;
  /**
   * FlashAttention-3 Warp-Specialized (WGMMA + TMA Ping-Pong) & Blackwell tcgen05 + TMEM routing policy.
   */
  attentionPolicy?: AttentionRoutingPolicy;
  /**
   * Modality-aware media intent routing: when `model === 'auto'`, explicit visual/video/3D
   * synthesis prompts automatically steer to `ComfyUINode` upstreams while standard text/code
   * prompts isolate away from `ComfyUINode`. Defaults to true.
   */
  mediaIntentRouting?: boolean;
  /**
   * Rolling 24-hour cloud spend ceiling in USD (`> 0`). When 24h cloud spend reaches or
   * exceeds this cap, Switchyard enforces `budgetExhaustedAction`.
   */
  maxDailySpendUsd?: number;
  /**
   * Action taken when 24h rolling cloud spend >= `maxDailySpendUsd`:
   * - `'prefer-local'` (default): soft-failover to `$0.00` local/CLI upstreams whenever available.
   * - `'strict-local'`: strictly restrict to `$0.00` local/CLI upstreams and fail closed (429) if none exist.
   * - `'reject'`: immediately reject requests with HTTP 429 until rolling 24h spend drops below the cap.
   */
  budgetExhaustedAction?: BudgetExhaustedAction;
  /**
   * When true, disables automatic capability-tier aliasing for unconfigured foreign
   * vendor model IDs (`claude-*`, `gpt-4o*`, `o1*`, `o3*`) and requires an explicit
   * or wildcard upstream match. Defaults to false.
   */
  strictModelMatch?: boolean;
}

export type BudgetExhaustedAction = 'prefer-local' | 'strict-local' | 'reject';

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
   *
   * Scope note (audit M-7): the policy constrains UPSTREAM SELECTION
   * only. Two configured channels sit outside it: an external memory
   * provider (mem0/OpenViking — recall sends the user's last message to
   * the configured endpoint on every request) and the provider agent
   * (registration/heartbeat to its serverUrl). The router logs a loud
   * startup warning naming any non-local exception channels rather than
   * letting the policy's guarantee read as total.
   */
  egressPolicy?: EgressPolicy;
  confidentialPolicy?: ConfidentialPolicy;
  quantizationPolicy?: QuantizationPolicy;
  fabricPolicy?: FabricRoutingPolicy;
  crsPolicy?: CrsPolicy;
  attentionPolicy?: AttentionRoutingPolicy;
  fallbackStrategy?: 'round-robin' | 'priority';
  switchyard?: SwitchyardConfig;
  modelGateway?: ModelGatewayConfig;
  promptGuard?: PromptGuardConfig & { action?: 'block' | 'strip' | 'divert' | 'warn' };
  privacyGuard?: PrivacyGuardConfig;
  outputGuard?: OutputGuardConfig;
  observability?: ObservabilityExporterConfig;
  memory?: MemoryConfig;
  knowledge?: KnowledgeBaseConfig;
  cache?: CacheConfig;
  sandbox?: SandboxConfig;
  consensusGroups?: ConsensusGroupConfig[];
  fallbackChains?: FallbackChainConfig[];
  cascade?: SpeculativeCascadeConfig;
  vramArbiter?: VramArbiterConfig;
  vectorcraft?: VectorCraftMcpConfig;
  artcraft?: ArtCraftMcpConfig;
}

export * from './paths.js';
export * from './db.js';
export * from './tls.js';
export * from './guard.js';
export * from './auth.js';
export * from './ldap.js';
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
export * from './clos-fabric-routing.js';
export * from './neuro-symbolic-crs.js';
export * from './vectorcraft-mcp.js';
export * from './artcraft-mcp.js';
export * from './comfyui.js';
export * from './comfyui-postprocess.js';
export * from './modality.js';
export * from './ssrf-guard.js';
export * from './flash-attention-kernels.js';
export * from './shell-utils.js';
export * from './protocol-adapters.js';
export * from './audio.js';
export * from './cascade.js';
export * from './distillation.js';
export * from './vram-arbiter.js';
export * from './mcp-server.js';
export * from './evals.js';
export * from './structured-outputs.js';
export * from './output-guard.js';
export * from './otel-exporter.js';
export * from './audit.js';
export * from './secrets.js';
export * from './engine-signals.js';
export * from './batches.js';
export * from './rerank.js';
export * from './prompt-registry.js';
export * from './webhooks.js';
import { resolveUpstreamSecret } from './secrets.js';
import {
  getCachedEngineSignal,
  computeEngineLoadScoreAdjustment,
  formatEngineLoadHeader,
} from './engine-signals.js';
import { resolvePromptTemplate } from './prompt-registry.js';
import { executeRerankRequest, type RerankRequest } from './rerank.js';
import {
  extractResponseFormatSpec,
  supportsStructuredOutputs,
  translateStructuredOutputFormat,
  validateAgainstJsonSchema,
} from './structured-outputs.js';
import {
  type OutputGuardConfig,
  applyOutputGuardToChatCompletionJson,
  createStreamingOutputDlpTransform,
} from './output-guard.js';
import {
  type ObservabilityExporterConfig,
  type OtelChildSpanInput,
  OtlpTraceExporter,
} from './otel-exporter.js';
import { validateUpstreamHttpEndpoint } from './ssrf-guard.js';
import { globalVramArbiter, type VramArbiterConfig } from './vram-arbiter.js';
import {
  evaluateDraftQuality,
  extractChoiceLogprobs,
  synthesizeOpenAiSseFromText,
  rankUpstreamsWithThompsonBandit,
  type SpeculativeCascadeConfig,
} from './cascade.js';
import { captureDistillationPair } from './distillation.js';
import {
  resolveVirtualVendorModel,
  normalizeEmbeddingVector,
  encodeFloat32VectorBase64,
  type VendorModelAliasResult,
} from './protocol-adapters.js';
import {
  type AudioVoiceConfig,
  type AudioResponseFormat,
  type TranscriptionResponseFormat,
  STT_BACKEND_PRESETS,
  TTS_BACKEND_PRESETS,
  isDedicatedAudioUpstreamType,
  inferAudioMimeType,
} from './audio.js';
import {
  ComfyUIConfig,
  buildComfyApiWorkflow,
  parseComfyModelsResponse,
  executeComfyWorkflow,
  fetchComfyMediaAsBase64
} from './comfyui.js';
import { executeArtCraftPostProcess } from './comfyui-postprocess.js';
import {
  classifyRequestModality,
  isExplicitMediaModelId,
  type ModalityProfile
} from './modality.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
export * from './provider.js';
export * from './antigravity-models.js';
export * from './fetch-policy.js';
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
import { fetchWithSafeRedirects, assertEndpointNotMetadata } from './fetch-policy.js';
import * as dbModule from './db.js';

function logRequest(...args: Parameters<typeof dbModule.logRequest>) {
  return dbModule.logRequest(...args);
}
function getRequestLogs(...args: Parameters<typeof dbModule.getRequestLogs>) {
  return dbModule.getRequestLogs(...args);
}
function getProviderSettings(...args: Parameters<typeof dbModule.getProviderSettings>) {
  return dbModule.getProviderSettings(...args);
}
function getRollingSpendUsd(...args: Parameters<typeof dbModule.getRollingSpendUsd>) {
  return dbModule.getRollingSpendUsd(...args);
}
function getBanditArmsForTier(tier: string) {
  try {
    if (typeof (dbModule as any).getBanditArmsForTier === 'function') {
      return dbModule.getBanditArmsForTier(tier);
    }
  } catch {
    // Tolerate partial ../db.js mocks in unit tests
  }
  return [];
}
function recordBanditArmOutcome(params: Parameters<typeof dbModule.recordBanditArmOutcome>[0]) {
  try {
    if (typeof (dbModule as any).recordBanditArmOutcome === 'function') {
      dbModule.recordBanditArmOutcome(params);
    }
  } catch {
    // Tolerate partial ../db.js mocks in unit tests
  }
}
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
    | 'clos-fabric-routing'
    | 'neuro-symbolic-crs'
    | 'flash-attention-kernel'
    | 'memory'
    | 'memory-egress'
    | 'knowledge-rag'
    | 'modality-filter'
    | 'vision-filter'
    | 'tools-filter'
    | 'structured-outputs-filter'
    | 'budget-guardrail'
    | 'circuit-breaker'
    | 'fallback-chain'
    | 'consensus'
    | 'prefill-isolation'
    | 'kv-prefix-affinity'
    | 'speculative-cascade'
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
  modality?: ModalityProfile;
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
  | 'ramalama'
  | 'comfyui'
  | 'audio'
  | 'whisper'
  | 'speaches'
  | 'kokoro-tts'
  | 'antigravity'
  | 'harness';

export interface RamalamaConfig {
  containerEngine?: 'podman' | 'docker' | 'nocontainer';
  runtime?: 'llama.cpp' | 'vllm' | 'mlx';
  ociTransport?: 'oci' | 'hf' | 'ollama' | 'rlcr';
  accelerator?: 'auto' | 'cuda' | 'rocm' | 'vulkan' | 'intel';
  selinuxEnforcing?: boolean;
  networkIsolation?: 'bridge' | 'none' | 'host';
  readOnlyRootfs?: boolean;
  tempContainer?: boolean;
  ragOciUri?: string;
  generateMode?: 'none' | 'quadlet' | 'kube' | 'compose';
  ctxSize?: number;
  ngl?: number;
}

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
  /**
   * Prompt cache read discount multiplier (default `0.1` = 90% discount on cached input tokens).
   */
  cacheReadMultiplier?: number;
  /**
   * Prompt cache creation/write multiplier (default `1.25` on Anthropic cache writes).
   */
  cacheWriteMultiplier?: number;
  tier?: string;
  tierName?: string;
  maxComplexityScore?: number;
  maxContextTokens?: number;
  maxParallelRequests?: number;
  monthlySpendLimit?: number;
  latencyMs?: number;
  capabilities?: string[];
  antigravity?: AntigravityConfig;
  codex?: any;
  claudeCode?: any;
  organization?: string;
  harness?: HarnessConfig;
  disaggregation?: DisaggregationConfig;
  confidential?: ConfidentialComputeConfig;
  quantization?: QuantizationConfig;
  fabric?: FabricOverlayConfig;
  crs?: CrsOverlayConfig;
  vectorcraft?: VectorCraftMcpConfig;
  artcraft?: ArtCraftMcpConfig;
  attentionKernel?: AttentionKernelConfig;
  ramalama?: RamalamaConfig;
  comfyui?: ComfyUIConfig;
  audio?: AudioVoiceConfig;
  supportsStructuredOutputs?: boolean;
}

export {
  isCloudMetadataEndpoint,
  isLocalUpstream,
  getEffectiveCostPer1kTokens,
  estimateUpstreamRequestCostUsd,
  isVisionCapableUpstream,
  type CacheTokenUsage,
} from './cost.js';
import {
  isLocalUpstream,
  getEffectiveCostPer1kTokens,
  estimateUpstreamRequestCostUsd,
  isVisionCapableUpstream,
} from './cost.js';
export {
  resolveEffectiveAttentionBackend,
  isWarpSpecializedAttentionUpstream,
  isFp8PingPongAttentionUpstream,
  isLegacySynchronousAttentionUpstream,
  isNeuroSymbolicCrsUpstream,
  isCollisionFreeRailFabricUpstream,
  isLegacyEcmpFabricUpstream,
  isLosslessSub4BitUpstream,
  isNaiveSub4BitUpstream,
  isConfidentialEnclaveUpstream,
} from './routing/candidates.js';
import {
  resolveEffectiveAttentionBackend,
  isWarpSpecializedAttentionUpstream,
  isFp8PingPongAttentionUpstream,
  isLegacySynchronousAttentionUpstream,
  isNeuroSymbolicCrsUpstream,
  isCollisionFreeRailFabricUpstream,
  isLegacyEcmpFabricUpstream,
  isLosslessSub4BitUpstream,
  isNaiveSub4BitUpstream,
  isConfidentialEnclaveUpstream,
} from './routing/candidates.js';
export {
  type PromptComplexityAssessment,
  type RouterDeps,
  computeKvPrefixHash,
  estimatePromptComplexity,
} from './routing/strategies.js';
import {
  type PromptComplexityAssessment,
  type RouterDeps,
  computeKvPrefixHash,
  estimatePromptComplexity,
} from './routing/strategies.js';
export {
  type DiscoveredModel,
  type UpstreamDiscoveryResult,
  detectUpstreamModelDetails,
  detectUpstreamModels,
  parseModelDetails,
  isAntigravitySupportedModel,
  buildCliPrompt,
} from './discovery.js';
import {
  detectUpstreamModels,
  isAntigravitySupportedModel,
  buildCliPrompt,
} from './discovery.js';
import {
  executeEmbeddingsForward,
  executeAudioTranscriptionForward,
  executeAudioSpeechForward,
} from './forwarders/embeddings-audio.js';

/**
 * Whether an endpoint URL's host is local (loopback, RFC1918, or a
 * .local/.lan/.internal name) — the host half of isLocalUpstream
 * (now in ./cost.js), shared with the egress-policy exception check,
 * which judges bare channel URLs (memory provider, provider-agent
 * server) rather than upstreams. Kept here because cost.js does not
 * export it.
 */
/**
 * Whether an endpoint URL's host is local (loopback, RFC1918, or a
 * .local/.lan/.internal name) — the host half of isLocalUpstream,
 * shared with the egress-policy exception check, which judges bare
 * channel URLs (memory provider, provider-agent server) rather than
 * upstreams.
 */
export function endpointHostIsLocal(endpoint: string): boolean {
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

function extractMessageText(content: string | MessageContentPart[] | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
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
  response_format?: any;
  stop?: string | string[];
  top_p?: number;
  seed?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  confidentialPolicy?: ConfidentialPolicy;
  quantizationPolicy?: QuantizationPolicy;
  fabricPolicy?: FabricRoutingPolicy;
  crsPolicy?: CrsPolicy;
  attentionPolicy?: AttentionRoutingPolicy;
}

/**
 * A ChatRequest whose model has been resolved. The public entry points
 * (routeChatCompletion, explainRoute) accept an optional model and default
 * it immediately (`request.model || config.defaultModel || 'auto'`); all
 * internal routing/forwarding code works with this type, so `model` is a
 * string there — exactly what the runtime already guarantees.
 */
export type ResolvedChatRequest = ChatRequest & { model: string };

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
  private deps?: RouterDeps;
  private roundRobinIndex: number = 0;
  private responseCache: Map<string, { response: any; timestamp: number; lastUserQuery?: string }> = new Map();
  private requestCounts: Map<string, { count: number; resetTime: number }> = new Map();
  private contextProvider: ContextProvider | null = null;
  private kvPrefixAffinityMap: Map<string, { upstreamId: string; timestamp: number }> = new Map();
  private otelExporter: OtlpTraceExporter;

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

  constructor(config: RouterConfig, deps?: RouterDeps) {
    liveRouterInstances.add(new WeakRef(this));
    this.deps = deps;
    this.config = {
      ...config,
      upstreams: [...(config.upstreams || [])].sort((a, b) => b.priority - a.priority)
    };
    this.otelExporter = new OtlpTraceExporter(this.config.observability);
    if (this.config.memory?.enabled) {
      this.contextProvider = createContextProvider(this.config.memory);
    }
    this.warnOnLocalOnlyEgressExceptions();
  }

  /**
   * egressPolicy 'local-only' constrains upstream SELECTION only (see
   * the enforcement in routeChatCompletion, and the scope note on
   * RouterConfig.egressPolicy). Two configured channels sit outside
   * that selection and would otherwise silently break the operator's
   * expectation that nothing leaves the machine: external memory
   * providers (recall POSTs the user's last message to the configured
   * endpoint on every request) and the provider agent (registration /
   * heartbeat POSTs hostname, GPU inventory, model catalog and node
   * token to its server). Per audit decision D9 these are NOT
   * hard-blocked; startup names them loudly instead.
   */
  private warnOnLocalOnlyEgressExceptions(): void {
    if (this.config.egressPolicy !== 'local-only') return;
    const exceptions: string[] = [];

    const memory = this.config.memory;
    if (memory?.enabled && memory.provider && memory.provider !== 'builtin' && memory.endpoint) {
      if (!endpointHostIsLocal(memory.endpoint)) {
        exceptions.push(
          `memory provider "${memory.provider}" endpoint ${memory.endpoint} (recall sends the user's last message to it on every request)`
        );
      }
    }

    try {
      const providerSettings = getProviderSettings();
      if (providerSettings?.enabled) {
        const serverUrl = providerSettings.server_url || 'https://api.billama.dev';
        if (!endpointHostIsLocal(serverUrl)) {
          exceptions.push(
            `provider agent server ${serverUrl} (registration/heartbeat posts hostname, GPU inventory, model catalog and node token to it)`
          );
        }
      }
    } catch {
      // Provider settings are optional; an unreadable settings store
      // must never break router construction.
    }

    if (exceptions.length > 0) {
      console.warn(
        `[Switchyard Egress] WARNING: egressPolicy=local-only constrains upstream selection only — ` +
          `it does NOT cover these configured channels, which will still leave this machine: ${exceptions.join('; ')}`
      );
    }
  }

  public getOtelExporter(): OtlpTraceExporter {
    return this.otelExporter;
  }

  public async flushTraces(): Promise<{ sent: number; ok: boolean; error?: string }> {
    return this.otelExporter.flush(this.deps?.fetch || globalThis.fetch);
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
    let knowledgeTainted = false;
    let memoryStatus = 'disabled';
    let knowledgeStatus = 'disabled';
    let memoryTokens = 0;
    let knowledgeTokens = 0;
    let memoryDigest = '';
    let knowledgeDigest = '';
    let lastUserQuery = '';

    // Neutralize any client-supplied delimiter tags so user input cannot forge memory or knowledge blocks
    if (effectiveRequest.messages && effectiveRequest.messages.length > 0) {
      effectiveRequest = {
        ...effectiveRequest,
        messages: effectiveRequest.messages.map(m => {
          if (typeof m.content === 'string') {
            if (/<\/?eluvix-(?:memory|knowledge)/i.test(m.content)) {
              return {
                ...m,
                content: m.content
                  .replace(/<(\/)?eluvix-memory([^>]*)>/gi, '&lt;$1eluvix-memory$2&gt;')
                  .replace(/<(\/)?eluvix-knowledge([^>]*)>/gi, '&lt;$1eluvix-knowledge$2&gt;')
              };
            }
          } else if (Array.isArray(m.content)) {
            const hasTag = m.content.some(
              (p: any) => p?.type === 'text' && typeof p?.text === 'string' && /<\/?eluvix-(?:memory|knowledge)/i.test(p.text)
            );
            if (hasTag) {
              return {
                ...m,
                content: m.content.map((p: any) => {
                  if (p?.type === 'text' && typeof p?.text === 'string') {
                    return {
                      ...p,
                      text: p.text
                        .replace(/<(\/)?eluvix-memory([^>]*)>/gi, '&lt;$1eluvix-memory$2&gt;')
                        .replace(/<(\/)?eluvix-knowledge([^>]*)>/gi, '&lt;$1eluvix-knowledge$2&gt;')
                    };
                  }
                  return p;
                })
              };
            }
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
    knowledgeStatus = 'disabled';
    knowledgeTokens = 0;
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
            knowledgeTainted = true;
            knowledgeDigest = crypto.createHash('sha256').update(kbBlock).digest('hex').slice(0, 12);
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
      const userKey = scope?.userId || 'global';
      const windowKey = `${userKey}:${Math.floor(now / 60000)}`;
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

    // 0e. System Prompt Prepend & Versioned Prompt Registry Resolution
    let resolvedPromptHeader: string | null = null;
    const rawPromptRef =
      typeof effectiveRequest.metadata?.promptRef === 'string'
        ? effectiveRequest.metadata.promptRef.trim()
        : typeof (effectiveRequest as any).prompt_id === 'string'
        ? String((effectiveRequest as any).prompt_id).trim()
        : '';
    if (rawPromptRef && effectiveRequest.messages) {
      const resolvedPrompt = resolvePromptTemplate(
        rawPromptRef,
        effectiveRequest.metadata?.promptVariables
      );
      if (resolvedPrompt) {
        resolvedPromptHeader = `${resolvedPrompt.promptId}@v${resolvedPrompt.version}`;
        const clonedMsgs = effectiveRequest.messages.map(m => ({ ...m }));
        const firstSys = clonedMsgs.find(m => m.role === 'system');
        if (firstSys && typeof firstSys.content === 'string') {
          firstSys.content = `${resolvedPrompt.renderedSystemPrompt}\n\n${firstSys.content}`;
          effectiveRequest = { ...effectiveRequest, messages: clonedMsgs };
        } else {
          effectiveRequest = {
            ...effectiveRequest,
            messages: [
              { role: 'system', content: resolvedPrompt.renderedSystemPrompt },
              ...clonedMsgs,
            ],
          };
        }
        if (
          effectiveRequest.model === 'auto' &&
          resolvedPrompt.modelHint &&
          resolvedPrompt.modelHint !== 'auto'
        ) {
          effectiveRequest = { ...effectiveRequest, model: resolvedPrompt.modelHint };
        }
      }
    }

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
        knowledgeTainted,
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
      if (err?.quantizationUnavailable) {
        return new Response(
          JSON.stringify({
            error: {
              message: err.message,
              type: 'quantization_unavailable',
              code: 'microscaling_quantization_required'
            }
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'x-eluvix-quantization-guard': 'DENIED_QUANTIZATION_MISMATCH'
            }
          }
        );
      }
      if (err?.fabricUnavailable) {
        return new Response(
          JSON.stringify({
            error: {
              message: err.message,
              type: 'fabric_unavailable',
              code: 'clos_fabric_required'
            }
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'x-eluvix-fabric-guard': 'DENIED_FABRIC_COLLISION'
            }
          }
        );
      }
      if (err?.crsUnavailable) {
        return new Response(
          JSON.stringify({
            error: {
              message: err.message,
              type: 'crs_unavailable',
              code: 'neuro_symbolic_crs_required'
            }
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'x-eluvix-crs-guard': 'DENIED_CRS_VERIFIER_REQUIRED'
            }
          }
        );
      }
      if (err?.attentionKernelUnavailable) {
        return new Response(
          JSON.stringify({
            error: {
              message: err.message,
              type: 'attention_kernel_unavailable',
              code: 'warp_specialized_attention_required'
            }
          }),
          {
            status: 503,
            headers: {
              'Content-Type': 'application/json',
              'x-eluvix-attention-guard': 'DENIED_SYNCHRONOUS_KERNEL'
            }
          }
        );
      }
      if (err?.budgetCapExceeded) {
        return new Response(
          JSON.stringify({
            error: {
              message: err.message,
              type: 'budget_exceeded',
              code: 'daily_spend_cap_exceeded'
            }
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'x-eluvix-budget-guard': 'DENIED_DAILY_SPEND_CAP',
              ...(typeof err.rolling24hSpendUsd === 'number'
                ? { 'x-eluvix-rolling-24h-spend-usd': err.rolling24hSpendUsd.toFixed(6) }
                : {})
            }
          }
        );
      }
      throw err;
    }
    effectiveRequest = selection.effectiveRequest;
    const complexity = selection.complexity;
    let targetUpstreams = selection.targetUpstreams;

    // 0e1. Neuro-Symbolic CRS Triage & Backward Program Slicing Context Enrichment
    const activeCrsPolicy: CrsPolicy =
      (effectiveRequest.metadata?.crsPolicy as CrsPolicy | undefined) ||
      this.config.switchyard?.crsPolicy ||
      this.config.crsPolicy ||
      'disabled';
    const isStallEscalationStrategy =
      (this.config.switchyard?.strategy || this.config.strategy) === 'stall-escalation';
    const hasCrsUpstreamSelected = targetUpstreams.some(u => isNeuroSymbolicCrsUpstream(u));
    let crsTriageResult: ReturnType<typeof analyzePromptForCrsTriage> | null = null;

    const rawCachePrefix =
      typeof effectiveRequest.metadata?._cachePrefixText === 'string' &&
      effectiveRequest.metadata._cachePrefixText.trim()
        ? effectiveRequest.metadata._cachePrefixText.trim()
        : '';
    const preInjectionPrefixHash = rawCachePrefix
      ? crypto.createHash('sha256').update(rawCachePrefix).digest('hex').slice(0, 12)
      : computeKvPrefixHash(effectiveRequest.messages || []);

    if (
      (activeCrsPolicy !== 'disabled' || isStallEscalationStrategy || hasCrsUpstreamSelected) &&
      Array.isArray(effectiveRequest.messages) &&
      effectiveRequest.messages.length > 0
    ) {
      const combinedUserText = effectiveRequest.messages
        .filter(m => m.role !== 'system')
        .map(m => extractMessageText(m.content))
        .join('\n');
      const primaryCrsConfig = targetUpstreams.find(u => u.crs?.enabled)?.crs;
      crsTriageResult = analyzePromptForCrsTriage(combinedUserText, primaryCrsConfig);
      if (crsTriageResult.detected && crsTriageResult.systemBlock) {
        effectiveRequest = {
          ...effectiveRequest,
          messages: injectMemoryIntoMessages(effectiveRequest.messages, crsTriageResult.systemBlock)
        };
      }
    }

    // 0e1b. VectorCraft & ArtCraft Suite MCP Context & Workflow Prompt Enrichment
    const upstreamVcConfig = targetUpstreams.find(u => u.vectorcraft?.enabled)?.vectorcraft;
    const activeVcConfig = upstreamVcConfig || (this.config.vectorcraft?.enabled ? this.config.vectorcraft : undefined);
    let vectorcraftActive = false;
    if (
      activeVcConfig &&
      activeVcConfig.enabled !== false &&
      Array.isArray(effectiveRequest.messages) &&
      effectiveRequest.messages.length > 0
    ) {
      const combinedUserText = effectiveRequest.messages
        .filter(m => m.role !== 'system')
        .map(m => extractMessageText(m.content))
        .join('\n');
      const activePreset = activeVcConfig.defaultPromptWorkflow || activeVcConfig.promptPreset;
      if (
        upstreamVcConfig ||
        (activePreset && activePreset !== 'none') ||
        isVectorArtPrompt(combinedUserText)
      ) {
        vectorcraftActive = true;
        if (activeVcConfig.injectSystemInstructions !== false) {
          const vcSystemBlock = buildVectorCraftSystemInstructions(activeVcConfig);
          effectiveRequest = {
            ...effectiveRequest,
            messages: injectMemoryIntoMessages(effectiveRequest.messages, vcSystemBlock)
          };
        }
      }
    }

    const upstreamAcConfig = targetUpstreams.find(u => u.artcraft?.enabled)?.artcraft;
    const activeAcConfig = upstreamAcConfig || (this.config.artcraft?.enabled ? this.config.artcraft : undefined);
    let artcraftActive = false;
    let detectedArtCraftApps: string[] = [];
    if (
      activeAcConfig &&
      activeAcConfig.enabled !== false &&
      Array.isArray(effectiveRequest.messages) &&
      effectiveRequest.messages.length > 0
    ) {
      const combinedUserText = effectiveRequest.messages
        .filter(m => m.role !== 'system')
        .map(m => extractMessageText(m.content))
        .join('\n');
      detectedArtCraftApps = detectArtCraftAppsForPrompt(combinedUserText);
      const activePreset = activeAcConfig.defaultPromptWorkflow || activeAcConfig.promptPreset;
      if (
        upstreamAcConfig ||
        (activePreset && activePreset !== 'none') ||
        isArtCraftPrompt(combinedUserText, activeAcConfig.app)
      ) {
        artcraftActive = true;
        if (activeAcConfig.injectSystemInstructions !== false) {
          const selectedAcApps = resolveSelectedArtCraftApps(activeAcConfig);
          const dedupedAcApps =
            vectorcraftActive && activeVcConfig?.injectSystemInstructions !== false
              ? selectedAcApps.filter(a => a !== 'vectorcraft')
              : selectedAcApps;
          if (dedupedAcApps.length > 0) {
            const acSystemBlock = buildArtCraftSystemInstructions({
              ...activeAcConfig,
              app: dedupedAcApps[0],
              enabledApps: dedupedAcApps
            });
            effectiveRequest = {
              ...effectiveRequest,
              messages: injectMemoryIntoMessages(effectiveRequest.messages, acSystemBlock)
            };
          }
        }
      }
    }

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
        maxTokens: (effectiveRequest as any).max_tokens ?? null,
        // Everything else that changes the response. Omitting these served
        // a plain-text answer to a JSON-mode caller, ignored stop sequences,
        // and served one seed's output to another seed's request.
        responseFormat: (effectiveRequest as any).response_format ?? null,
        stop: (effectiveRequest as any).stop ?? null,
        seed: (effectiveRequest as any).seed ?? null,
        presencePenalty: (effectiveRequest as any).presence_penalty ?? null,
        frequencyPenalty: (effectiveRequest as any).frequency_penalty ?? null,
        maxCompletionTokens: (effectiveRequest as any).max_completion_tokens ?? null
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
            knowledgeAllowCloudEgress: this.config.knowledge?.allowCloudEgress ?? null,
            knowledgeCloudMode: this.config.knowledge?.cloudMode ?? null,
            knowledgeTainted,
            knowledgeDigest,
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
          : isolation === 'global' && !memoryTainted && !knowledgeTainted
          ? 'global'
          : `${encodeURIComponent(scope.userId)}:${memoryDigest || 'nomem'}:${knowledgeDigest || 'noknow'}`;
      cacheKey = `v2:${scopePrefix}:${routingDigest}:${effectiveRequest.model || 'default'}:${variantKey}:${JSON.stringify(effectiveRequest.messages)}`;
      let cached = this.responseCache.get(cacheKey) as
        | { response: any; timestamp: number }
        | undefined;
      const ttlMs = (cacheConfig.ttlSeconds ?? 3600) * 1000;
      if (cached && Date.now() - cached.timestamp >= ttlMs) {
        // Expired entries are deleted, not just ignored — otherwise they
        // accumulate forever behind keys that are never asked for again.
        this.responseCache.delete(cacheKey);
        cached = undefined;
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
            if (Date.now() - entry.timestamp >= ttlMs) {
              this.responseCache.delete(k);
              continue;
            }
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
        // Cache hits used to skip request logging entirely, leaving served
        // responses invisible in request history/analytics.
        logRequest({
          model: (cached.response as any)?.model || effectiveRequest.model,
          upstream_id: 'cache',
          status: 200,
          duration_ms: 0,
          prompt_tokens: complexity.tokenEstimate,
          completion_tokens: (cached.response as any)?.usage?.completion_tokens || 0,
          user_id: scope.userId
        });
        return new Response(JSON.stringify(cached.response), {
          status: 200,
          headers: hitHeaders
        });
      }
      }
    }

    const switchyardConfig = this.config.switchyard || {};
    const routeStartTime = Date.now();
    const canRemember =
      Boolean(this.contextProvider) &&
      Boolean(this.config.memory?.enabled) &&
      this.config.memory?.writeBack !== false &&
      lastUserQuery.trim().length > 0;

    // Consensus Group Execution (Mixture-of-Agents / Parallel Judge / Fastest-First)
    const activeConsensus = this.config.consensusGroups?.[0];
    if (
      activeConsensus &&
      Array.isArray(activeConsensus.candidateUpstreamIds) &&
      activeConsensus.candidateUpstreamIds.length >= 2
    ) {
      const idSet = new Set(activeConsensus.candidateUpstreamIds);
      let consensusCandidates = targetUpstreams.filter((u) => idSet.has(u.id) && globalCircuitBreaker.isAllowed(u.id, activeConsensus.failureThreshold ?? 3, activeConsensus.cooldownSeconds ?? 60));
      if (consensusCandidates.length >= 2) {
        if (switchyardConfig.maxCostPerRequest != null) {
          const estimatedCost = consensusCandidates.reduce((acc, u) => {
            return acc + (u.costPer1kTokens != null ? (complexity.tokenEstimate / 1000) * u.costPer1kTokens : 0);
          }, 0);
          if (estimatedCost > switchyardConfig.maxCostPerRequest) {
            console.warn(`[ConsensusGroup] Estimated consensus fan-out cost ($${estimatedCost.toFixed(4)}) exceeds ceiling ($${switchyardConfig.maxCostPerRequest}). Skipping consensus.`);
            consensusCandidates = [];
          }
        }
      }
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
              if (
                knowledgeTainted &&
                !this.config.knowledge?.allowCloudEgress &&
                this.config.knowledge?.cloudMode === 'strip' &&
                !isLocalUpstream(u) &&
                reqForCandidate.messages
              ) {
                reqForCandidate = {
                  ...reqForCandidate,
                  messages: stripKnowledgeFromMessages(reqForCandidate.messages)
                };
              }
              return this.forwardRequest(u, reqForCandidate, consensusTimeout, sig, complexity.score, scope, hops);
            },
            options?.signal
          );

          for (const u of consensusCandidates) {
            globalCircuitBreaker.recordSuccess(u.id);
          }
          if (this.config.memory?.enabled) {
            consensusRes.headers.set('x-eluvix-memory', memoryStatus);
          }
          if (this.config.knowledge?.enabled) {
            consensusRes.headers.set('x-eluvix-knowledge', knowledgeStatus);
          }
          consensusRes.headers.set('x-eluvix-consensus-group', activeConsensus.id);

          const duration_ms = Date.now() - routeStartTime;
          let assistantOutputText = '';
          let promptTokens = complexity.tokenEstimate;
          let completionTokens = 0;

          if (!effectiveRequest.stream) {
            try {
              const rawData = await consensusRes.clone().text();
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
            } catch {}

            if (canRemember && assistantOutputText.trim().length > 0 && this.contextProvider) {
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

            logRequest({
              model: activeConsensus.judgeModel || effectiveRequest.model,
              upstream_id: `consensus:${activeConsensus.id}`,
              status: consensusRes.status,
              duration_ms,
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              ttft_ms: duration_ms,
              itl_ms: undefined,
              kv_cache_kb: 0,
              user_id: scope.userId
            });
          } else if (
            effectiveRequest.stream &&
            consensusRes.body &&
            typeof (consensusRes.body as any).getReader === 'function'
          ) {
            // Streamed consensus turns used to vanish from memory and
            // request history: the block above gates remember() and
            // logRequest behind !stream, and no tee was applied. Tee the
            // synthesized SSE stream (it ends with [DONE]) like the
            // standard streaming path does.
            const consensusStreamStart = routeStartTime;
            const consensusProviderRef = canRemember ? this.contextProvider : undefined;
            const teeBody = teeSseStreamForMemory(
              consensusRes.body as ReadableStream<Uint8Array>,
              (fullAssistantText) => {
                if (consensusProviderRef && fullAssistantText.trim().length > 0) {
                  void consensusProviderRef
                    .remember(
                      {
                        user: { role: 'user', content: lastUserQuery },
                        assistant: fullAssistantText
                      },
                      scope
                    )
                    .catch(() => {});
                }
                logRequest({
                  model: activeConsensus.judgeModel || effectiveRequest.model,
                  upstream_id: `consensus:${activeConsensus.id}`,
                  status: consensusRes.status,
                  duration_ms: Date.now() - consensusStreamStart,
                  prompt_tokens: promptTokens,
                  completion_tokens: Math.max(1, Math.ceil(fullAssistantText.length / 4)),
                  ttft_ms: duration_ms,
                  itl_ms: undefined,
                  kv_cache_kb: 0,
                  user_id: scope.userId
                });
              }
            );
            return new Response(teeBody, {
              status: consensusRes.status,
              headers: consensusRes.headers
            });
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

    // 0f2. Live Engine Load Signals (Warm VRAM Residency Bonus & Queue Waiting Penalty)
    if (targetUpstreams.length > 1) {
      const anySignalPresent = targetUpstreams.some(u => getCachedEngineSignal(u.id) !== undefined);
      if (anySignalPresent) {
        const baseOrder = new Map(targetUpstreams.map((u, idx) => [u.id, idx]));
        targetUpstreams.sort((a, b) => {
          const sigA = getCachedEngineSignal(a.id);
          const sigB = getCachedEngineSignal(b.id);
          const adjA = computeEngineLoadScoreAdjustment(sigA, effectiveRequest.model).scoreDelta;
          const adjB = computeEngineLoadScoreAdjustment(sigB, effectiveRequest.model).scoreDelta;
          if (adjA !== adjB) return adjB - adjA;
          return (baseOrder.get(a.id) ?? 0) - (baseOrder.get(b.id) ?? 0);
        });
      }
    }

    const upstreamTimeout = switchyardConfig.timeoutMs ?? 60000;
    const retryCount = Math.max(1, switchyardConfig.retryCount ?? 1);
    const failoverBudgetMs = switchyardConfig.failoverBudgetMs ?? 120000;
    let attemptsMade = 0;
    let budgetExhausted = false;
    const activeChain = this.config.fallbackChains?.[0];

    const cascadeCfg = this.config.cascade;
    const expectJsonForCascade =
      effectiveRequest.response_format?.type === 'json_object' ||
      effectiveRequest.response_format?.type === 'json_schema';
    const expectCodeForCascade =
      complexity.features.some(f => f.includes('code')) ||
      /\b(?:write|implement|function|class|typescript|python|rust|golang|sql|bash)\b/i.test(lastUserQuery);

    let cascadeHeaderStatus: string | null = null;
    let cascadeEscalationReason: string | null = null;
    let rejectedDraftCapture: {
      upstreamId: string;
      model: string;
      text: string;
      reason: string;
    } | null = null;

    // Buffer-Verify Speculative Cascade (`#draft` -> `#verifier`)
    if (
      cascadeCfg?.enabled &&
      hops === 0 &&
      selection.modality.synthesisIntent === 'text' &&
      cascadeCfg.draftUpstreamId &&
      cascadeCfg.verifierUpstreamId
    ) {
      const draftUpstream = targetUpstreams.find(u => u.id === cascadeCfg.draftUpstreamId);
      const verifierUpstream = targetUpstreams.find(u => u.id === cascadeCfg.verifierUpstreamId);

      if (draftUpstream && verifierUpstream && draftUpstream.id !== verifierUpstream.id) {
        if (globalCircuitBreaker.isAllowed(draftUpstream.id)) {
          let draftReq: ResolvedChatRequest = {
            ...effectiveRequest,
            stream: false,
          };
          if (
            memoryTainted &&
            !this.config.memory?.allowCloudEgress &&
            this.config.memory?.cloudMode === 'strip' &&
            !isLocalUpstream(draftUpstream) &&
            draftReq.messages
          ) {
            draftReq = { ...draftReq, messages: stripMemoryFromMessages(draftReq.messages) };
          }
          if (
            knowledgeTainted &&
            !this.config.knowledge?.allowCloudEgress &&
            this.config.knowledge?.cloudMode === 'strip' &&
            !isLocalUpstream(draftUpstream) &&
            draftReq.messages
          ) {
            draftReq = { ...draftReq, messages: stripKnowledgeFromMessages(draftReq.messages) };
          }

          const draftBudgetMs = Math.max(250, cascadeCfg.maxDraftLatencyMs ?? 2500);
          const draftStart = Date.now();
          try {
            const draftRes = await this.forwardRequest(
              draftUpstream,
              draftReq,
              draftBudgetMs,
              options?.signal,
              complexity.score,
              scope,
              hops + 1
            );
            const draftDurationMs = Date.now() - draftStart;
            if (draftRes.ok) {
              const rawDraftBody = await draftRes.text();
              let parsedDraft: any = null;
              try {
                parsedDraft = JSON.parse(rawDraftBody);
              } catch {}
              const draftText =
                typeof parsedDraft?.choices?.[0]?.message?.content === 'string'
                  ? parsedDraft.choices[0].message.content
                  : '';
              const finishReason = parsedDraft?.choices?.[0]?.finish_reason ?? null;
              const hasToolCalls =
                Array.isArray(parsedDraft?.choices?.[0]?.message?.tool_calls) &&
                parsedDraft.choices[0].message.tool_calls.length > 0;
              const tokenLogprobs = extractChoiceLogprobs(parsedDraft);
              const draftServedModel =
                draftRes.headers.get('x-eluvix-model') || parsedDraft?.model || effectiveRequest.model;

              const verification = hasToolCalls
                ? { passed: true, confidence: 0.9, reasons: [] }
                : evaluateDraftQuality(draftText, {
                    confidenceThreshold: cascadeCfg.confidenceThreshold ?? 0.78,
                    validateJsonSchema: cascadeCfg.validateJsonSchema !== false,
                    validateCodeFences: cascadeCfg.validateCodeFences !== false,
                    expectJson: expectJsonForCascade,
                    jsonSchema: effectiveRequest.response_format?.json_schema || null,
                    expectCode: expectCodeForCascade,
                    tokenLogprobs,
                    finishReason,
                  });

              if (verification.passed && parsedDraft) {
                globalCircuitBreaker.recordSuccess(draftUpstream.id);
                const draftPromptTokens =
                  parsedDraft.usage?.prompt_tokens ?? complexity.tokenEstimate;
                const draftCompletionTokens =
                  parsedDraft.usage?.completion_tokens ??
                  Math.max(1, Math.ceil(draftText.length / 4));
                const draftCostUsd = estimateUpstreamRequestCostUsd(
                  draftUpstream,
                  draftPromptTokens,
                  draftCompletionTokens
                );
                recordBanditArmOutcome({
                  upstreamId: draftUpstream.id,
                  complexityTier: complexity.label,
                  success: true,
                  ttftMs: draftDurationMs,
                });
                logRequest({
                  model: draftServedModel,
                  upstream_id: draftUpstream.id,
                  status: 200,
                  duration_ms: draftDurationMs,
                  prompt_tokens: draftPromptTokens,
                  completion_tokens: draftCompletionTokens,
                  ttft_ms: draftDurationMs,
                  cost_usd: draftCostUsd,
                  user_id: scope?.userId || 'default',
                });

                if (cacheConfig?.enabled && cacheKey && !effectiveRequest.stream) {
                  this.setCachedResponse(cacheKey, parsedDraft, lastUserQuery);
                }
                if (canRemember && draftText.trim().length > 0 && this.contextProvider) {
                  void this.contextProvider
                    .remember(
                      { user: { role: 'user', content: lastUserQuery }, assistant: draftText },
                      scope
                    )
                    .catch(() => {});
                }

                const acceptedHeaders = new Headers(draftRes.headers);
                acceptedHeaders.set('x-eluvix-upstream', draftUpstream.id);
                acceptedHeaders.set('x-eluvix-model', draftServedModel);
                acceptedHeaders.set('x-eluvix-cascade', 'draft-accepted');
                acceptedHeaders.set('x-eluvix-cascade-confidence', String(verification.confidence));
                acceptedHeaders.set('x-eluvix-complexity', complexity.score.toString());
                acceptedHeaders.set('x-eluvix-tokens', String(draftPromptTokens));
                acceptedHeaders.set('x-eluvix-ttft-ms', String(draftDurationMs));
                acceptedHeaders.set('x-eluvix-cost-usd', draftCostUsd.toFixed(6));
                if (selection.vendorAlias?.aliasApplied) {
                  acceptedHeaders.set(
                    'x-eluvix-model-alias',
                    `${selection.vendorAlias.originalModel}->${draftServedModel} (tier:${selection.vendorAlias.targetTier || 'auto'})`
                  );
                }

                if (effectiveRequest.stream && !hasToolCalls) {
                  acceptedHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
                  acceptedHeaders.set('Cache-Control', 'no-cache');
                  const sseStream = synthesizeOpenAiSseFromText({
                    text: draftText,
                    model: draftServedModel,
                    id: parsedDraft.id,
                    finishReason: finishReason || 'stop',
                    usage: parsedDraft.usage,
                  });
                  return new Response(sseStream, { status: 200, headers: acceptedHeaders });
                }

                acceptedHeaders.set('Content-Type', 'application/json');
                return new Response(rawDraftBody, { status: 200, headers: acceptedHeaders });
              }

              // Draft failed quality/confidence gate: escalate cleanly to `#verifier`
              recordBanditArmOutcome({
                upstreamId: draftUpstream.id,
                complexityTier: complexity.label,
                success: false,
                weight: 0.5,
              });
              cascadeHeaderStatus = 'escalated-verifier';
              cascadeEscalationReason = verification.primaryReason || 'below_confidence_threshold';
              if (draftText.trim().length > 0) {
                rejectedDraftCapture = {
                  upstreamId: draftUpstream.id,
                  model: draftServedModel,
                  text: draftText,
                  reason: cascadeEscalationReason,
                };
              }
            } else {
              try {
                await draftRes.text();
              } catch {}
              globalCircuitBreaker.recordFailure(draftUpstream.id, activeChain?.failureThreshold ?? 3);
              recordBanditArmOutcome({
                upstreamId: draftUpstream.id,
                complexityTier: complexity.label,
                success: false,
              });
              cascadeHeaderStatus = 'escalated-verifier';
              cascadeEscalationReason = `draft_http_${draftRes.status}`;
            }
          } catch {
            globalCircuitBreaker.recordFailure(draftUpstream.id, activeChain?.failureThreshold ?? 3);
            recordBanditArmOutcome({
              upstreamId: draftUpstream.id,
              complexityTier: complexity.label,
              success: false,
            });
            cascadeHeaderStatus = 'escalated-verifier';
            cascadeEscalationReason = 'draft_timeout_or_error';
          }

          // Remove `#draft` from remaining candidates and promote `#verifier` to front
          targetUpstreams = [
            verifierUpstream,
            ...targetUpstreams.filter(u => u.id !== draftUpstream.id && u.id !== verifierUpstream.id),
          ];
        } else {
          cascadeHeaderStatus = 'escalated-verifier';
          cascadeEscalationReason = 'draft_circuit_open';
          targetUpstreams = [
            verifierUpstream,
            ...targetUpstreams.filter(u => u.id !== draftUpstream.id && u.id !== verifierUpstream.id),
          ];
        }
      } else if (!draftUpstream && verifierUpstream) {
        cascadeHeaderStatus = 'bypassed-draft-incapable';
        targetUpstreams = [
          verifierUpstream,
          ...targetUpstreams.filter(u => u.id !== verifierUpstream.id),
        ];
      }
    }

    const maybeTriggerAsyncDistillation = (
      teacherUpstream: UpstreamConfig,
      teacherModel: string,
      teacherText: string
    ) => {
      if (hops > 0 || !teacherText || teacherText.trim().length === 0) return;

      // 1. If we escalated from a non-empty `#draft`, persist `(prompt, verifierChosen, draftRejected)` immediately
      if (rejectedDraftCapture && rejectedDraftCapture.upstreamId !== teacherUpstream.id) {
        const draftRef = rejectedDraftCapture;
        queueMicrotask(() => {
          try {
            captureDistillationPair({
              userId: scope.userId,
              source: 'cascade-escalation',
              teacherUpstreamId: teacherUpstream.id,
              studentUpstreamId: draftRef.upstreamId,
              teacherModel,
              studentModel: draftRef.model,
              promptMessages: (request.messages || []) as Array<Record<string, any>>,
              chosenText: teacherText,
              rejectedText: draftRef.text,
              privacyConfig: this.config.privacyGuard,
              expectJson: expectJsonForCascade,
              expectCode: expectCodeForCascade,
            });
          } catch {}
        });
      }

      // 2. Async `#shadow-student` background mirroring
      const studentId = cascadeCfg?.shadowStudentUpstreamId;
      const sampleRate = cascadeCfg?.shadowSampleRate ?? 0;
      if (
        !studentId ||
        sampleRate <= 0 ||
        studentId === teacherUpstream.id ||
        studentId === rejectedDraftCapture?.upstreamId
      ) {
        return;
      }
      if (sampleRate < 1 && Math.random() >= sampleRate) {
        return;
      }
      const studentUpstream = this.config.upstreams.find(u => u.id === studentId);
      if (!studentUpstream) return;
      if (this.config.egressPolicy === 'local-only' && !isLocalUpstream(studentUpstream)) return;
      if (!globalCircuitBreaker.isAllowed(studentUpstream.id)) return;

      const shadowMessages = stripKnowledgeFromMessages(
        stripMemoryFromMessages(effectiveRequest.messages || [])
      );
      const shadowReq: ResolvedChatRequest = {
        model: 'auto',
        messages: shadowMessages,
        temperature: effectiveRequest.temperature,
        response_format: effectiveRequest.response_format,
        stream: false,
      };

      queueMicrotask(() => {
        void this.forwardRequest(
          studentUpstream,
          shadowReq,
          15000,
          undefined,
          complexity.score,
          { ...scope, origin: 'harness' },
          hops + 1
        )
          .then(async (studentRes) => {
            if (!studentRes.ok) return;
            const studentRaw = await studentRes.text();
            const studentJson = JSON.parse(studentRaw);
            const studentText =
              typeof studentJson?.choices?.[0]?.message?.content === 'string'
                ? studentJson.choices[0].message.content
                : '';
            const studentModel =
              studentRes.headers.get('x-eluvix-model') || studentJson?.model || 'student';
            captureDistillationPair({
              userId: scope.userId,
              source: 'shadow',
              teacherUpstreamId: teacherUpstream.id,
              studentUpstreamId: studentUpstream.id,
              teacherModel,
              studentModel,
              promptMessages: (request.messages || []) as Array<Record<string, any>>,
              chosenText: teacherText,
              rejectedText: studentText,
              privacyConfig: this.config.privacyGuard,
              expectJson: expectJsonForCascade,
              expectCode: expectCodeForCascade,
            });
          })
          .catch(() => {});
      });
    };

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

      let strippedKnowledgeForCloud = false;
      if (
        knowledgeTainted &&
        !this.config.knowledge?.allowCloudEgress &&
        this.config.knowledge?.cloudMode === 'strip' &&
        !isLocalUpstream(upstream) &&
        requestForUpstream.messages
      ) {
        requestForUpstream = {
          ...requestForUpstream,
          messages: stripKnowledgeFromMessages(requestForUpstream.messages)
        };
        strippedKnowledgeForCloud = true;
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
            let cacheReadTokens = parseInt(response.headers.get('x-eluvix-cache-read-tokens') || '0', 10) || 0;
            let cacheWriteTokens = parseInt(response.headers.get('x-eluvix-cache-write-tokens') || '0', 10) || 0;
            const servedModel = response.headers.get('x-eluvix-model') || effectiveRequest.model;
            const effortHeader = response.headers.get('x-eluvix-effort');
            const rfSpec = extractResponseFormatSpec(effectiveRequest);
            let schemaValidationHeader: 'native' | 'validated' | 'repaired' | 'escalated' | null = null;
            let outputGuardStatusHeader: string | null = null;
            let outputGuardRedactionsHeader = 0;

            let responseBody: any = response.body;
            let assistantOutputText = '';
            let schemaValidationFailed = false;

            if (!effectiveRequest.stream && response.headers.get('content-type')?.includes('application/json')) {
              try {
                let rawData = await response.text();
                let parsed = JSON.parse(rawData);
                if (parsed.usage?.completion_tokens != null) {
                  completionTokens = parsed.usage.completion_tokens;
                }
                if (parsed.usage?.prompt_tokens != null) {
                  promptTokens = parsed.usage.prompt_tokens;
                }
                const usageCacheRead =
                  parsed.usage?.cache_read_input_tokens ??
                  parsed.usage?.prompt_tokens_details?.cached_tokens;
                if (typeof usageCacheRead === 'number' && usageCacheRead > 0) {
                  cacheReadTokens = usageCacheRead;
                }
                const usageCacheWrite =
                  parsed.usage?.cache_creation_input_tokens ??
                  parsed.usage?.prompt_tokens_details?.cache_creation_tokens;
                if (typeof usageCacheWrite === 'number' && usageCacheWrite > 0) {
                  cacheWriteTokens = usageCacheWrite;
                }

                // If Anthropic forced-tool structured output returned a tool_call, normalize it into message.content JSON
                if (
                  rfSpec &&
                  rfSpec.type === 'json_schema' &&
                  upstream.type === 'anthropic' &&
                  !parsed.choices?.[0]?.message?.content &&
                  Array.isArray(parsed.choices?.[0]?.message?.tool_calls) &&
                  parsed.choices[0].message.tool_calls[0]?.function?.arguments
                ) {
                  const rawArgs = parsed.choices[0].message.tool_calls[0].function.arguments;
                  parsed.choices[0].message.content =
                    typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
                }

                if (typeof parsed.choices?.[0]?.message?.content === 'string') {
                  assistantOutputText = parsed.choices[0].message.content;
                }

                // Structured Outputs JSON Schema Validation & Fence Repair
                if (rfSpec && (rfSpec.type === 'json_schema' || rfSpec.type === 'json_object')) {
                  const validation = validateAgainstJsonSchema(
                    assistantOutputText,
                    rfSpec.schema,
                    rfSpec.strict
                  );
                  if (!validation.valid) {
                    const hasMoreCandidates =
                      targetUpstreams.indexOf(upstream) < targetUpstreams.length - 1 ||
                      attempt < retryCount;
                    if (hasMoreCandidates) {
                      console.warn(
                        `[StructuredOutputs] Upstream ${upstream.id} failed JSON schema validation (${validation.errors.join('; ')}); escalating.`
                      );
                      schemaValidationFailed = true;
                    } else if (rfSpec.strict) {
                      return new Response(
                        JSON.stringify({
                          error: {
                            message: `Structured output schema validation failed: ${validation.errors.join('; ')}`,
                            type: 'invalid_response_schema',
                            code: 'schema_validation_failed',
                            errors: validation.errors,
                          },
                        }),
                        {
                          status: 422,
                          headers: {
                            'Content-Type': 'application/json',
                            'x-eluvix-upstream': upstream.id,
                            'x-eluvix-schema-validation': 'failed',
                          },
                        }
                      );
                    }
                  } else {
                    if (validation.wasFenceRepaired && validation.repairedJsonText) {
                      assistantOutputText = validation.repairedJsonText;
                      if (parsed.choices?.[0]?.message) {
                        parsed.choices[0].message.content = validation.repairedJsonText;
                      }
                      schemaValidationHeader = 'repaired';
                    } else {
                      schemaValidationHeader = attemptsMade > 1 ? 'escalated' : 'validated';
                    }
                  }
                }

                // Output Guardrails (Sync JSON DLP & Secret Scrubbing)
                if (!schemaValidationFailed && this.config.outputGuard?.enabled) {
                  const ogResult = applyOutputGuardToChatCompletionJson(
                    parsed,
                    this.config.outputGuard
                  );
                  parsed = ogResult.payload;
                  outputGuardStatusHeader = ogResult.result.status;
                  outputGuardRedactionsHeader = ogResult.result.redactionCount;
                  if (typeof parsed.choices?.[0]?.message?.content === 'string') {
                    assistantOutputText = parsed.choices[0].message.content;
                  }
                }

                rawData = JSON.stringify(parsed);
                if (!schemaValidationFailed && cacheConfig?.enabled && cacheKey) {
                  this.setCachedResponse(cacheKey, parsed, lastUserQuery);
                }
                responseBody = new Blob([rawData]).stream();
              } catch {}
            } else if (
              effectiveRequest.stream &&
              responseBody &&
              typeof (responseBody as any).getReader === 'function'
            ) {
              if (this.config.outputGuard?.enabled) {
                outputGuardStatusHeader = 'clean';
                responseBody = createStreamingOutputDlpTransform(
                  responseBody as ReadableStream<Uint8Array>,
                  this.config.outputGuard
                );
              }
              if (
                canRemember &&
                (upstream.type === 'antigravity' || upstream.endpoint.startsWith('cli://'))
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
            }

            if (schemaValidationFailed) {
              continue;
            }

            globalCircuitBreaker.recordSuccess(upstream.id);

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
            const syncCostUsd = estimateUpstreamRequestCostUsd(upstream, promptTokens, completionTokens, {
              cacheReadTokens,
              cacheWriteTokens,
            });

            // Logging: For non-streaming, log immediately. For streaming, tee stream to log full duration and token count upon completion.
            const slaThresholdMs = switchyardConfig.spilloverThresholdMs ?? 30000;
            if (!effectiveRequest.stream) {
              recordBanditArmOutcome({
                upstreamId: upstream.id,
                complexityTier: complexity.label,
                success: duration_ms <= slaThresholdMs,
                weight: duration_ms <= slaThresholdMs ? 1.0 : 0.4,
                ttftMs,
                itlMs,
              });
              maybeTriggerAsyncDistillation(upstream, servedModel, assistantOutputText);
              logRequest({
                model: servedModel,
                upstream_id: upstream.id,
                status: response.status,
                duration_ms,
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                cache_read_tokens: cacheReadTokens,
                cache_write_tokens: cacheWriteTokens,
                ttft_ms: ttftMs,
                itl_ms: itlMs,
                kv_cache_kb: kvCacheKb,
                cost_usd: syncCostUsd,
                user_id: scope?.userId || 'default'
              });
            } else if (
              responseBody &&
              typeof (responseBody as any).getReader === 'function' &&
              !(upstream.type === 'antigravity' || upstream.endpoint.startsWith('cli://'))
            ) {
              const streamStartTime = startTime;
              // If the remember-only tee above already wrapped this body,
              // this tee must log only — remembering here too wrote every
              // streamed turn to memory twice. (For antigravity/cli://
              // upstreams this branch never runs, so their memory path is
              // still the remember-only tee above.)
              const providerRef = canRemember ? this.contextProvider : undefined;
              responseBody = teeSseStreamForMemory(
                responseBody as ReadableStream<Uint8Array>,
                (fullAssistantText) => {
                  if (providerRef) {
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
                  const finalDuration = Date.now() - streamStartTime;
                  const estimatedCompletion = Math.max(1, Math.ceil(fullAssistantText.length / 4));
                  const finalDecode = Math.max(0, finalDuration - ttftMs);
                  const finalItl = estimatedCompletion > 1
                    ? Number((finalDecode / (estimatedCompletion - 1)).toFixed(2))
                    : Number((finalDecode || finalDuration).toFixed(2));
                  const streamCostUsd = estimateUpstreamRequestCostUsd(upstream, promptTokens, estimatedCompletion, {
                    cacheReadTokens,
                    cacheWriteTokens,
                  });
                  recordBanditArmOutcome({
                    upstreamId: upstream.id,
                    complexityTier: complexity.label,
                    success: finalDuration <= slaThresholdMs,
                    weight: finalDuration <= slaThresholdMs ? 1.0 : 0.4,
                    ttftMs,
                    itlMs: finalItl,
                  });
                  maybeTriggerAsyncDistillation(upstream, servedModel, fullAssistantText);
                  logRequest({
                    model: servedModel,
                    upstream_id: upstream.id,
                    status: response.status,
                    duration_ms: finalDuration,
                    prompt_tokens: promptTokens,
                    completion_tokens: estimatedCompletion,
                    cache_read_tokens: cacheReadTokens,
                    cache_write_tokens: cacheWriteTokens,
                    ttft_ms: ttftMs,
                    itl_ms: finalItl,
                    kv_cache_kb: kvCacheKb,
                    cost_usd: streamCostUsd,
                    user_id: scope?.userId || 'default'
                  });
                }
              );
            }
            
            const newResponse = new Response(responseBody, {
              status: response.status,
              statusText: response.statusText,
              headers: new Headers(response.headers)
            });
            newResponse.headers.set('x-eluvix-upstream', upstream.id);
            newResponse.headers.set('x-eluvix-model', servedModel);
            if (cacheReadTokens > 0) {
              newResponse.headers.set('x-eluvix-cache-read-tokens', String(cacheReadTokens));
            }
            if (cacheWriteTokens > 0) {
              newResponse.headers.set('x-eluvix-cache-write-tokens', String(cacheWriteTokens));
            }
            if (schemaValidationHeader) {
              newResponse.headers.set('x-eluvix-schema-validation', schemaValidationHeader);
            }
            if (outputGuardStatusHeader) {
              newResponse.headers.set('x-eluvix-output-guard', outputGuardStatusHeader);
              newResponse.headers.set('x-eluvix-output-redactions', String(outputGuardRedactionsHeader));
            }
            if (cascadeHeaderStatus) {
              newResponse.headers.set('x-eluvix-cascade', cascadeHeaderStatus);
              if (cascadeEscalationReason) {
                newResponse.headers.set('x-eluvix-cascade-reason', cascadeEscalationReason);
              }
            }
            if (selection.vendorAlias?.aliasApplied) {
              newResponse.headers.set(
                'x-eluvix-model-alias',
                `${selection.vendorAlias.originalModel}->${servedModel} (tier:${selection.vendorAlias.targetTier || 'auto'})`
              );
            }
            newResponse.headers.set('x-eluvix-complexity', complexity.score.toString());
            newResponse.headers.set('x-eluvix-tokens', promptTokens.toString());
            newResponse.headers.set('x-eluvix-ttft-ms', String(ttftMs));
            newResponse.headers.set('x-eluvix-cost-usd', syncCostUsd.toFixed(6));
            if (selection.budgetFallback) {
              newResponse.headers.set('x-eluvix-budget-fallback', 'local-sovereign');
            }
            if (typeof selection.rolling24hSpendUsd === 'number') {
              newResponse.headers.set('x-eluvix-rolling-24h-spend-usd', selection.rolling24hSpendUsd.toFixed(6));
            }
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
            if (upstream.fabric?.topology) {
              newResponse.headers.set('x-eluvix-fabric-topology', upstream.fabric.topology);
              const rdmaTransport =
                upstream.fabric.topology === 'rail-dlb-oooddp'
                  ? 'rocev2-dlb-oooddp'
                  : upstream.fabric.topology === 'rail-srv6-usid'
                  ? 'rocev2-srv6-usid'
                  : upstream.fabric.topology === 'rail-pxn-ecmp'
                  ? 'rocev2-pxn-4qp'
                  : 'rocev2-static-ecmp';
              newResponse.headers.set('x-eluvix-rdma-transport', rdmaTransport);
              if (upstream.fabric.srv6UsidCarrier || upstream.fabric.topology === 'rail-srv6-usid') {
                newResponse.headers.set(
                  'x-eluvix-srv6-usid-carrier',
                  upstream.fabric.srv6UsidCarrier || 'fcbb:bb00:0202:0104:0040::'
                );
              }
            }
            const resolvedAkBackend = resolveEffectiveAttentionBackend(upstream);
            if (resolvedAkBackend) {
              const akSpec =
                FLASH_ATTENTION_BENCHMARK_TABLE[resolvedAkBackend] ||
                FLASH_ATTENTION_BENCHMARK_TABLE['fa3-fp8-hadamard'];
              newResponse.headers.set('x-eluvix-attention-kernel', resolvedAkBackend);
              newResponse.headers.set(
                'x-eluvix-cuda-arch',
                upstream.attentionKernel?.smArch || akSpec.smArch
              );
              newResponse.headers.set(
                'x-eluvix-mma-primitive',
                upstream.attentionKernel?.mmaPrimitive || akSpec.mmaPrimitive
              );
              newResponse.headers.set(
                'x-eluvix-tma-swizzle',
                upstream.attentionKernel?.tmaSwizzle || akSpec.tmaSwizzle
              );
              newResponse.headers.set(
                'x-eluvix-tensor-core-util-pct',
                `${akSpec.tensorCoreUtilizationPct}%`
              );
            }
            if (isNeuroSymbolicCrsUpstream(upstream) || crsTriageResult?.detected) {
              const effCrsPolicy =
                activeCrsPolicy !== 'disabled'
                  ? activeCrsPolicy
                  : upstream.crs?.policy || 'slice-and-verify';
              newResponse.headers.set('x-eluvix-crs-policy', effCrsPolicy);
              newResponse.headers.set(
                'x-eluvix-crs-slicer',
                upstream.crs?.slicerMode || 'llvm-def-use'
              );
              newResponse.headers.set('x-eluvix-crs-verified', 'true');
              if (crsTriageResult) {
                newResponse.headers.set(
                  'x-eluvix-crs-stall-escalated',
                  String(crsTriageResult.stallMetrics.shouldEscalateToNeuroSymbolic)
                );
                if (crsTriageResult.sliceResult) {
                  newResponse.headers.set(
                    'x-eluvix-crs-slice-compression-pct',
                    String(crsTriageResult.sliceResult.compressionRatioPct)
                  );
                  newResponse.headers.set(
                    'x-eluvix-crs-tokens-saved',
                    String(crsTriageResult.sliceResult.estimatedTokensSaved)
                  );
                }
                if (crsTriageResult.shadowMapping) {
                  newResponse.headers.set(
                    'x-eluvix-crs-shadow-addr',
                    crsTriageResult.shadowMapping.shadowAddressHex
                  );
                  newResponse.headers.set(
                    'x-eluvix-crs-shadow-poison',
                    crsTriageResult.shadowMapping.shadowByteHex
                  );
                  newResponse.headers.set(
                    'x-eluvix-crs-bug-class',
                    crsTriageResult.shadowMapping.bugClass
                  );
                }
                if (crsTriageResult.overflowCheck?.overflowed) {
                  newResponse.headers.set(
                    'x-eluvix-crs-bv-overflow',
                    `uint${crsTriageResult.overflowCheck.bitWidth}:${crsTriageResult.overflowCheck.wrappedHex}`
                  );
                }
              }
            }
            const effectiveVc = upstream.vectorcraft?.enabled ? upstream.vectorcraft : activeVcConfig;
            if (effectiveVc && (upstream.vectorcraft?.enabled || vectorcraftActive)) {
              const vcCliSpec = buildVectorCraftCliArgs(effectiveVc);
              newResponse.headers.set('x-eluvix-vectorcraft-mode', vcCliSpec.effectiveMode);
              newResponse.headers.set(
                'x-eluvix-vectorcraft-protocol',
                effectiveVc.protocolVersion || '2025-06-18'
              );
              newResponse.headers.set(
                'x-eluvix-vectorcraft-tools',
                vcCliSpec.effectiveMode === 'headless' ? '27' : '33'
              );
              const effPreset = effectiveVc.defaultPromptWorkflow || effectiveVc.promptPreset;
              if (effPreset && effPreset !== 'none') {
                newResponse.headers.set('x-eluvix-vectorcraft-preset', effPreset);
              }
            }
            const effectiveAc = upstream.artcraft?.enabled ? upstream.artcraft : activeAcConfig;
            if (effectiveAc && (upstream.artcraft?.enabled || artcraftActive)) {
              const activeAppsList = resolveSelectedArtCraftApps(effectiveAc);
              const acCliSpec = buildArtCraftCliArgs({
                ...effectiveAc,
                app: activeAppsList[0] || 'vectorcraft'
              });
              newResponse.headers.set('x-eluvix-artcraft-apps', activeAppsList.join(','));
              newResponse.headers.set('x-eluvix-artcraft-mode', acCliSpec.effectiveMode);
              newResponse.headers.set(
                'x-eluvix-artcraft-protocol',
                effectiveAc.protocolVersion || '2025-06-18'
              );
              if (detectedArtCraftApps.length > 0) {
                newResponse.headers.set(
                  'x-eluvix-artcraft-detected',
                  detectedArtCraftApps.join(',')
                );
              }
            }
            const reqPrefixHash =
              preInjectionPrefixHash !== 'empty'
                ? preInjectionPrefixHash
                : computeKvPrefixHash(effectiveRequest.messages || []);
            if (reqPrefixHash !== 'empty') {
              newResponse.headers.set('x-eluvix-kv-prefix-hash', reqPrefixHash);
              if (this.config.switchyard?.kvPrefixAffinity) {
                this.setAffinityUpstream(reqPrefixHash, upstream.id);
              }
            }
            if (effortHeader) {
              newResponse.headers.set('x-eluvix-effort', effortHeader);
            }
            if (resolvedPromptHeader) {
              newResponse.headers.set('x-eluvix-prompt', resolvedPromptHeader);
            }
            const activeEngineSignal = getCachedEngineSignal(upstream.id);
            if (activeEngineSignal) {
              newResponse.headers.set(
                'x-eluvix-engine-load',
                formatEngineLoadHeader(activeEngineSignal, servedModel)
              );
            }
            if (this.config.memory?.enabled) {
              newResponse.headers.set(
                'x-eluvix-memory',
                strippedMemoryForCloud ? `${memoryStatus};stripped-for-cloud` : memoryStatus
              );
              newResponse.headers.set('x-eluvix-memory-tokens', String(strippedMemoryForCloud ? 0 : memoryTokens));
            }
            if (this.config.knowledge?.enabled) {
              newResponse.headers.set(
                'x-eluvix-knowledge',
                strippedKnowledgeForCloud ? `${knowledgeStatus};stripped-for-cloud` : knowledgeStatus
              );
              newResponse.headers.set('x-eluvix-knowledge-tokens', String(strippedKnowledgeForCloud ? 0 : knowledgeTokens));
            }

            if (this.config.observability) {
              const childSpans: OtelChildSpanInput[] = [
                {
                  name: 'eluvix.guard',
                  kind: 'INTERNAL',
                  startTimeMs: routeStartTime,
                  endTimeMs: startTime,
                  status: 'OK',
                  attributes: {
                    'eluvix.prompt_guard.enabled': Boolean(this.config.promptGuard?.enabled),
                    'eluvix.privacy_guard.enabled': Boolean(this.config.privacyGuard?.enabled),
                    'eluvix.output_guard.status': outputGuardStatusHeader || 'disabled',
                    'eluvix.output_guard.redactions': outputGuardRedactionsHeader,
                  },
                },
                {
                  name: 'eluvix.routing',
                  kind: 'INTERNAL',
                  startTimeMs: routeStartTime,
                  endTimeMs: startTime,
                  status: 'OK',
                  attributes: {
                    'eluvix.strategy': selection.strategy,
                    'eluvix.complexity_score': complexity.score,
                    'eluvix.complexity_tier': complexity.label,
                    'eluvix.chosen_upstream_id': upstream.id,
                    ...(selection.vendorAlias?.aliasApplied
                      ? { 'eluvix.vendor_alias': selection.vendorAlias.originalModel }
                      : {}),
                  },
                },
                {
                  name: 'eluvix.upstream',
                  kind: 'CLIENT',
                  startTimeMs: startTime,
                  endTimeMs: startTime + duration_ms,
                  status: 'OK',
                  attributes: {
                    'gen_ai.system': upstream.type,
                    'gen_ai.request.model': effectiveRequest.model,
                    'gen_ai.response.model': servedModel,
                    'gen_ai.usage.input_tokens': promptTokens,
                    'gen_ai.usage.output_tokens': completionTokens,
                    ...(cacheReadTokens > 0
                      ? { 'gen_ai.usage.cache_read_input_tokens': cacheReadTokens }
                      : {}),
                    ...(cacheWriteTokens > 0
                      ? { 'gen_ai.usage.cache_creation_input_tokens': cacheWriteTokens }
                      : {}),
                    'eluvix.upstream_id': upstream.id,
                    'eluvix.ttft_ms': ttftMs,
                    'eluvix.cost_usd': syncCostUsd,
                  },
                },
              ];

              if (this.config.memory?.enabled) {
                childSpans.push({
                  name: 'eluvix.memory',
                  kind: 'INTERNAL',
                  startTimeMs: routeStartTime,
                  endTimeMs: startTime,
                  status: 'OK',
                  attributes: {
                    'eluvix.memory.status': memoryStatus,
                    'eluvix.memory.tokens': memoryTokens,
                  },
                });
              }

              const traceRes = this.otelExporter.enqueueTrace({
                name: 'eluvix.chat',
                kind: 'SERVER',
                startTimeMs: routeStartTime,
                endTimeMs: Date.now(),
                status: 'OK',
                attributes: {
                  'gen_ai.system': upstream.type,
                  'gen_ai.request.model': request.model || 'auto',
                  'gen_ai.response.model': servedModel,
                  'gen_ai.usage.input_tokens': promptTokens,
                  'gen_ai.usage.output_tokens': completionTokens,
                  ...(cacheReadTokens > 0
                    ? { 'gen_ai.usage.cache_read_input_tokens': cacheReadTokens }
                    : {}),
                  ...(cacheWriteTokens > 0
                    ? { 'gen_ai.usage.cache_creation_input_tokens': cacheWriteTokens }
                    : {}),
                  'eluvix.upstream_id': upstream.id,
                  'eluvix.strategy': selection.strategy,
                  'eluvix.complexity_tier': complexity.label,
                  'eluvix.cost_usd': syncCostUsd,
                  'eluvix.ttft_ms': ttftMs,
                  ...(schemaValidationHeader
                    ? { 'eluvix.schema_validation': schemaValidationHeader }
                    : {}),
                  ...(cascadeHeaderStatus
                    ? { 'eluvix.cascade_mode': cascadeHeaderStatus }
                    : {}),
                  ...(this.config.observability.captureInputs
                    ? {
                        'gen_ai.prompt': lastUserQuery,
                        'gen_ai.completion': assistantOutputText,
                      }
                    : {}),
                },
                children: childSpans,
              });
              newResponse.headers.set('x-eluvix-trace-id', traceRes.traceId);
              if (traceRes.enqueued) {
                void this.flushTraces().catch(() => {});
              }
            }
            
            return newResponse;
          } else {
            globalCircuitBreaker.recordFailure(upstream.id, activeChain?.failureThreshold ?? 3);
            recordBanditArmOutcome({
              upstreamId: upstream.id,
              complexityTier: complexity.label,
              success: false,
            });
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
          recordBanditArmOutcome({
            upstreamId: upstream.id,
            complexityTier: complexity.label,
            success: false,
          });
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
    const fallbackModality = classifyRequestModality(effectiveRequest);
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
        modality: selection.modality,
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
        modality: fallbackModality,
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
   * truncation, modality/vision/tools filtering, and strategy ranking.
   */
  private selectTargetUpstreams(
    effectiveRequest: ResolvedChatRequest,
    options?: {
      silent?: boolean;
      scope?: Partial<RequestScope>;
      hops?: number;
      memoryTainted?: boolean;
      knowledgeTainted?: boolean;
      memoryTokens?: number;
      knowledgeTokens?: number;
    }
  ): {
    effectiveRequest: ResolvedChatRequest;
    complexity: PromptComplexityAssessment;
    modality: ModalityProfile;
    strategy: RoutingStrategy;
    targetUpstreams: UpstreamConfig[];
    steps: RouteTraceStep[];
    budgetFallback?: boolean;
    rolling24hSpendUsd?: number;
    vendorAlias?: VendorModelAliasResult;
  } {
    const steps: RouteTraceStep[] = [];
    const fail = (message: string): never => {
      const err: any = new Error(message);
      err.routeSteps = steps;
      throw err;
    };
    const strictModelMatch =
      Boolean(this.config.switchyard?.strictModelMatch) ||
      Boolean(effectiveRequest.metadata?.strictModelMatch);
    let vendorAlias: VendorModelAliasResult | undefined;

    let matchingUpstreams = this.config.upstreams.filter(u =>
      this.matchesModel(u, effectiveRequest.model)
    );
    const hasExplicitMatch = this.config.upstreams.some(
      u =>
        u.models?.includes(effectiveRequest.model) ||
        (u.type === 'harness' && u.harness?.kind && effectiveRequest.model === `harness/${u.harness.kind}`) ||
        ((u.type === 'antigravity' || u.endpoint?.startsWith('cli://')) &&
          isAntigravitySupportedModel(effectiveRequest.model, u.models))
    );
    const usableUnderEgress =
      this.config.egressPolicy === 'local-only'
        ? matchingUpstreams.filter(u => isLocalUpstream(u))
        : matchingUpstreams;

    if (
      !strictModelMatch &&
      (matchingUpstreams.length === 0 || (usableUnderEgress.length === 0 && !hasExplicitMatch))
    ) {
      const candidateAlias = resolveVirtualVendorModel(effectiveRequest.model);
      if (candidateAlias.aliasApplied) {
        vendorAlias = candidateAlias;
        effectiveRequest = {
          ...effectiveRequest,
          model: candidateAlias.resolvedModel,
        };
        matchingUpstreams = this.config.upstreams.filter(u =>
          this.matchesModel(u, effectiveRequest.model)
        );
        steps.push({
          stage: 'model-match',
          detail: `virtual vendor alias "${candidateAlias.originalModel}" -> "${candidateAlias.resolvedModel}" (tier=${candidateAlias.targetTier}) matched ${matchingUpstreams.length} of ${this.config.upstreams.length} upstreams`,
          kept: matchingUpstreams.map(u => u.id),
          removed: this.config.upstreams.filter(u => !matchingUpstreams.includes(u)).map(u => u.id)
        });
      }
    }

    if (!vendorAlias) {
      steps.push({
        stage: 'model-match',
        detail: `model "${effectiveRequest.model}" matched ${matchingUpstreams.length} of ${this.config.upstreams.length} upstreams`,
        kept: matchingUpstreams.map(u => u.id),
        removed: this.config.upstreams.filter(u => !matchingUpstreams.includes(u)).map(u => u.id)
      });
    }

    if (matchingUpstreams.length === 0) {
      fail(`No upstream available for model: ${vendorAlias?.originalModel || effectiveRequest.model}`);
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
    // Scope: this governs upstream selection only. The memory-provider
    // recall channel and the provider-agent channel are separate paths
    // the policy does not govern — see warnOnLocalOnlyEgressExceptions.
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
    const clientPolicy = (effectiveRequest.confidentialPolicy || effectiveRequest.metadata?.confidentialPolicy) as ConfidentialPolicy | undefined;
    const confidentialPolicy: ConfidentialPolicy =
      clientPolicy && Object.prototype.hasOwnProperty.call(POLICY_RANKS, clientPolicy)
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

    // Knowledge-Taint Egress Guard: when retrieved knowledge is injected,
    // prevent silent exfiltration to cloud upstreams unless allowCloudEgress=true.
    if (options?.knowledgeTainted && !this.config.knowledge?.allowCloudEgress) {
      const cloudMode = this.config.knowledge?.cloudMode || 'filter';
      if (cloudMode === 'strip') {
        steps.push({
          stage: 'knowledge-rag',
          detail: 'knowledge-tainted request with cloudMode=strip: <eluvix-knowledge> block will be stripped before forwarding to non-local upstreams',
          kept: matchingUpstreams.map(u => u.id),
          removed: []
        });
      } else {
        const localOnly = matchingUpstreams.filter(u => isLocalUpstream(u));
        const removedCloud = matchingUpstreams.filter(u => !isLocalUpstream(u));
        steps.push({
          stage: 'knowledge-rag',
          detail: 'knowledge-tainted request with allowCloudEgress=false (cloudMode=filter): only local upstreams may receive retrieved knowledge',
          kept: localOnly.map(u => u.id),
          removed: removedCloud.map(u => u.id)
        });
        if (localOnly.length === 0) {
          fail(`No local upstream available to serve knowledge-tainted request for model: ${effectiveRequest.model} (knowledge.allowCloudEgress=false)`);
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
    if (vendorAlias?.aliasApplied) {
      if (vendorAlias.preferLocal) {
        complexity.score = 1;
        complexity.label = 'simple';
        complexity.features.push(`vendor-alias:${vendorAlias.originalModel}->simple`);
      } else if (vendorAlias.complexityFloor && complexity.score < vendorAlias.complexityFloor) {
        complexity.score = vendorAlias.complexityFloor;
        complexity.label = vendorAlias.targetTier || complexity.label;
        complexity.features.push(`vendor-alias:${vendorAlias.originalModel}->${complexity.label}`);
      }
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
      } else if (nonSystemMsgs.length > 0) {
        // One giant message (or two) used to fail open: the branch above
        // requires > 2 non-system messages, so a single oversized user
        // message was sent to a small local model untouched. Truncate the
        // largest string message from the middle — keeping head and tail,
        // where the actual question usually sits — by the overshoot plus
        // margin. If no message is large enough to absorb the overshoot,
        // leave the request untouched (system messages dominate) rather
        // than destroying content.
        const overTokens = complexity.tokenEstimate - MAX_LOCAL_TOKENS;
        const overChars = Math.ceil(overTokens * 4) + 256;
        let targetIdx = -1;
        let targetLen = 0;
        msgs.forEach((m, i) => {
          if (m.role !== 'system' && typeof m.content === 'string' && m.content.length > targetLen) {
            targetLen = m.content.length;
            targetIdx = i;
          }
        });
        if (targetIdx >= 0 && targetLen > overChars + 512) {
          const orig = msgs[targetIdx].content as string;
          const kept = targetLen - overChars;
          const headLen = Math.ceil(kept / 2);
          const tailLen = kept - headLen;
          const note = '\n[System Note: Middle of message truncated to fit local context window]\n';
          const truncated = orig.slice(0, headLen) + note + (tailLen > 0 ? orig.slice(-tailLen) : '');
          effectiveRequest = {
            ...effectiveRequest,
            messages: msgs.map((m, i) => (i === targetIdx ? { ...m, content: truncated } : m))
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
    }

    let targetUpstreams = [...matchingUpstreams];
    const modality = classifyRequestModality({
      ...effectiveRequest,
      messages: messagesWithoutContext
    });

    // Dedicated Audio Engine Isolation Gate: prevent STT/TTS audio upstreams (`AudioVoiceNode`)
    // from hijacking text/code/vision chat completions.
    const dedicatedAudio = targetUpstreams.filter(u => isDedicatedAudioUpstreamType(u.type));
    const nonAudioCandidates = targetUpstreams.filter(u => !isDedicatedAudioUpstreamType(u.type));
    if (dedicatedAudio.length > 0 && nonAudioCandidates.length > 0) {
      targetUpstreams = nonAudioCandidates;
      steps.push({
        stage: 'modality-filter',
        detail: 'excluded dedicated STT/TTS audio engine(s) from text/chat completion pool',
        kept: nonAudioCandidates.map(u => u.id),
        removed: dedicatedAudio.map(u => u.id)
      });
    } else if (dedicatedAudio.length > 0 && nonAudioCandidates.length === 0) {
      fail(`No text chat upstream available for model: ${effectiveRequest.model} (only dedicated audio STT/TTS engines are configured)`);
    }

    // Modality & Diffusion Isolation Gate: prevent ComfyUI wildcard upstreams from hijacking
    // ordinary text/code/tool chat, while steering explicit image/video/3D synthesis prompts
    // to ComfyUI when `model === 'auto'` and `mediaIntentRouting !== false`.
    const comfyCandidates = targetUpstreams.filter(u => u.type === 'comfyui');
    const nonComfyCandidates = targetUpstreams.filter(u => u.type !== 'comfyui');
    const explicitComfyModel =
      effectiveRequest.model !== 'auto' &&
      effectiveRequest.model !== 'default' &&
      effectiveRequest.model !== '*' &&
      (isExplicitMediaModelId(effectiveRequest.model) ||
        comfyCandidates.some(
          u =>
            u.models?.includes(effectiveRequest.model) ||
            (u.comfyui?.checkpoint && u.comfyui.checkpoint === effectiveRequest.model)
        ));

    if (!explicitComfyModel && comfyCandidates.length > 0) {
      const allowMediaRouting = switchyardConfig.mediaIntentRouting !== false;
      if (
        modality.synthesisIntent !== 'text' &&
        allowMediaRouting &&
        !modality.hasToolDefinitions &&
        !complexity.hasImages
      ) {
        const presetMatchScore = (u: UpstreamConfig): number => {
          const preset = u.comfyui?.workflowPreset || 'flux-txt2img';
          if (modality.synthesisIntent === 'video-gen') {
            return preset === 'wan21-txt2vid' ? 2 : 0;
          }
          if (modality.synthesisIntent === '3d-gen') {
            return preset === 'hunyuan3d-mesh' ? 2 : 0;
          }
          return preset === 'flux-txt2img' || preset === 'sdxl-txt2img' ? 2 : 1;
        };
        const rankedComfy = [...comfyCandidates].sort((a, b) => {
          const diff = presetMatchScore(b) - presetMatchScore(a);
          return diff !== 0 ? diff : b.priority - a.priority;
        });
        targetUpstreams = rankedComfy;
        steps.push({
          stage: 'modality-filter',
          detail: `synthesisIntent=${modality.synthesisIntent}${modality.matchedTrigger ? ` ("${modality.matchedTrigger}")` : ''}: routed media synthesis request to ComfyUI engine(s)`,
          kept: rankedComfy.map(u => u.id),
          removed: nonComfyCandidates.map(u => u.id)
        });
      } else if (nonComfyCandidates.length > 0) {
        targetUpstreams = nonComfyCandidates;
        steps.push({
          stage: 'modality-filter',
          detail: 'synthesisIntent=text: excluded ComfyUI media synthesis engine(s) from text/tool chat candidate pool',
          kept: nonComfyCandidates.map(u => u.id),
          removed: comfyCandidates.map(u => u.id)
        });
      }
    }

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

    // Structured Outputs (`response_format: { type: 'json_schema' | 'json_object' }`) Filter
    const rfSpec = extractResponseFormatSpec(effectiveRequest);
    if (rfSpec && (rfSpec.type === 'json_schema' || rfSpec.type === 'json_object')) {
      const structuredCapable = targetUpstreams.filter(u =>
        supportsStructuredOutputs(u, rfSpec.strict)
      );
      const structuredRemoved = targetUpstreams.filter(u => !structuredCapable.includes(u));
      if (rfSpec.strict || structuredRemoved.length > 0) {
        steps.push({
          stage: 'structured-outputs-filter',
          detail: `response_format=${rfSpec.type}${rfSpec.strict ? ' (strict=true)' : ''}: filtered candidate pool for grammar-constrained JSON output support`,
          kept: structuredCapable.map(u => u.id),
          removed: structuredRemoved.map(u => u.id),
        });
      }
      if (rfSpec.strict && structuredCapable.length === 0) {
        fail(
          `No upstream available for model: ${effectiveRequest.model} supporting strict structured outputs (response_format: ${rfSpec.type}, strict: true)`
        );
      }
      if (structuredCapable.length > 0) {
        targetUpstreams = structuredCapable;
      }
    }

    // Rolling 24-Hour Cloud Spend Guardrail (`maxDailySpendUsd`)
    let budgetFallback = false;
    let rolling24hSpendUsd: number | undefined = undefined;
    if (
      typeof switchyardConfig.maxDailySpendUsd === 'number' &&
      Number.isFinite(switchyardConfig.maxDailySpendUsd) &&
      switchyardConfig.maxDailySpendUsd > 0
    ) {
      rolling24hSpendUsd = getRollingSpendUsd(24);
      const capUsd = switchyardConfig.maxDailySpendUsd;
      if (rolling24hSpendUsd >= capUsd) {
        const action: BudgetExhaustedAction = switchyardConfig.budgetExhaustedAction || 'prefer-local';
        const zeroCostUpstreams = targetUpstreams.filter(u => getEffectiveCostPer1kTokens(u) <= 0);
        const paidUpstreams = targetUpstreams.filter(u => getEffectiveCostPer1kTokens(u) > 0);

        if (action === 'reject') {
          steps.push({
            stage: 'budget-guardrail',
            detail: `rolling 24h spend ($${rolling24hSpendUsd.toFixed(4)}) >= maxDailySpendUsd ($${capUsd.toFixed(2)}) with action=reject: rejecting request`,
            kept: [],
            removed: targetUpstreams.map(u => u.id)
          });
          const err: any = new Error(
            `Daily cloud spend cap exceeded ($${rolling24hSpendUsd.toFixed(4)} >= $${capUsd.toFixed(2)} over 24h; budgetExhaustedAction: reject).`
          );
          err.routeSteps = steps;
          err.budgetCapExceeded = true;
          err.rolling24hSpendUsd = rolling24hSpendUsd;
          throw err;
        }

        if (action === 'strict-local') {
          steps.push({
            stage: 'budget-guardrail',
            detail: `rolling 24h spend ($${rolling24hSpendUsd.toFixed(4)}) >= maxDailySpendUsd ($${capUsd.toFixed(2)}) with action=strict-local: restricting strictly to $0.00 local/sovereign upstreams`,
            kept: zeroCostUpstreams.map(u => u.id),
            removed: paidUpstreams.map(u => u.id)
          });
          if (zeroCostUpstreams.length === 0) {
            const err: any = new Error(
              `Daily cloud spend cap exceeded ($${rolling24hSpendUsd.toFixed(4)} >= $${capUsd.toFixed(2)} over 24h) and no $0.00 local upstream is available (budgetExhaustedAction: strict-local).`
            );
            err.routeSteps = steps;
            err.budgetCapExceeded = true;
            err.rolling24hSpendUsd = rolling24hSpendUsd;
            throw err;
          }
          targetUpstreams = zeroCostUpstreams;
          budgetFallback = paidUpstreams.length > 0;
        } else {
          // 'prefer-local' (default): soft-failover to $0.00 local/CLI upstreams when available
          if (zeroCostUpstreams.length > 0 && paidUpstreams.length > 0) {
            steps.push({
              stage: 'budget-guardrail',
              detail: `rolling 24h spend ($${rolling24hSpendUsd.toFixed(4)}) >= maxDailySpendUsd ($${capUsd.toFixed(2)}) with action=prefer-local: soft-failing over to $0.00 local/sovereign upstreams`,
              kept: zeroCostUpstreams.map(u => u.id),
              removed: paidUpstreams.map(u => u.id)
            });
            targetUpstreams = zeroCostUpstreams;
            budgetFallback = true;
          } else {
            steps.push({
              stage: 'budget-guardrail',
              detail:
                zeroCostUpstreams.length === 0
                  ? `rolling 24h spend ($${rolling24hSpendUsd.toFixed(4)}) >= maxDailySpendUsd ($${capUsd.toFixed(2)}) with action=prefer-local, but no $0.00 local upstream matched; retaining candidate pool`
                  : `rolling 24h spend ($${rolling24hSpendUsd.toFixed(4)}) >= maxDailySpendUsd ($${capUsd.toFixed(2)}): candidate pool already consists solely of $0.00 upstreams`,
              kept: targetUpstreams.map(u => u.id),
              removed: []
            });
          }
        }
      } else {
        steps.push({
          stage: 'budget-guardrail',
          detail: `rolling 24h spend ($${rolling24hSpendUsd.toFixed(4)}) is within maxDailySpendUsd ($${capUsd.toFixed(2)})`,
          kept: targetUpstreams.map(u => u.id),
          removed: []
        });
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
    } else if (strategy === 'thompson-bandit') {
      const arms = getBanditArmsForTier(complexity.label);
      const { ranked } = rankUpstreamsWithThompsonBandit(targetUpstreams, arms, {
        complexityScore: complexity.score,
        deterministicMean: Boolean(options?.silent),
        exactModelChecker:
          effectiveRequest.model !== 'auto'
            ? (u) => Boolean(hasExactModelMatch(u, effectiveRequest.model))
            : undefined,
      });
      targetUpstreams = ranked;
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

    if (
      this.config.cascade?.enabled &&
      hops === 0 &&
      modality.synthesisIntent === 'text' &&
      this.config.cascade.draftUpstreamId &&
      this.config.cascade.verifierUpstreamId
    ) {
      const draftU = targetUpstreams.find(u => u.id === this.config.cascade!.draftUpstreamId);
      const verifierU = targetUpstreams.find(u => u.id === this.config.cascade!.verifierUpstreamId);
      if (draftU && verifierU && draftU.id !== verifierU.id) {
        const others = targetUpstreams.filter(u => u.id !== draftU.id && u.id !== verifierU.id);
        targetUpstreams = [draftU, verifierU, ...others];
        steps.push({
          stage: 'speculative-cascade',
          detail: `buffer-verify cascade armed: draft "${draftU.id}" (threshold=${this.config.cascade.confidenceThreshold ?? 0.78}, budget=${this.config.cascade.maxDraftLatencyMs ?? 2500}ms) -> verifier "${verifierU.id}"`,
          kept: targetUpstreams.map(u => u.id)
        });
      }
    }

    // Preserve ComfyUI workflow-preset specialization (e.g., wan21-txt2vid for video-gen,
    // hunyuan3d-mesh for 3d-gen) ahead of generic priority tie-breakers.
    if (
      modality.synthesisIntent !== 'text' &&
      targetUpstreams.length > 1 &&
      targetUpstreams.every(u => u.type === 'comfyui')
    ) {
      const presetRank = (u: UpstreamConfig): number => {
        const preset = u.comfyui?.workflowPreset || 'flux-txt2img';
        if (modality.synthesisIntent === 'video-gen') return preset === 'wan21-txt2vid' ? 2 : 0;
        if (modality.synthesisIntent === '3d-gen') return preset === 'hunyuan3d-mesh' ? 2 : 0;
        return preset === 'flux-txt2img' || preset === 'sdxl-txt2img' ? 2 : 1;
      };
      targetUpstreams = [...targetUpstreams].sort((a, b) => presetRank(b) - presetRank(a));
    }

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
    const clientQuantPolicy = (effectiveRequest.quantizationPolicy || effectiveRequest.metadata?.quantizationPolicy) as QuantizationPolicy | undefined;
    const quantizationPolicy: QuantizationPolicy =
      clientQuantPolicy && Object.prototype.hasOwnProperty.call(QUANT_RANKS, clientQuantPolicy)
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

    // Rail-Optimized Leaf-Spine Clos Fabric Routing Policy (NCCL PxN, SRv6 uSID, DLB + OOO-DDP)
    const FABRIC_RANKS: Record<FabricRoutingPolicy, number> = {
      'disabled': 0,
      'prefer-rail-optimized': 1,
      'require-collision-free-fabric': 2
    };
    const serverFabricPolicy: FabricRoutingPolicy =
      switchyardConfig.fabricPolicy ||
      this.config.fabricPolicy ||
      'disabled';
    const clientFabricPolicy = (effectiveRequest.fabricPolicy || effectiveRequest.metadata?.fabricPolicy) as FabricRoutingPolicy | undefined;
    const fabricPolicy: FabricRoutingPolicy =
      clientFabricPolicy && Object.prototype.hasOwnProperty.call(FABRIC_RANKS, clientFabricPolicy)
        ? (FABRIC_RANKS[clientFabricPolicy] > FABRIC_RANKS[serverFabricPolicy] ? clientFabricPolicy : serverFabricPolicy)
        : serverFabricPolicy;

    if (fabricPolicy === 'require-collision-free-fabric') {
      const collisionFree = targetUpstreams.filter(u => !isLegacyEcmpFabricUpstream(u));
      const excludedEcmp = targetUpstreams.filter(u => isLegacyEcmpFabricUpstream(u));
      if (excludedEcmp.length > 0 || collisionFree.length === 0) {
        steps.push({
          stage: 'clos-fabric-routing',
          detail: 'fabricPolicy=require-collision-free-fabric: excluding legacy ToR static 5-tuple ECMP upstreams to prevent 99.76% spine elephant-flow hash collisions and PFC pause storms',
          kept: collisionFree.map(u => u.id),
          removed: excludedEcmp.map(u => u.id)
        });
      }
      if (collisionFree.length === 0) {
        const err: any = new Error(
          `No collision-free Rail-Optimized fabric upstream (DLB+OOO-DDP, SRv6 uSID, or NCCL PxN) available for model: ${effectiveRequest.model} (fabricPolicy: require-collision-free-fabric)`
        );
        err.routeSteps = steps;
        err.fabricUnavailable = true;
        throw err;
      }
      targetUpstreams = collisionFree;
    }

    if (fabricPolicy === 'prefer-rail-optimized' || fabricPolicy === 'require-collision-free-fabric') {
      const railUpstreams = targetUpstreams.filter(u => isCollisionFreeRailFabricUpstream(u));
      if (railUpstreams.length > 0) {
        const fabricTierScore = (u: UpstreamConfig): number => {
          const t = u.fabric?.topology;
          if (t === 'rail-dlb-oooddp') return 3;
          if (t === 'rail-srv6-usid') return 2;
          if (t === 'rail-pxn-ecmp') return 1;
          return 0;
        };
        const sortedRail = [...railUpstreams].sort((a, b) => fabricTierScore(b) - fabricTierScore(a));
        const rest = targetUpstreams.filter(u => !railUpstreams.includes(u));
        steps.push({
          stage: 'clos-fabric-routing',
          detail: `fabricPolicy=${fabricPolicy}: prioritizing Rail-Optimized Clos upstreams (DLB Packet Spraying + OOO-DDP / SRv6 uSID / NCCL PxN) for 94.8%-97.8% effective bus bandwidth`,
          kept: sortedRail.map(u => u.id)
        });
        targetUpstreams = [...sortedRail, ...rest];
      }
    }

    // Neuro-Symbolic CRS & Stall-Escalation Routing Policy
    const CRS_RANKS: Record<CrsPolicy, number> = {
      'disabled': 0,
      'slice-and-verify': 1,
      'strict-zero-false-positive': 2
    };
    const serverCrsPolicy: CrsPolicy =
      switchyardConfig.crsPolicy ||
      this.config.crsPolicy ||
      'disabled';
    const clientCrsPolicy = (effectiveRequest.crsPolicy || effectiveRequest.metadata?.crsPolicy) as CrsPolicy | undefined;
    const crsPolicy: CrsPolicy =
      clientCrsPolicy && Object.prototype.hasOwnProperty.call(CRS_RANKS, clientCrsPolicy)
        ? (CRS_RANKS[clientCrsPolicy] > CRS_RANKS[serverCrsPolicy] ? clientCrsPolicy : serverCrsPolicy)
        : serverCrsPolicy;

    if (crsPolicy === 'strict-zero-false-positive') {
      const crsUpstreams = targetUpstreams.filter(u => isNeuroSymbolicCrsUpstream(u));
      const nonCrsUpstreams = targetUpstreams.filter(u => !isNeuroSymbolicCrsUpstream(u));
      if (nonCrsUpstreams.length > 0 || crsUpstreams.length === 0) {
        steps.push({
          stage: 'neuro-symbolic-crs',
          detail: 'crsPolicy=strict-zero-false-positive: requiring Neuro-Symbolic CRS verifier upstreams (Backward Slicer + SymCC/Z3 + ASan Shadow Verification) to eliminate standalone LLM false positives',
          kept: crsUpstreams.map(u => u.id),
          removed: nonCrsUpstreams.map(u => u.id)
        });
      }
      if (crsUpstreams.length === 0) {
        const err: any = new Error(
          `No Neuro-Symbolic CRS verifier upstream available for model: ${effectiveRequest.model} (crsPolicy: strict-zero-false-positive)`
        );
        err.routeSteps = steps;
        err.crsUnavailable = true;
        throw err;
      }
      targetUpstreams = crsUpstreams;
    } else if (crsPolicy === 'slice-and-verify' || strategy === 'stall-escalation') {
      const promptTextForStall = (effectiveRequest.messages || [])
        .filter(m => m.role !== 'system')
        .map(m => extractMessageText(m.content))
        .join('\n');
      const triage = analyzePromptForCrsTriage(promptTextForStall);
      const shouldEscalate =
        crsPolicy === 'slice-and-verify' ||
        triage.stallMetrics.shouldEscalateToNeuroSymbolic ||
        triage.detected;

      if (shouldEscalate) {
        const crsCapable = targetUpstreams.filter(
          u =>
            isNeuroSymbolicCrsUpstream(u) ||
            (strategy === 'stall-escalation' && ((u.maxComplexityScore ?? 2) >= 4 || u.type === 'harness'))
        );
        if (crsCapable.length > 0) {
          const rest = targetUpstreams.filter(u => !crsCapable.includes(u));
          steps.push({
            stage: 'neuro-symbolic-crs',
            detail: `strategy=${strategy}, crsPolicy=${crsPolicy}: stall/invariant barrier detected (engine=${triage.stallMetrics.recommendedEngine}); escalating to Neuro-Symbolic CRS / Frontier upstreams`,
            kept: crsCapable.map(u => u.id)
          });
          targetUpstreams = [...crsCapable, ...rest];
        }
      }
    }

    // FlashAttention-3 Warp-Specialized (WGMMA + TMA Ping-Pong) & Blackwell tcgen05 + TMEM Routing Policy
    const ATTN_RANKS: Record<AttentionRoutingPolicy, number> = {
      'disabled': 0,
      'prefer-fa3-warp-specialized': 1,
      'prefer-blackwell-tmem': 2,
      'require-fp8-ping-pong': 3
    };
    const serverAttnPolicy: AttentionRoutingPolicy =
      switchyardConfig.attentionPolicy ||
      this.config.attentionPolicy ||
      'disabled';
    const clientAttnPolicy = (effectiveRequest.attentionPolicy || effectiveRequest.metadata?.attentionPolicy) as AttentionRoutingPolicy | undefined;
    const attentionPolicy: AttentionRoutingPolicy =
      clientAttnPolicy && Object.prototype.hasOwnProperty.call(ATTN_RANKS, clientAttnPolicy)
        ? (ATTN_RANKS[clientAttnPolicy] > ATTN_RANKS[serverAttnPolicy] ? clientAttnPolicy : serverAttnPolicy)
        : serverAttnPolicy;

    const computeAttentionScore = (u: UpstreamConfig): number => {
      if (isLegacySynchronousAttentionUpstream(u)) return -1;
      const b = resolveEffectiveAttentionBackend(u);
      if (!b) return 0;
      if (attentionPolicy === 'prefer-fa3-warp-specialized') {
        if (b === 'fa3-fp8-hadamard') return 4;
        if (b === 'fa3-wgmma-tma') return 3;
        if (b === 'blackwell-tcgen05-tmem') return 3;
        return 1;
      }
      if (b === 'blackwell-tcgen05-tmem') return 4;
      if (b === 'fa3-fp8-hadamard') return 3;
      if (b === 'fa3-wgmma-tma') return 2;
      return 1;
    };

    if (attentionPolicy === 'require-fp8-ping-pong') {
      const fp8PingPong = targetUpstreams.filter(u => isFp8PingPongAttentionUpstream(u));
      const excludedSync = targetUpstreams.filter(u => !fp8PingPong.includes(u));
      steps.push({
        stage: 'flash-attention-kernel',
        detail:
          'attentionPolicy=require-fp8-ping-pong: requiring Warp-Specialized FP8 Ping-Pong + Walsh-Hadamard (FA3 FP8) or Blackwell tcgen05 + 256KB TMEM upstreams to avoid 64:1 SFU MUFU.EX2 softmax stalls',
        kept: fp8PingPong.map(u => u.id),
        removed: excludedSync.map(u => u.id)
      });
      if (fp8PingPong.length === 0) {
        const err: any = new Error(
          `No Warp-Specialized FlashAttention-3 / Blackwell tcgen05+TMEM upstream available for model: ${effectiveRequest.model} (attentionPolicy: require-fp8-ping-pong)`
        );
        err.routeSteps = steps;
        err.attentionKernelUnavailable = true;
        throw err;
      }
      targetUpstreams = fp8PingPong;
    }

    if (
      attentionPolicy === 'prefer-fa3-warp-specialized' ||
      attentionPolicy === 'prefer-blackwell-tmem' ||
      attentionPolicy === 'require-fp8-ping-pong'
    ) {
      const fa3Upstreams = targetUpstreams.filter(u => isWarpSpecializedAttentionUpstream(u));
      if (fa3Upstreams.length > 0) {
        const sortedFa3 = [...fa3Upstreams].sort(
          (a, b) => computeAttentionScore(b) - computeAttentionScore(a)
        );
        const rest = targetUpstreams.filter(u => !fa3Upstreams.includes(u));
        steps.push({
          stage: 'flash-attention-kernel',
          detail: `attentionPolicy=${attentionPolicy}: prioritizing Warp-Specialized TMA + WGMMA / tcgen05 + 256KB TMEM attention kernels (75%-85% Tensor Core utilization)`,
          kept: sortedFa3.map(u => u.id)
        });
        targetUpstreams = [...sortedFa3, ...rest];
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
        const colocated = targetUpstreams.filter(u => !disaggPrefill.includes(u) && u.disaggregation?.role !== 'decode');
        const decodeWorkers = targetUpstreams.filter(u => !disaggPrefill.includes(u) && u.disaggregation?.role === 'decode');
        steps.push({
          stage: 'prefill-isolation',
          detail: `tokenEstimate=${complexity.tokenEstimate} >= ${prefillThreshold}: heavy-prefill burst routed to dedicated disaggregated/prefill upstreams to protect decode streams from head-of-line SM stalls`,
          kept: disaggPrefill.map(u => u.id)
        });
        targetUpstreams = [
          ...disaggPrefill,
          ...colocated,
          ...decodeWorkers
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
    const cachePrefixText =
      typeof effectiveRequest.metadata?._cachePrefixText === 'string' &&
      effectiveRequest.metadata._cachePrefixText.trim()
        ? effectiveRequest.metadata._cachePrefixText.trim()
        : '';
    const prefixHash = cachePrefixText
      ? crypto.createHash('sha256').update(cachePrefixText).digest('hex').slice(0, 12)
      : computeKvPrefixHash(effectiveRequest.messages || []);
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

          const isTopLossless = isLosslessSub4BitUpstream(targetUpstreams[0]);
          const isPreferredLossless = isLosslessSub4BitUpstream(preferred);
          const cannotPromoteDueToQuant = (quantizationPolicy === 'prefer-nvfp4-hadamard' || quantizationPolicy === 'lossless-reasoning') && isTopLossless && !isPreferredLossless;

          const isTopRailOptimized = isCollisionFreeRailFabricUpstream(targetUpstreams[0]);
          const isPreferredRailOptimized = isCollisionFreeRailFabricUpstream(preferred);
          const cannotPromoteDueToFabric = (fabricPolicy === 'prefer-rail-optimized') && isTopRailOptimized && !isPreferredRailOptimized;

          const isTopCrs = isNeuroSymbolicCrsUpstream(targetUpstreams[0]);
          const isPreferredCrs = isNeuroSymbolicCrsUpstream(preferred);
          const cannotPromoteDueToCrs =
            (crsPolicy === 'slice-and-verify' || strategy === 'stall-escalation') &&
            isTopCrs &&
            !isPreferredCrs;

          const cannotPromoteDueToAttention =
            (attentionPolicy === 'prefer-fa3-warp-specialized' ||
              attentionPolicy === 'prefer-blackwell-tmem' ||
              attentionPolicy === 'require-fp8-ping-pong') &&
            computeAttentionScore(preferred) < computeAttentionScore(targetUpstreams[0]);

          if (
            !cannotPromoteDueToPrefill &&
            !cannotPromoteDueToTee &&
            !cannotPromoteDueToQuant &&
            !cannotPromoteDueToFabric &&
            !cannotPromoteDueToCrs &&
            !cannotPromoteDueToAttention
          ) {
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

        const getPolicyTier = (u: UpstreamConfig): number => {
          let tier = 0;
          if (confidentialPolicy === 'prefer-tee' && !isConfidentialEnclaveUpstream(u, 'require-tee')) tier += 1000;
          if ((quantizationPolicy === 'prefer-nvfp4-hadamard' || quantizationPolicy === 'lossless-reasoning') && !isLosslessSub4BitUpstream(u)) tier += 100;
          if (fabricPolicy === 'prefer-rail-optimized' && !isCollisionFreeRailFabricUpstream(u)) tier += 20;
          if ((crsPolicy === 'slice-and-verify' || strategy === 'stall-escalation') && !isNeuroSymbolicCrsUpstream(u)) tier += 10;
          if (
            attentionPolicy === 'prefer-fa3-warp-specialized' ||
            attentionPolicy === 'prefer-blackwell-tmem' ||
            attentionPolicy === 'require-fp8-ping-pong'
          ) {
            tier += Math.max(0, 4 - computeAttentionScore(u));
          }
          return tier;
        };

        targetUpstreams.sort((a, b) => {
          const tierA = getPolicyTier(a);
          const tierB = getPolicyTier(b);
          if (tierA !== tierB) return tierA - tierB;
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

    return {
      effectiveRequest,
      complexity,
      modality,
      strategy,
      targetUpstreams,
      steps,
      budgetFallback,
      rolling24hSpendUsd,
      vendorAlias
    };
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
      // Dedicated audio STT/TTS nodes should never wildcard-capture arbitrary chat model IDs
      if (isDedicatedAudioUpstreamType(upstream.type) && requestedModel !== '*' && requestedModel !== 'default') {
        return false;
      }
      // Local inference engines shouldn't greedily capture explicit cloud/agent/harness models
      if (['lemonade', 'ollama', 'ramalama', 'comfyui', 'vllm', 'vllm-sr', 'sglang', 'switchyard'].includes(upstream.type)) {
        if (/^(gemini-|claude-|gpt-oss-120b|harness\/)/i.test(requestedModel)) return false;
      }
      if (
        upstream.type === 'comfyui' &&
        requestedModel !== '*' &&
        requestedModel !== 'default' &&
        !isExplicitMediaModelId(requestedModel)
      ) {
        return false;
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
      return this.forwardAntigravityCli(upstream, effectiveRequest, complexityScore, clientSignal, timeoutMs, scope?.userId ?? 'default');
    }

    if (upstream.type === 'comfyui') {
      return this.forwardComfyUI(upstream, effectiveRequest, timeoutMs, clientSignal);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    
    if (upstream.apiKey) {
      const resolvedApiKey =
        (await resolveUpstreamSecret(upstream.apiKey, { fetchImpl: this.deps?.fetch })) ||
        upstream.apiKey;
      headers['Authorization'] = `Bearer ${resolvedApiKey}`;
      if (upstream.type === 'anthropic' || upstream.endpoint.includes('anthropic.com')) {
        headers['x-api-key'] = resolvedApiKey;
        headers['anthropic-version'] = '2023-06-01';
      }
    }
    if (
      (upstream.type === 'anthropic' || upstream.endpoint.includes('anthropic.com')) &&
      Array.isArray(effectiveRequest.metadata?._anthropicCacheBreakpoints) &&
      effectiveRequest.metadata._anthropicCacheBreakpoints.length > 0
    ) {
      headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
    }

    // Translate Structured Outputs (`response_format`) into the engine's native grammar fields
    const structuredTranslation = translateStructuredOutputFormat(
      effectiveRequest as unknown as Record<string, any>,
      upstream
    );

    // Clean trailing slashes and ensure OpenAI-compatible completion path
    const trimmed = upstream.endpoint.trim().replace(/\/+$/, '');
    const url = trimmed.endsWith('/v1')
      ? `${trimmed}/chat/completions`
      : `${trimmed}/v1/chat/completions`;

    const fetchOptions: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify(structuredTranslation.payload)
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

    const releaseVramLease = await globalVramArbiter.acquireLease(upstream, this.config);
    let streamHoldsLease = false;

    // Initial connection / TTFT timeout
    resetTimeout(timeoutMs, `Connection or first token timed out after ${timeoutMs}ms`);
    const fetchStartTime = Date.now();

    try {
      const fetchFn = this.deps?.fetch || fetchWithSafeRedirects;
      const res = await fetchFn(url, {
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
        streamHoldsLease = true;

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
                  releaseVramLease();
                  streamController.close();
                  break;
                }
                streamController.enqueue(value);
              }
            } catch (err) {
              if (timeoutTimer) clearTimeout(timeoutTimer);
              releaseVramLease();
              streamController.error(err);
            }
          },
          cancel(reason) {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            releaseVramLease();
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
    } finally {
      if (!streamHoldsLease) {
        releaseVramLease();
      }
    }
  }

  private async forwardAntigravityCli(
    upstream: UpstreamConfig,
    request: ResolvedChatRequest,
    complexityScore: 1 | 2 | 3 | 4 = 1,
    clientSignal?: AbortSignal,
    upstreamTimeoutMs = 60000,
    userId = 'default'
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
              completion_tokens: exactCompletionTokens,
              user_id: userId
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
            completion_tokens: exactCompletionTokens,
            user_id: userId
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

  /**
   * Pillar 3: Expands a short creative prompt via a connected local LLM upstream
   * (Lemonade, Ollama, or RamaLama) before dispatching it to ComfyUI.
   */
  private async expandPromptWithLocalLlm(
    prompt: string,
    enhancerUpstreamId?: string,
    signal?: AbortSignal
  ): Promise<string> {
    if (!enhancerUpstreamId) return prompt;
    const enhancer = this.getUpstreams().find((u: UpstreamConfig) => u.id === enhancerUpstreamId);
    if (!enhancer || enhancer.type === 'comfyui') return prompt;

    try {
      const res = await this.forwardRequest(
        enhancer,
        {
          model: enhancer.models.find((m: string) => m !== '*' && m !== 'auto') || 'auto',
          stream: false,
          messages: [
            {
              role: 'system',
              content:
                'You are an expert diffusion prompt engineer for ComfyUI (Flux.1 / SDXL / Wan 2.1). Expand the user prompt into a detailed, cinematic visual description with lighting, composition, lens, and texture cues. Return ONLY the expanded prompt text without quotes or commentary.'
            },
            { role: 'user', content: prompt }
          ]
        },
        12000,
        signal
      );
      if (res.ok) {
        const json = (await res.json()) as any;
        const expanded = json?.choices?.[0]?.message?.content;
        if (typeof expanded === 'string' && expanded.trim().length > 0) {
          return expanded.trim();
        }
      }
    } catch {
      // Fallback to original prompt if local enhancer is unreachable
    }
    return prompt;
  }

  /**
   * Pillar 1 & 2: Dispatches a chat completion request to a ComfyUI instance (:8188)
   * by compiling the latest user message into a ComfyUI API-format workflow DAG.
   */
  private async forwardComfyUI(
    upstream: UpstreamConfig,
    request: ResolvedChatRequest,
    timeoutMs = 120000,
    clientSignal?: AbortSignal
  ): Promise<Response> {
    const userMessages = (request.messages || []).filter(m => m.role === 'user');
    const latestMsg = userMessages[userMessages.length - 1] || request.messages?.[request.messages.length - 1];
    const rawPrompt =
      typeof latestMsg?.content === 'string'
        ? latestMsg.content
        : Array.isArray(latestMsg?.content)
          ? latestMsg.content.map((p: any) => p?.text || '').join(' ')
          : 'A cinematic digital illustration';

    const effectivePrompt = await this.expandPromptWithLocalLlm(
      rawPrompt,
      upstream.comfyui?.promptEnhancerUpstreamId,
      clientSignal
    );

    const checkpoint =
      request.model && request.model !== 'auto' && request.model !== '*' && request.model !== 'default'
        ? request.model
        : upstream.comfyui?.checkpoint || upstream.models.find((m: string) => m !== '*' && m !== 'auto');

    const workflow = buildComfyApiWorkflow({
      prompt: effectivePrompt,
      config: upstream.comfyui,
      modelOverride: checkpoint
    });

    const releaseComfyLease = await globalVramArbiter.acquireLease(upstream, this.config);
    let result: Awaited<ReturnType<typeof executeComfyWorkflow>>;
    try {
      result = await executeComfyWorkflow(upstream.endpoint, workflow, {
        timeoutMs,
        signal: clientSignal
      });
    } catch (err: any) {
      return new Response(
        JSON.stringify({
          error: {
            message: err?.message || 'ComfyUI workflow execution failed',
            type: 'comfyui_execution_error'
          }
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    } finally {
      releaseComfyLease();
    }

    let artcraftResult: Awaited<ReturnType<typeof executeArtCraftPostProcess>> | undefined;
    if (upstream.comfyui?.postProcessArtCraftApp && result.images.length > 0) {
      artcraftResult = await executeArtCraftPostProcess({
        app: upstream.comfyui.postProcessArtCraftApp,
        sourceUrl: result.images[0].viewUrl,
        filename: result.images[0].filename,
        signal: clientSignal
      });
    }

    const mediaMarkdown =
      result.images.length > 0
        ? result.images.map(o => `![${o.filename}](${o.viewUrl})`).join('\n\n')
        : `ComfyUI queued prompt \`${result.promptId}\` on \`${upstream.endpoint}\`.`;

    const artCraftNote = upstream.comfyui?.postProcessArtCraftApp
      ? artcraftResult?.executed
        ? `\n\n*Post-processed via ArtCraft Suite (\`${artcraftResult.cliBinary}\` → \`.${artcraftResult.outputFormat}\`).*`
        : `\n\n*Chained to ArtCraft Suite (\`${upstream.comfyui.postProcessArtCraftApp}\` · \`${artcraftResult?.suggestedCommand || `${upstream.comfyui.postProcessArtCraftApp}-cli`}\`).*`
      : '';

    const content = `${mediaMarkdown}\n\n**Prompt:** ${effectivePrompt}${artCraftNote}`;
    const modelName = checkpoint || upstream.comfyui?.workflowPreset || 'comfyui-diffusion';

    if (request.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const chunk = {
            id: `chatcmpl-comfy-${result.promptId}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelName,
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content },
                finish_reason: 'stop'
              }
            ]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`));
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'x-eluvix-upstream': upstream.name,
          'x-eluvix-model': modelName
        }
      });
    }

    return new Response(
      JSON.stringify({
        id: `chatcmpl-comfy-${result.promptId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop'
          }
        ],
        comfyui: {
          prompt_id: result.promptId,
          outputs: result.images,
          revised_prompt: effectivePrompt,
          post_process_artcraft_app: upstream.comfyui?.postProcessArtCraftApp,
          artcraft_post_process: artcraftResult
        },
        usage: {
          prompt_tokens: Math.ceil(effectivePrompt.length / 4),
          completion_tokens: 64,
          total_tokens: Math.ceil(effectivePrompt.length / 4) + 64
        }
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-upstream': upstream.name,
          'x-eluvix-model': modelName
        }
      }
    );
  }

  /**
   * Pillar 2: OpenAI-compatible `/v1/images/generations` router entry point.
   * Selects the highest-priority ComfyUI upstream (or falls back to a default `:8188`
   * endpoint if requested), expands the prompt if chained to a local LLM, executes
   * the ComfyUI DAG, supports `response_format: 'url' | 'b64_json'` and HTTPS media
   * proxying, logs telemetry, and optionally runs ArtCraft headless post-processing.
   */
  public async routeImageGeneration(
    request: {
      prompt: string;
      model?: string;
      n?: number;
      size?: string;
      response_format?: 'url' | 'b64_json';
      quality?: string;
      style?: string;
      negative_prompt?: string;
      seed?: number;
      steps?: number;
      cfg?: number;
    },
    options?: { signal?: AbortSignal; timeoutMs?: number; proxyBaseUrl?: string; hops?: number; userId?: string }
  ): Promise<Response> {
    const hops = options?.hops ?? 0;
    if (hops >= 2) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Routing loop detected (x-eluvix-hops=${hops} >= 2).`,
            type: 'loop_detected',
            code: 'max_hops_exceeded'
          }
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (!request.prompt || typeof request.prompt !== 'string' || !request.prompt.trim()) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'A non-empty "prompt" string is required for image generation.',
            type: 'invalid_request_error'
          }
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (
      request.response_format !== undefined &&
      request.response_format !== 'url' &&
      request.response_format !== 'b64_json'
    ) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Invalid "response_format": expected "url" or "b64_json".',
            type: 'invalid_request_error'
          }
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const startTime = Date.now();

    // Find matching ComfyUI upstream or highest-priority healthy ComfyUI upstream
    const allComfyUpstreams = this.getUpstreams()
      .filter((u: UpstreamConfig) => u.type === 'comfyui')
      .sort((a: UpstreamConfig, b: UpstreamConfig) => b.priority - a.priority);

    const healthyComfyUpstreams = allComfyUpstreams.filter((u: UpstreamConfig) =>
      globalCircuitBreaker.isAllowed(u.id)
    );
    const comfyPool = healthyComfyUpstreams.length > 0 ? healthyComfyUpstreams : allComfyUpstreams;

    const chosen: UpstreamConfig =
      (request.model
        ? comfyPool.find((u: UpstreamConfig) => this.matchesModel(u, request.model!))
        : undefined) ||
      comfyPool[0] || {
        id: 'default-comfyui',
        name: 'Local ComfyUI (:8188)',
        type: 'comfyui',
        endpoint: 'http://127.0.0.1:8188',
        priority: 1,
        models: ['*']
      };

    const revisedPrompt = await this.expandPromptWithLocalLlm(
      request.prompt.trim(),
      chosen.comfyui?.promptEnhancerUpstreamId,
      options?.signal
    );

    const checkpoint =
      request.model &&
      request.model !== 'auto' &&
      request.model !== '*' &&
      request.model !== 'dall-e-3' &&
      request.model !== 'dall-e-2' &&
      request.model !== 'gpt-image-1'
        ? request.model
        : chosen.comfyui?.checkpoint || chosen.models.find((m: string) => m !== '*' && m !== 'auto');

    const hdStepsBoost = request.quality === 'hd' && !request.steps ? (chosen.comfyui?.steps ?? 20) + 8 : undefined;
    const mergedConfig: ComfyUIConfig = {
      ...chosen.comfyui,
      ...(hdStepsBoost ? { steps: hdStepsBoost } : {}),
      ...(request.steps ? { steps: request.steps } : {}),
      ...(request.cfg ? { cfg: request.cfg } : {})
    };

    const workflow = buildComfyApiWorkflow({
      prompt: revisedPrompt,
      negativePrompt: request.negative_prompt,
      config: mergedConfig,
      modelOverride: checkpoint,
      sizeOverride: request.size,
      seedOverride: request.seed,
      batchSizeOverride: request.n
    });

    const effectiveModelLabel = checkpoint || chosen.comfyui?.workflowPreset || 'comfyui-diffusion';
    const estPromptTokens = Math.ceil(revisedPrompt.length / 4);

    const releaseImageLease = await globalVramArbiter.acquireLease(chosen, this.config);
    let result: Awaited<ReturnType<typeof executeComfyWorkflow>>;
    try {
      result = await executeComfyWorkflow(chosen.endpoint, workflow, {
        timeoutMs: options?.timeoutMs ?? 120000,
        signal: options?.signal
      });
      globalCircuitBreaker.recordSuccess(chosen.id);
    } catch (err: any) {
      globalCircuitBreaker.recordFailure(chosen.id);
      const duration_ms = Date.now() - startTime;
      try {
        logRequest({
          model: effectiveModelLabel,
          upstream_id: chosen.id,
          status: 502,
          duration_ms,
          prompt_tokens: estPromptTokens,
          completion_tokens: 0,
          user_id: options?.userId ?? 'default'
        });
      } catch {}
      return new Response(
        JSON.stringify({
          error: {
            message: err?.message || 'ComfyUI image generation failed',
            type: 'comfyui_execution_error'
          }
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    } finally {
      releaseImageLease();
    }

    let artcraftResult: Awaited<ReturnType<typeof executeArtCraftPostProcess>> | undefined;
    if (chosen.comfyui?.postProcessArtCraftApp && result.images.length > 0) {
      artcraftResult = await executeArtCraftPostProcess({
        app: chosen.comfyui.postProcessArtCraftApp,
        sourceUrl: result.images[0].viewUrl,
        filename: result.images[0].filename,
        signal: options?.signal
      });
    }

    const proxyBase = options?.proxyBaseUrl ? options.proxyBaseUrl.replace(/\/+$/, '') : '';
    const buildClientUrl = (o: (typeof result.images)[number]) => {
      if (!proxyBase) return o.viewUrl;
      const qs = new URLSearchParams({
        upstream: chosen.id,
        filename: o.filename,
        subfolder: o.subfolder,
        type: o.type
      });
      return `${proxyBase}/api/v1/images/view?${qs.toString()}`;
    };

    let data: Array<Record<string, any>>;
    if (request.response_format === 'b64_json') {
      try {
        data = await Promise.all(
          result.images.map(async o => {
            const encoded = await fetchComfyMediaAsBase64(o.viewUrl, { signal: options?.signal });
            return {
              b64_json: encoded.b64Json,
              content_type: encoded.contentType,
              filename: o.filename,
              subfolder: o.subfolder,
              revised_prompt: revisedPrompt
            };
          })
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({
            error: {
              message: err?.message || 'Failed to encode ComfyUI output as b64_json',
              type: 'comfyui_execution_error'
            }
          }),
          { status: 502, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } else {
      data = result.images.map(o => ({
        url: buildClientUrl(o),
        ...(proxyBase ? { comfy_view_url: o.viewUrl } : {}),
        filename: o.filename,
        subfolder: o.subfolder,
        revised_prompt: revisedPrompt
      }));
    }

    const duration_ms = Date.now() - startTime;
    const imageCompletionTokens = Math.max(1, data.length) * 64;
    const imageCostUsd = estimateUpstreamRequestCostUsd(chosen, estPromptTokens, imageCompletionTokens);
    try {
      logRequest({
        model: effectiveModelLabel,
        upstream_id: chosen.id,
        status: 200,
        duration_ms,
        prompt_tokens: estPromptTokens,
        completion_tokens: imageCompletionTokens,
        ttft_ms: duration_ms,
        cost_usd: imageCostUsd,
        user_id: options?.userId ?? 'default'
      });
    } catch {}

    return new Response(
      JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        prompt_id: result.promptId,
        upstream: chosen.name,
        post_process_artcraft_app: chosen.comfyui?.postProcessArtCraftApp,
        ...(artcraftResult ? { artcraft_post_process: artcraftResult } : {}),
        data
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-upstream': chosen.name,
          'x-eluvix-model': effectiveModelLabel
        }
      }
    );
  }

  /**
   * Sovereign Embeddings Router (`/v1/embeddings`).
   * Scrubs input strings through `PrivacyGuard` before egress, routes across local
   * (`ollama` `/api/embed` + `/v1/embeddings`, `ramalama`, `lemonade`, `vllm`, `sglang`)
   * and cloud upstreams with SSRF validation, and enforces vector dimension pinning
   * plus Matryoshka L2-normalized prefix slicing so failover never corrupts vector DBs.
   */
  public async routeEmbeddings(
    request: {
      model?: string;
      input: string | string[];
      dimensions?: number;
      encoding_format?: 'float' | 'base64';
      user?: string;
    },
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      scope?: Partial<RequestScope>;
      hops?: number;
    }
  ): Promise<Response> {
    return executeEmbeddingsForward(
      this.config,
      this.getUpstreams(),
      request,
      options,
      this.deps
    );
  }

  public async routeAudioTranscription(
    request: {
      file: Blob | Uint8Array;
      filename?: string;
      mimeType?: string;
      model?: string;
      language?: string;
      prompt?: string;
      response_format?: TranscriptionResponseFormat;
      temperature?: number;
    },
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      scope?: Partial<RequestScope>;
      hops?: number;
    }
  ): Promise<Response> {
    return executeAudioTranscriptionForward(
      this.config,
      this.getUpstreams(),
      request,
      options,
      this.deps
    );
  }

  public async routeAudioSpeech(
    request: {
      input: string;
      model?: string;
      voice?: string;
      response_format?: AudioResponseFormat;
      speed?: number;
    },
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      scope?: Partial<RequestScope>;
      hops?: number;
    }
  ): Promise<Response> {
    return executeAudioSpeechForward(
      this.config,
      this.getUpstreams(),
      request,
      options,
      this.deps
    );
  }

  public async routeRerank(
    request: RerankRequest,
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      userId?: string;
    }
  ): Promise<Response> {
    return executeRerankRequest(this.config, this.getUpstreams(), request, {
      fetchImpl: this.deps?.fetch,
      userId: options?.userId,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
  }
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
