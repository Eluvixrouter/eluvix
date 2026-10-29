/**
 * Roofline model arithmetic intensity and KV-cache network transfer physics.
 * Based on research from Disaggregated LLM Serving over RDMA / RoCEv2 fabrics.
 */

export interface ModelKvProfile {
  name: string;
  architecture: 'GQA' | 'MLA' | 'MHA';
  layers: number;
  kvHeads?: number;
  headDim?: number;
  // MLA-specific parameters (DeepSeek-V3 / R1)
  latentDim?: number;      // d_c (e.g. 512)
  ropeKeyDim?: number;     // d_R (e.g. 64)
  hiddenDim: number;
}

export const MODEL_KV_PROFILES: Record<string, ModelKvProfile> = {
  'llama-3.1-8b': {
    name: 'Llama-3.1-8B-Instruct',
    architecture: 'GQA',
    layers: 32,
    kvHeads: 8,
    headDim: 128,
    hiddenDim: 4096
  },
  'llama-3.3-70b': {
    name: 'Llama-3.3-70B-Instruct',
    architecture: 'GQA',
    layers: 80,
    kvHeads: 8,
    headDim: 128,
    hiddenDim: 8192
  },
  'qwen-2.5-72b': {
    name: 'Qwen-2.5-72B-Instruct',
    architecture: 'GQA',
    layers: 80,
    kvHeads: 8,
    headDim: 128,
    hiddenDim: 8192
  },
  'deepseek-v3': {
    name: 'DeepSeek-V3 / R1 (671B MoE)',
    architecture: 'MLA',
    layers: 61,
    latentDim: 512,
    ropeKeyDim: 64,
    hiddenDim: 7168
  },
  'llama-3.1-405b': {
    name: 'Llama-3.1-405B-Instruct',
    architecture: 'GQA',
    layers: 126,
    kvHeads: 8,
    headDim: 128,
    hiddenDim: 16384
  }
};

export type KvCacheDtype = 'fp8_e4m3' | 'fp8' | 'bf16' | 'fp16' | 'nvfp4' | 'mxfp4';

export interface KvFootprintEstimate {
  modelKey: string;
  modelName: string;
  architecture: 'GQA' | 'MLA' | 'MHA';
  dtype: KvCacheDtype;
  bytesPerElement: number;
  bytesPerToken: number;
  kibPerToken: number;
  promptTokens: number;
  totalBytes: number;
  totalMiB: number;
  totalMB: number;
  mlaCompressionRatio?: number;
}

export interface EstimateKvCacheOptions {
  modelArch?: string;
  kvPrecision?: KvCacheDtype;
  tokens?: number;
}

/**
 * Calculates exact KV-cache footprint per token and total prompt size.
 *
 * For GQA: 2 * L * H_kv * D_h * B_elem
 *   E.g., Llama-3.3-70B FP8: 2 * 80 * 8 * 128 * 1 = 163,840 bytes = 160 KiB/token
 *
 * For MLA (DeepSeek-V3/R1): L * (d_c + d_R) * B_elem
 *   E.g., DeepSeek-V3 FP8: 61 * (512 + 64) * 1 = 35,136 bytes = ~34.3 KiB/token (4.66x smaller!)
 */
export function estimateKvCacheFootprint(
  modelIdentifierOrOptions: string | EstimateKvCacheOptions,
  promptTokensArg?: number,
  dtypeArg: KvCacheDtype = 'fp8_e4m3'
): KvFootprintEstimate {
  let modelIdentifier = 'llama-3.3-70b';
  let promptTokens = 2048;
  let dtype = dtypeArg;

  if (typeof modelIdentifierOrOptions === 'object' && modelIdentifierOrOptions !== null) {
    modelIdentifier = modelIdentifierOrOptions.modelArch || 'llama-3.3-70b';
    promptTokens = modelIdentifierOrOptions.tokens ?? 2048;
    dtype = modelIdentifierOrOptions.kvPrecision || dtypeArg;
  } else if (typeof modelIdentifierOrOptions === 'string') {
    modelIdentifier = modelIdentifierOrOptions;
    promptTokens = promptTokensArg ?? 2048;
  }

  const normalized = (modelIdentifier || '').toLowerCase();
  let profile = MODEL_KV_PROFILES['llama-3.3-70b'];

  if (normalized.includes('405b')) {
    profile = MODEL_KV_PROFILES['llama-3.1-405b'];
  } else if (normalized.includes('8b') && (normalized.includes('llama') || normalized.includes('distill'))) {
    profile = MODEL_KV_PROFILES['llama-3.1-8b'];
  } else if (normalized.includes('deepseek') || normalized.includes('r1') || normalized.includes('mla')) {
    profile = MODEL_KV_PROFILES['deepseek-v3'];
  } else if (normalized.includes('8b')) {
    profile = MODEL_KV_PROFILES['llama-3.1-8b'];
  } else if (normalized.includes('qwen')) {
    profile = MODEL_KV_PROFILES['qwen-2.5-72b'];
  }

  const is16Bit = dtype === 'bf16' || dtype === 'fp16';
  const bytesPerElement = is16Bit
    ? 2
    : dtype === 'nvfp4'
    ? 0.5625 // 4.50 bits/element (16 x E2M1 + 1 x E4M3 scale)
    : dtype === 'mxfp4'
    ? 0.53125 // 4.25 bits/element (32 x E2M1 + 1 x E8M0 scale)
    : 1;

  let bytesPerToken = 0;
  if (profile.architecture === 'MLA') {
    const totalLatentElements = (profile.latentDim || 512) + (profile.ropeKeyDim || 64);
    bytesPerToken = profile.layers * totalLatentElements * bytesPerElement;
  } else {
    bytesPerToken = 2 * profile.layers * (profile.kvHeads || 8) * (profile.headDim || 128) * bytesPerElement;
  }

  const kibPerToken = bytesPerToken / 1024;
  const totalBytes = promptTokens * bytesPerToken;
  const totalMiB = totalBytes / (1024 * 1024);
  const totalMB = totalBytes / 1000000;

  // MLA compression ratio vs GQA-8 80-layer standard (160 KiB/tok)
  let mlaCompressionRatio = 1.0;
  if (profile.architecture === 'MLA') {
    mlaCompressionRatio = Number(((160 * bytesPerElement) / Math.max(1, kibPerToken)).toFixed(2));
  }

  return {
    modelKey: profile.name,
    modelName: profile.name,
    architecture: profile.architecture,
    dtype,
    bytesPerElement,
    bytesPerToken,
    kibPerToken: Number(kibPerToken.toFixed(2)),
    promptTokens,
    totalBytes,
    totalMiB: Number(totalMiB.toFixed(2)),
    totalMB: Number(totalMB.toFixed(2)),
    mlaCompressionRatio
  };
}

export interface NetworkFabricConfig {
  name: string;
  goodputGbps: number;
  goodputGBps: number;
  isRdma: boolean;
}

export const NETWORK_FABRICS: Record<string, NetworkFabricConfig> = {
  '100g-tcp': { name: '100GbE TCP/IP (No RDMA)', goodputGbps: 68, goodputGBps: 8.5, isRdma: false },
  '200g-roce': { name: '200GbE RoCEv2 (ConnectX-6 Dx)', goodputGbps: 180, goodputGBps: 22.5, isRdma: true },
  '400g-roce': { name: '400GbE RoCEv2 / NDR400 IB (ConnectX-7)', goodputGbps: 376, goodputGBps: 47.0, isRdma: true },
  '800g-roce': { name: '800GbE RoCEv2 / XDR800 IB (ConnectX-8)', goodputGbps: 752, goodputGBps: 94.0, isRdma: true }
};

export interface RdmaSimulationResult {
  footprint: KvFootprintEstimate;
  fabric: NetworkFabricConfig;
  arithmeticIntensityFlopsPerByte: number;
  h100RooflineRidgeFlopsPerByte: number;
  isComputeBoundPrefill: boolean;
  prefillComputeMsEstimate: number;
  rawWireTransferMs: number;
  pipelinedExposedTransferMs: number;
  colocatedP99ItlStallMs: number;
  disaggregatedP99ItlMs: number;
  slaTargetItlMs: number;
  meetsItlSlaColocated: boolean;
  meetsItlSlaDisaggregated: boolean;
  overlapPercentage: number;
  exposedLatencyMs: number;
  totalKvCacheMebibytes: number;
}

export interface SimulateDisaggregatedRdmaOptions {
  modelArch?: string;
  kvPrecision?: KvCacheDtype;
  fabricBandwidthGbps?: number;
  contextTokens?: number;
  gpuType?: 'b200-sxm6' | 'h100-sxm5' | 'a100-sxm4' | 'rtx-4090';
}

export function estimateRawNetworkTransferMs(totalBytes: number, bandwidthGbps: number): number {
  const wireBps = (bandwidthGbps * 1e9) / 8;
  return Number(((totalBytes / wireBps) * 1000).toFixed(2));
}

export function calculateRooflineRidgePoint(
  gpu: 'b200-sxm6' | 'h100-sxm5' | 'a100-sxm4' | 'rtx-4090' = 'h100-sxm5',
  precision: 'nvfp4' | 'mxfp4' | 'fp8' | 'fp16' | 'bf16' = 'fp8'
): { peakTflops: number; memoryBandwidthTBps: number; ridgePointFlopsPerByte: number } {
  let peakTflops = 989.4;
  let memoryBandwidthTBps = 3.35;

  if (gpu === 'b200-sxm6') {
    peakTflops =
      precision === 'nvfp4' || precision === 'mxfp4'
        ? 20000.0 // 20 PFLOPS dense on SM100 tcgen05.mma.kind::mxf4nvf4
        : precision === 'fp8'
        ? 9000.0
        : 4500.0;
    memoryBandwidthTBps = 8.0;
  } else if (gpu === 'h100-sxm5') {
    peakTflops = precision === 'fp8' || precision === 'nvfp4' || precision === 'mxfp4' ? 989.4 : 494.7;
    memoryBandwidthTBps = 3.35;
  } else if (gpu === 'a100-sxm4') {
    peakTflops = 312.0;
    memoryBandwidthTBps = 2.0;
  } else if (gpu === 'rtx-4090') {
    peakTflops = precision === 'fp8' || precision === 'nvfp4' || precision === 'mxfp4' ? 330.0 : 165.0;
    memoryBandwidthTBps = 1.008;
  }

  const ridgePointFlopsPerByte = Number(((peakTflops * 1e12) / (memoryBandwidthTBps * 1e12)).toFixed(1));
  return { peakTflops, memoryBandwidthTBps, ridgePointFlopsPerByte };
}

/**
 * Simulates layer-pipelined GPUDirect RDMA transfer times vs. co-located
 * chunked prefill head-of-line stalls.
 */
export function simulateDisaggregatedRdma(
  modelKeyOrOptions: string | SimulateDisaggregatedRdmaOptions,
  promptTokensArg?: number,
  fabricKeyArg = '400g-roce',
  chunkedPrefillTokens = 2048,
  dtypeArg: KvCacheDtype = 'fp8_e4m3'
): RdmaSimulationResult {
  let modelKey = 'llama-3.3-70b';
  let promptTokens = promptTokensArg ?? 2048;
  let fabricKey = fabricKeyArg;
  let dtype = dtypeArg;

  let gpuType: 'b200-sxm6' | 'h100-sxm5' | 'a100-sxm4' | 'rtx-4090' = 'h100-sxm5';

  if (typeof modelKeyOrOptions === 'object' && modelKeyOrOptions !== null) {
    modelKey = modelKeyOrOptions.modelArch || 'llama-3.3-70b';
    promptTokens = modelKeyOrOptions.contextTokens ?? 2048;
    dtype = modelKeyOrOptions.kvPrecision || 'fp8_e4m3';
    if (modelKeyOrOptions.gpuType) {
      gpuType = modelKeyOrOptions.gpuType;
    }
    if (modelKeyOrOptions.fabricBandwidthGbps) {
      if (modelKeyOrOptions.fabricBandwidthGbps >= 800) fabricKey = '800g-roce';
      else if (modelKeyOrOptions.fabricBandwidthGbps >= 400) fabricKey = '400g-roce';
      else if (modelKeyOrOptions.fabricBandwidthGbps >= 200) fabricKey = '200g-roce';
      else fabricKey = '100g-tcp';
    }
  } else if (typeof modelKeyOrOptions === 'string') {
    modelKey = modelKeyOrOptions;
  }

  const footprint = estimateKvCacheFootprint(modelKey, promptTokens, dtype);
  const fabric = NETWORK_FABRICS[fabricKey] || NETWORK_FABRICS['400g-roce'];

  // Roofline ridge point calculated for the target GPU architecture and precision:
  const rooflinePrecision: 'nvfp4' | 'mxfp4' | 'fp8' | 'fp16' | 'bf16' =
    dtype === 'nvfp4'
      ? 'nvfp4'
      : dtype === 'mxfp4'
      ? 'mxfp4'
      : dtype.startsWith('fp8')
      ? 'fp8'
      : dtype === 'bf16'
      ? 'bf16'
      : 'fp16';
  const roofline = calculateRooflineRidgePoint(gpuType, rooflinePrecision);
  const h100RooflineRidgeFlopsPerByte = roofline.ridgePointFlopsPerByte;
  const matchedProfile = Object.values(MODEL_KV_PROFILES).find(p => p.name === footprint.modelName) || MODEL_KV_PROFILES['llama-3.3-70b'];
  const hiddenDim = matchedProfile.hiddenDim || 8192;
  const layers = matchedProfile.layers || 80;
  const bytesPerElement = footprint.bytesPerElement || 2;
  const arithmeticIntensityFlopsPerByte =
    (2 * promptTokens) / (bytesPerElement * (1 + (2 * promptTokens) / hiddenDim));
  const isComputeBoundPrefill = arithmeticIntensityFlopsPerByte > h100RooflineRidgeFlopsPerByte;

  // Compute time estimate on 4x H100 (TP=4): ~35-45 TFLOPS achieved per GPU on prefill
  // Empirical estimate: ~35-40 microseconds per token on 70B FP8 TP4
  const prefillComputeMsEstimate = Math.max(12, Number(((promptTokens * 0.038)).toFixed(1)));

  // Raw wire transfer time: totalBytes / (goodputGBps * 1e9)
  const rawWireTransferMs = Number(((footprint.totalBytes / (fabric.goodputGBps * 1e9)) * 1000).toFixed(1));

  // Layer-by-layer pipelined overlap (NIXL / Mooncake):
  // (L - 1) / L of the transfer is overlapped with layer computation; only the final layer
  // transfer is exposed, plus RDMA verb setup (< 1-2 ms).
  let pipelinedExposedTransferMs = 1.5;
  if (!fabric.isRdma) {
    // TCP CPU bounce cannot pipeline without host memory stall
    pipelinedExposedTransferMs = Number((rawWireTransferMs * 0.45).toFixed(1));
  } else {
    const rdmaSyncOverheadMs = rawWireTransferMs < 5 ? 0.2 : 0.5;
    pipelinedExposedTransferMs = Number(Math.max(0.1, (rawWireTransferMs * (1 / layers)) + rdmaSyncOverheadMs).toFixed(1));
  }

  const exposedLatencyMs = pipelinedExposedTransferMs;
  const overlapPercentage = Number((Math.min(99.4, Math.max(0.0, ((rawWireTransferMs - pipelinedExposedTransferMs) / Math.max(1, rawWireTransferMs)) * 100))).toFixed(1));
  const totalKvCacheMebibytes = footprint.totalMiB;

  // Co-located chunked prefill ITL stall:
  // When a chunked prefill (e.g. 2048 tokens) is scheduled alongside decode batches,
  // the SMs execute a prefill GEMM chunk, stretching the step from ~18ms to ~85-130ms.
  const chunkFactor = Math.min(promptTokens, chunkedPrefillTokens);
  const colocatedP99ItlStallMs = Number((18 + (chunkFactor * 0.048)).toFixed(1));

  // Disaggregated ITL:
  // Pure GEMV decode step without SM prefill contention. Step latency is bounded
  // by HBM bandwidth reading active weights and KV cache, scaling smoothly with context size.
  const disaggregatedP99ItlMs = Number((18.2 + (footprint.totalMiB * 0.0015)).toFixed(1));

  const slaTargetItlMs = 30.0;
  return {
    footprint,
    fabric,
    arithmeticIntensityFlopsPerByte: Number(arithmeticIntensityFlopsPerByte.toFixed(1)),
    h100RooflineRidgeFlopsPerByte,
    isComputeBoundPrefill,
    prefillComputeMsEstimate,
    rawWireTransferMs,
    pipelinedExposedTransferMs,
    colocatedP99ItlStallMs,
    disaggregatedP99ItlMs,
    slaTargetItlMs,
    meetsItlSlaColocated: colocatedP99ItlStallMs <= slaTargetItlMs,
    meetsItlSlaDisaggregated: disaggregatedP99ItlMs <= slaTargetItlMs,
    overlapPercentage,
    exposedLatencyMs,
    totalKvCacheMebibytes
  };
}
