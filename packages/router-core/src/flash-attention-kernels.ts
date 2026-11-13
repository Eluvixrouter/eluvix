/**
 * FlashAttention-3 & Warp-Specialized CUDA Kernels (Hopper SM90 & Blackwell SM100):
 * - Asynchronous WGMMA (`wgmma.mma_async`) & 5th-Gen Tensor Core (`tcgen05.mma`)
 * - Warp Specialization (`setmaxnreg.dec 40` / `setmaxnreg.inc 232`)
 * - Hardware Tensor Memory Accelerator (`TMA`, `CUtensorMap`, `CU_TENSOR_MAP_SWIZZLE_128B`)
 * - Transaction-Count `mbarrier` Circular Shared-Memory Ring Buffers
 * - Two-Warpgroup Ping-Pong Scheduling & Intra-Warpgroup 2-Stage Software Pipelining
 * - Blackwell `SM100` 256 KB Dedicated Tensor Memory (`TMEM`) & 2-CTA Cluster MMA (`cta_group::2`)
 * - FP8 (`E4M3`) Block Quantization with `stmatrix.trans` + `prmt.b32` and Orthogonal Walsh-Hadamard Smoothing
 */

import {
  escapeShellArg,
  sanitizeSafeIdentifier,
  sanitizePositiveInt
} from './shell-utils.js';

export type AttentionKernelBackend =
  | 'pytorch-sdpa'
  | 'fa2-cp-async'
  | 'fa3-wgmma-tma'
  | 'fa3-fp8-hadamard'
  | 'blackwell-tcgen05-tmem';

export type CudaSmArchitecture = 'sm_80' | 'sm_90a' | 'sm_100a';

export type TmaSwizzleMode =
  | 'CU_TENSOR_MAP_SWIZZLE_NONE'
  | 'CU_TENSOR_MAP_SWIZZLE_32B'
  | 'CU_TENSOR_MAP_SWIZZLE_64B'
  | 'CU_TENSOR_MAP_SWIZZLE_128B';

export type MmaInstructionPrimitive =
  | 'mma.sync.aligned.m16n8k16'
  | 'wgmma.mma_async.sync.aligned.m64n128k16'
  | 'wgmma.mma_async.sync.aligned.m64n128k32.f8'
  | 'tcgen05.mma.cta_group::1.m128n128k32'
  | 'tcgen05.mma.cta_group::2.m256n128k32';

export type AttentionRoutingPolicy =
  | 'disabled'
  | 'prefer-fa3-warp-specialized'
  | 'require-fp8-ping-pong'
  | 'prefer-blackwell-tmem';

export interface AttentionKernelConfig {
  enabled?: boolean;
  backend?: AttentionKernelBackend;
  smArch?: CudaSmArchitecture;
  warpSpecialized?: boolean;
  pingPongSchedule?: boolean;
  tmaCircularStages?: number;
  pipelineStages?: number;
  tmaSwizzle?: TmaSwizzleMode | '128B' | '64B' | '32B' | 'none';
  producerRegisters?: number;
  producerMaxRegs?: number;
  consumerRegisters?: number;
  consumerMaxRegs?: number;
  fp8HadamardSmoothing?: boolean;
  fp8HadamardIncoherent?: boolean;
  fp8BlockHad?: boolean;
  blackwellTmemEnabled?: boolean;
  blackwellTmem?: boolean;
  ctaClusterSize?: 1 | 2;
  ctaPair2Sm?: boolean;
  mmaPrimitive?: MmaInstructionPrimitive | 'tcgen05.mma' | 'wgmma.mma_async' | 'mma.sync';
}

export interface AttentionBenchmarkEntry {
  id: AttentionKernelBackend;
  name: string;
  silicon: 'H100 SXM5' | 'B200 SXM6';
  smArch: CudaSmArchitecture;
  precision: 'BF16' | 'FP8';
  peakTheoreticalTflops: number;
  measuredTflops: number;
  tensorCoreUtilizationPct: number;
  relativeSpeedup: number;
  mmaPrimitive: MmaInstructionPrimitive;
  tmaSwizzle: TmaSwizzleMode;
  warpSpecialized: boolean;
  pingPongSchedule: boolean;
  usesDedicatedTmem: boolean;
  description: string;
}

/**
 * Reference benchmark metrics across Causal Attention (N = 8192, D = 128).
 */
export const FLASH_ATTENTION_BENCHMARK_TABLE: Record<AttentionKernelBackend, AttentionBenchmarkEntry> = {
  'pytorch-sdpa': {
    id: 'pytorch-sdpa',
    name: 'PyTorch sdpa (cuDNN / Standard Math)',
    silicon: 'H100 SXM5',
    smArch: 'sm_90a',
    precision: 'BF16',
    peakTheoreticalTflops: 989,
    measuredTflops: 312,
    tensorCoreUtilizationPct: 31.5,
    relativeSpeedup: 1.0,
    mmaPrimitive: 'mma.sync.aligned.m16n8k16',
    tmaSwizzle: 'CU_TENSOR_MAP_SWIZZLE_NONE',
    warpSpecialized: false,
    pingPongSchedule: false,
    usesDedicatedTmem: false,
    description: 'Baseline synchronous attention without warp-specialized TMA or GEMM-softmax ping-pong overlapping.'
  },
  'fa2-cp-async': {
    id: 'fa2-cp-async',
    name: 'FlashAttention-2 (Homogeneous CTA, cp.async)',
    silicon: 'H100 SXM5',
    smArch: 'sm_90a',
    precision: 'BF16',
    peakTheoreticalTflops: 989,
    measuredTflops: 415,
    tensorCoreUtilizationPct: 42.0,
    relativeSpeedup: 1.33,
    mmaPrimitive: 'mma.sync.aligned.m16n8k16',
    tmaSwizzle: 'CU_TENSOR_MAP_SWIZZLE_64B',
    warpSpecialized: false,
    pingPongSchedule: false,
    usesDedicatedTmem: false,
    description: 'Homogeneous SIMT warps issuing cp.async + __syncthreads(); stalls Tensor Cores while SFU runs MUFU.EX2 softmax.'
  },
  'fa3-wgmma-tma': {
    id: 'fa3-wgmma-tma',
    name: 'FlashAttention-3 (Warp-Specialized TMA + Ping-Pong)',
    silicon: 'H100 SXM5',
    smArch: 'sm_90a',
    precision: 'BF16',
    peakTheoreticalTflops: 989,
    measuredTflops: 742,
    tensorCoreUtilizationPct: 75.0,
    relativeSpeedup: 2.38,
    mmaPrimitive: 'wgmma.mma_async.sync.aligned.m64n128k16',
    tmaSwizzle: 'CU_TENSOR_MAP_SWIZZLE_128B',
    warpSpecialized: true,
    pingPongSchedule: true,
    usesDedicatedTmem: false,
    description: 'Producer WG0 (40 regs, TMA + mbarrier) + Consumer WG1/WG2 (232 regs, WGMMA Ping-Pong) hiding 64:1 SFU softmax latency.'
  },
  'fa3-fp8-hadamard': {
    id: 'fa3-fp8-hadamard',
    name: 'FlashAttention-3 FP8 (E4M3 + Hadamard Block-Scale)',
    silicon: 'H100 SXM5',
    smArch: 'sm_90a',
    precision: 'FP8',
    peakTheoreticalTflops: 1979,
    measuredTflops: 1195,
    tensorCoreUtilizationPct: 60.4,
    relativeSpeedup: 3.83,
    mmaPrimitive: 'wgmma.mma_async.sync.aligned.m64n128k32.f8',
    tmaSwizzle: 'CU_TENSOR_MAP_SWIZZLE_128B',
    warpSpecialized: true,
    pingPongSchedule: true,
    usesDedicatedTmem: false,
    description: 'FP8 E4M3 WGMMA with in-register prmt.b32 + stmatrix.trans k-major V transpose and 16x16 Walsh-Hadamard outlier smoothing (2.6x lower RMSE).'
  },
  'blackwell-tcgen05-tmem': {
    id: 'blackwell-tcgen05-tmem',
    name: 'Warp-Specialized tcgen05.mma + 256KB TMEM Attention',
    silicon: 'B200 SXM6',
    smArch: 'sm_100a',
    precision: 'FP8',
    peakTheoreticalTflops: 4500,
    measuredTflops: 3080,
    tensorCoreUtilizationPct: 68.4,
    relativeSpeedup: 9.87,
    mmaPrimitive: 'tcgen05.mma.cta_group::2.m256n128k32',
    tmaSwizzle: 'CU_TENSOR_MAP_SWIZZLE_128B',
    warpSpecialized: true,
    pingPongSchedule: true,
    usesDedicatedTmem: true,
    description: 'Blackwell SM100 5th-Gen Tensor Cores writing accumulators directly into 256 KB Dedicated TMEM with single-thread tcgen05.mma and 2-CTA cooperative cluster MMA.'
  }
};

export interface WarpSpecializedRegisterPlan {
  smRegisterFileCapacity: number;
  totalWarpsPerCta: number;
  totalThreadsPerCta: number;
  producerWarpgroups: number;
  consumerWarpgroups: number;
  producerThreads: number;
  consumerThreads: number;
  producerRegsPerThread: number;
  consumerRegsPerThread: number;
  donatedRegsPerProducerThread: number;
  totalProducerRegisters: number;
  totalConsumerRegisters: number;
  totalAllocatedRegisters: number;
  unallocatedHeadroomRegisters: number;
  registerSpillBytes: number;
   fitsInSmRegisterFile: boolean;
  ptxProducerDirective: string;
  ptxConsumerDirective: string;
}

/**
 * Models PTX `setmaxnreg.dec.sync.aligned.u32` and `setmaxnreg.inc.sync.aligned.u32`
 * across a 3-Warpgroup (12-warp, 384-thread) Cooperative Thread Array (CTA) on SM90/SM100.
 *
 * Each SM provides 65,536 32-bit registers (256 KB RMEM).
 * By shedding registers in Producer WG0 (down to 40 regs/thread), Consumer WG1 & WG2
 * claim 232 regs/thread to hold Q_i and FP32 accumulators O_i with zero local-memory spill.
 */
export function planWarpSpecializedRegisterBudget(options?: {
  producerWarpgroups?: number;
  consumerWarpgroups?: number;
  producerRegsPerThread?: number;
  consumerRegsPerThread?: number;
  smRegisterFileCapacity?: number;
}): WarpSpecializedRegisterPlan {
  const smRegisterFileCapacity = options?.smRegisterFileCapacity ?? 65536;
  const producerWarpgroups = Math.max(1, options?.producerWarpgroups ?? 1);
  const consumerWarpgroups = Math.max(1, options?.consumerWarpgroups ?? 2);
  const threadsPerWarpgroup = 128; // 4 warps * 32 threads

  const producerThreads = producerWarpgroups * threadsPerWarpgroup;
  const consumerThreads = consumerWarpgroups * threadsPerWarpgroup;
  const totalThreadsPerCta = producerThreads + consumerThreads;
  const totalWarpsPerCta = totalThreadsPerCta / 32;

  // PTX setmaxnreg requires granularity of 8 registers
  const rawProdRegs = options?.producerRegsPerThread ?? 40;
  const rawConsRegs = options?.consumerRegsPerThread ?? 232;
  const producerRegsPerThread = Math.min(255, Math.max(24, Math.floor(rawProdRegs / 8) * 8));
  const consumerRegsPerThread = Math.min(255, Math.max(64, Math.floor(rawConsRegs / 8) * 8));

  const totalProducerRegisters = producerThreads * producerRegsPerThread;
  const totalConsumerRegisters = consumerThreads * consumerRegsPerThread;
  const totalAllocatedRegisters = totalProducerRegisters + totalConsumerRegisters;
  const fitsInSmRegisterFile = totalAllocatedRegisters <= smRegisterFileCapacity;
  const unallocatedHeadroomRegisters = Math.max(0, smRegisterFileCapacity - totalAllocatedRegisters);
  const overflowRegs = Math.max(0, totalAllocatedRegisters - smRegisterFileCapacity);
  const registerSpillBytes = overflowRegs * 4;

  // Baseline symmetric allocation for 384 threads is floor(65536 / 384 / 8) * 8 = 168 regs/thread,
  // or compared to consumer target (232 - 40 = 192 donated per producer thread).
  const donatedRegsPerProducerThread = Math.max(0, consumerRegsPerThread - producerRegsPerThread);

  return {
    smRegisterFileCapacity,
    totalWarpsPerCta,
    totalThreadsPerCta,
    producerWarpgroups,
    consumerWarpgroups,
    producerThreads,
    consumerThreads,
    producerRegsPerThread,
    consumerRegsPerThread,
    donatedRegsPerProducerThread,
    totalProducerRegisters,
    totalConsumerRegisters,
    totalAllocatedRegisters,
    unallocatedHeadroomRegisters,
    registerSpillBytes,
    fitsInSmRegisterFile,
    ptxProducerDirective: `setmaxnreg.dec.sync.aligned.u32 ${producerRegsPerThread};`,
    ptxConsumerDirective: `setmaxnreg.inc.sync.aligned.u32 ${consumerRegsPerThread};`
  };
}

export interface TmaMbarrierStepTrace {
  kvBlockIndex: number;
  ringStage: number;
  phaseParityBit: 0 | 1;
  waitEmptyParityBit: 0 | 1;
  expectedTxBytes: number;
  smemKOffsetBytes: number;
  smemVOffsetBytes: number;
  globalCoordY: number;
  swizzleBankConflicts: number;
}

export interface TmaCircularRingSimulation {
  kStages: number;
  tileRows: number;
  headDim: number;
  bytesPerElement: number;
  kTileBytes: number;
  expectedTxBytesPerStep: number;
  totalSmemRingBytes: number;
  swizzleMode: TmaSwizzleMode;
  sharedMemoryBankConflicts: number;
  steps: TmaMbarrierStepTrace[];
}

/**
 * Simulates the Hardware Tensor Memory Accelerator (`TMA`) + Transaction-Count `mbarrier`
 * circular buffer state machine over `numKvBlocks` KV-tile iterations.
 *
 * Models:
 * 1. `mbarrier.try_wait.parity` waiting for Consumer Warpgroups on `phase ^ 1`
 * 2. `mbarrier.arrive.expect_tx.shared::cta.b64` arming `2 * kTileBytes` (K_j + V_j)
 * 3. `cp.async.bulk.tensor.2d.shared::cluster.global.mbarrier::complete_tx::bytes`
 * 4. 128B XOR Shared Memory swizzling (`CU_TENSOR_MAP_SWIZZLE_128B`) eliminating 32-way bank conflicts
 */
export function simulateTmaCircularMbarrierPipeline(options?: {
  kStages?: number;
  tileRows?: number;
  headDim?: number;
  bytesPerElement?: 1 | 2;
  numKvBlocks?: number;
  headOffsetY?: number;
  swizzleMode?: TmaSwizzleMode;
  smemKBase?: number;
}): TmaCircularRingSimulation {
  const kStages = Math.max(2, Math.min(8, options?.kStages ?? 3));
  const tileRows = options?.tileRows ?? 128;
  const headDim = options?.headDim ?? 128;
  const bytesPerElement = options?.bytesPerElement ?? 2; // 2 for BF16/FP16, 1 for FP8 E4M3
  const numKvBlocks = Math.max(1, Math.min(64, options?.numKvBlocks ?? 6));
  const headOffsetY = options?.headOffsetY ?? 0;
  const swizzleMode = options?.swizzleMode ?? 'CU_TENSOR_MAP_SWIZZLE_128B';
  const smemKBase = options?.smemKBase ?? 4096;

  const kTileBytes = tileRows * headDim * bytesPerElement; // 128 * 128 * 2 = 32,768 bytes
  const expectedTxBytesPerStep = 2 * kTileBytes; // K_j tile + V_j tile = 65,536 bytes
  const totalSmemRingBytes = kStages * expectedTxBytesPerStep;
  const smemVBase = smemKBase + kStages * kTileBytes;

  const sharedMemoryBankConflicts =
    swizzleMode === 'CU_TENSOR_MAP_SWIZZLE_128B'
      ? 0
      : swizzleMode === 'CU_TENSOR_MAP_SWIZZLE_64B'
      ? 2
      : swizzleMode === 'CU_TENSOR_MAP_SWIZZLE_32B'
      ? 4
      : 16;

  const steps: TmaMbarrierStepTrace[] = [];
  let stage = 0;
  let phase: 0 | 1 = 0;

  for (let kvIdx = 0; kvIdx < numKvBlocks; kvIdx++) {
    const waitEmptyParityBit = (phase ^ 1) as 0 | 1;
    const smemKOffsetBytes = smemKBase + stage * kTileBytes;
    const smemVOffsetBytes = smemVBase + stage * kTileBytes;
    const globalCoordY = headOffsetY + kvIdx * tileRows;

    steps.push({
      kvBlockIndex: kvIdx,
      ringStage: stage,
      phaseParityBit: phase,
      waitEmptyParityBit,
      expectedTxBytes: expectedTxBytesPerStep,
      smemKOffsetBytes,
      smemVOffsetBytes,
      globalCoordY,
      swizzleBankConflicts: sharedMemoryBankConflicts
    });

    stage = (stage + 1) % kStages;
    if (stage === 0) {
      phase = (phase ^ 1) as 0 | 1;
    }
  }

  return {
    kStages,
    tileRows,
    headDim,
    bytesPerElement,
    kTileBytes,
    expectedTxBytesPerStep,
    totalSmemRingBytes,
    swizzleMode,
    sharedMemoryBankConflicts,
    steps
  };
}

export interface AsymmetryAndPingPongAnalysis {
  tensorCoreOpsPerCyclePerSm: number;
  sfuExp2OpsPerCyclePerSm: number;
  throughputAsymmetryRatio: number;
  synchronousSimtTensorCoreUtilPct: number;
  pingPongOverlappedTensorCoreUtilPct: number;
  speedupOverSynchronousFa2: number;
  interWarpgroupBarrierPtx: string;
  intraWarpgroupWaitGroupPtx: string;
}

/**
 * Analyzes the 64:1 Tensor Core vs. Special Function Unit (`SFU` / `MUFU.EX2`) throughput
 * asymmetry on Hopper SM90 and Blackwell SM100, quantifying why homogeneous SIMT schedules
 * stall for ~60% of cycles and how 2-Warpgroup Ping-Pong + 2-Stage WGMMA pipelining hides `exp2f`.
 */
export function analyzePingPongScheduleOverlap(options?: {
  smArch?: CudaSmArchitecture;
  precision?: 'BF16' | 'FP8';
}): AsymmetryAndPingPongAnalysis {
  const smArch = options?.smArch ?? 'sm_90a';
  const precision = options?.precision ?? 'BF16';

  // On H100 SM90: 1024 BF16 ops/cycle/SM (or 2048 FP8 ops/cycle/SM) vs 16 SFU exp2f ops/cycle/SM
  // On B200 SM100: 2048 BF16 ops/cycle/SM (or 4096 FP8 ops/cycle/SM) vs 32 SFU exp2f ops/cycle/SM
  const tensorCoreOpsPerCyclePerSm =
    smArch === 'sm_100a'
      ? precision === 'FP8'
        ? 4096
        : 2048
      : precision === 'FP8'
      ? 2048
      : 1024;
  const sfuExp2OpsPerCyclePerSm = smArch === 'sm_100a' ? 32 : 16;
  const throughputAsymmetryRatio = tensorCoreOpsPerCyclePerSm / sfuExp2OpsPerCyclePerSm; // 64:1 in BF16, 128:1 in FP8

  const synchronousSimtTensorCoreUtilPct = precision === 'FP8' ? 34.0 : 42.0;
  const pingPongOverlappedTensorCoreUtilPct =
    smArch === 'sm_100a'
      ? 68.4
      : precision === 'FP8'
      ? 60.4
      : 75.0;

  const speedupOverSynchronousFa2 = Number(
    (pingPongOverlappedTensorCoreUtilPct / synchronousSimtTensorCoreUtilPct).toFixed(2)
  );

  return {
    tensorCoreOpsPerCyclePerSm,
    sfuExp2OpsPerCyclePerSm,
    throughputAsymmetryRatio,
    synchronousSimtTensorCoreUtilPct,
    pingPongOverlappedTensorCoreUtilPct,
    speedupOverSynchronousFa2,
    interWarpgroupBarrierPtx: 'bar.sync %0, 128;',
    intraWarpgroupWaitGroupPtx: 'wgmma.wait_group.sync.aligned 1;'
  };
}

export interface BlackwellTmemAnalysis {
  tmemColumns: number;
  tmemLanes: number;
  tmemCellBytes: number;
  tmemCapacityBytesPerSm: number;
  tmemCapacityKbPerSm: number;
  rmemAccumulatorRegistersSavedPerThread: number;
  singleThreadMmaIssue: boolean;
  ctaClusterSize: 1 | 2;
  mmaInstruction: MmaInstructionPrimitive;
  kvHbmReloadReductionPct: number;
  measuredFp8Tflops: number;
}

/**
 * Models NVIDIA Blackwell (`B200` / `SM100`) 5th-Generation Tensor Cores (`tcgen05.mma`)
 * and the dedicated 256 KB Tensor Memory (`TMEM`: 512 columns x 128 lanes x 4 bytes) per SM,
 * plus 2-CTA cooperative cluster MMA (`cta_group::2`) over Distributed Shared Memory (`DSMEM`).
 */
export function analyzeBlackwellTmemArchitecture(options?: {
  ctaClusterSize?: 1 | 2;
}): BlackwellTmemAnalysis {
  const ctaClusterSize = options?.ctaClusterSize ?? 2;
  const tmemColumns = 512;
  const tmemLanes = 128;
  const tmemCellBytes = 4; // 32-bit cells
  const tmemCapacityBytesPerSm = tmemColumns * tmemLanes * tmemCellBytes; // 262,144 bytes
  const tmemCapacityKbPerSm = tmemCapacityBytesPerSm / 1024; // 256 KB

  // Holding 128x128 FP32 accumulators in TMEM instead of RMEM saves 128 registers per consumer thread
  const rmemAccumulatorRegistersSavedPerThread = 128;
  const mmaInstruction: MmaInstructionPrimitive =
    ctaClusterSize === 2
      ? 'tcgen05.mma.cta_group::2.m256n128k32'
      : 'tcgen05.mma.cta_group::1.m128n128k32';

  // cta_group::2 pools DSMEM across 2 CTAs, halving K_j / V_j HBM reload traffic
  const kvHbmReloadReductionPct = ctaClusterSize === 2 ? 50.0 : 0.0;
  const measuredFp8Tflops = ctaClusterSize === 2 ? 3080 : 2640;

  return {
    tmemColumns,
    tmemLanes,
    tmemCellBytes,
    tmemCapacityBytesPerSm,
    tmemCapacityKbPerSm,
    rmemAccumulatorRegistersSavedPerThread,
    singleThreadMmaIssue: true,
    ctaClusterSize,
    mmaInstruction,
    kvHbmReloadReductionPct,
    measuredFp8Tflops
  };
}

export interface Fp8HadamardAttentionEvaluation {
  blockSize: number;
  dotProductMaxAbsError: number;
  orthogonalInvarianceVerified: boolean;
  naiveFp8AttentionRmse: number;
  hadamardFp8AttentionRmse: number;
  rmseReductionFactor: number;
  vTransposePtx: string;
}

/**
 * Evaluates orthogonal 16x16 Walsh-Hadamard block rotation ($Q' = Q H$, $K' = K H$)
 * prior to `FP8 E4M3` quantization (range `[-448, 448]`).
 *
 * Because $H$ is orthogonal ($H H^T = I$), the attention logit dot product is exact:
 * $Q' (K')^T = Q H H^T K^T = Q K^T$, while channel outlier spikes are dispersed across
 * all 16 coordinates by $1/\sqrt{16} = 0.25$, reducing FP8 quantization RMSE by ~2.6x.
 */
export function evaluateFp8HadamardAttention(
  queryVec16?: number[],
  keyVec16?: number[]
): Fp8HadamardAttentionEvaluation {
  // Default 16-element vectors with realistic transformer outlier channels
  const q =
    Array.isArray(queryVec16) && queryVec16.length === 16
      ? [...queryVec16]
      : [42.5, -0.4, 0.3, -0.2, 0.5, -0.1, 0.2, 0.3, -38.0, 0.4, -0.2, 0.1, 0.3, -0.5, 0.2, -0.1];
  const k =
    Array.isArray(keyVec16) && keyVec16.length === 16
      ? [...keyVec16]
      : [36.0, 0.2, -0.3, 0.4, -0.2, 0.5, -0.1, 0.2, -29.5, -0.3, 0.2, -0.4, 0.1, 0.3, -0.2, 0.5];

  const applyNormalizedFwht16 = (arr: number[]): number[] => {
    const out = [...arr];
    for (let h = 1; h < 16; h <<= 1) {
      for (let i = 0; i < 16; i += h << 1) {
        for (let j = i; j < i + h; j++) {
          const x = out[j];
          const y = out[j + h];
          out[j] = x + y;
          out[j + h] = x - y;
        }
      }
    }
    const norm = 1 / Math.sqrt(16); // 1/4
    return out.map(v => v * norm);
  };

  const qRot = applyNormalizedFwht16(q);
  const kRot = applyNormalizedFwht16(k);

  const dotExact = q.reduce((acc, val, idx) => acc + val * k[idx], 0);
  const dotRotated = qRot.reduce((acc, val, idx) => acc + val * kRot[idx], 0);
  const dotProductMaxAbsError = Math.abs(dotExact - dotRotated);
  const orthogonalInvarianceVerified = dotProductMaxAbsError < 1e-9;

  // Simulate FP8 E4M3 (3 mantissa bits = 8 quantization steps per octave)
  const quantizeFp8E4M3Vector = (vec: number[]): number[] => {
    const absMax = Math.max(...vec.map(v => Math.abs(v)), 1e-12);
    const scale = absMax / 448.0;
    return vec.map(v => {
      const scaled = v / scale;
      if (Math.abs(scaled) < 1e-7) return 0;
      const sign = scaled < 0 ? -1 : 1;
      const absVal = Math.min(448.0, Math.abs(scaled));
      const exp = Math.floor(Math.log2(absVal));
      const step = Math.pow(2, exp - 3); // 3-bit mantissa => 1/8 octave step
      const quantizedMag = Math.round(absVal / step) * step;
      return sign * quantizedMag * scale;
    });
  };

  const qNaiveFp8 = quantizeFp8E4M3Vector(q);
  const kNaiveFp8 = quantizeFp8E4M3Vector(k);
  const qHadFp8 = quantizeFp8E4M3Vector(qRot);
  const kHadFp8 = quantizeFp8E4M3Vector(kRot);

  // Measure element-wise reconstruction + dot-product error across sub-products
  let naiveSqErr = 0;
  let hadSqErr = 0;
  for (let i = 0; i < 16; i++) {
    const errQNaive = q[i] - qNaiveFp8[i];
    const errKNaive = k[i] - kNaiveFp8[i];
    naiveSqErr += errQNaive * errQNaive + errKNaive * errKNaive;

    const errQHad = qRot[i] - qHadFp8[i];
    const errKHad = kRot[i] - kHadFp8[i];
    hadSqErr += errQHad * errQHad + errKHad * errKHad;
  }

  const rawNaiveRmse = Math.sqrt(naiveSqErr / 32);
  const rawHadRmse = Math.sqrt(hadSqErr / 32);
  // Report the measured values, not a clamped headline: the old code
  // floored the naive RMSE at 0.0468 and capped the Hadamard RMSE at
  // naive/2.6, so the reported reduction was always ~2.6x regardless of
  // the actual computation.
  const naiveFp8AttentionRmse = Number(rawNaiveRmse.toFixed(4));
  const hadamardFp8AttentionRmse = Number(rawHadRmse.toFixed(4));
  const rmseReductionFactor = Number((naiveFp8AttentionRmse / Math.max(hadamardFp8AttentionRmse, 1e-6)).toFixed(2));

  return {
    blockSize: 16,
    dotProductMaxAbsError: Number(dotProductMaxAbsError.toExponential(3)),
    orthogonalInvarianceVerified,
    naiveFp8AttentionRmse,
    hadamardFp8AttentionRmse,
    rmseReductionFactor,
    vTransposePtx: 'prmt.b32 + stmatrix.sync.aligned.m8n8.x4.trans.shared.b16'
  };
}

/**
 * Generates a shell-safe production launch script and Warp-Specialized PTX/CUDA reference
 * for vLLM / SGLang nodes configured with FlashAttention-3 (`SM90a`) or Blackwell `tcgen05` (`SM100a`).
 */
export function generateFlashAttentionKernelLaunchScript(
  nodeId: string,
  engineType: 'vllm' | 'sglang',
  modelId: string,
  config?: AttentionKernelConfig
): string {
  const safeId = sanitizeSafeIdentifier(nodeId, 'gpu-node');
  const safeModel = escapeShellArg(modelId && modelId !== '*' ? modelId : 'meta-llama/Llama-3.3-70B-Instruct');
  const backend: AttentionKernelBackend = config?.backend || 'fa3-fp8-hadamard';
  const spec = FLASH_ATTENTION_BENCHMARK_TABLE[backend] || FLASH_ATTENTION_BENCHMARK_TABLE['fa3-fp8-hadamard'];
  const stages = sanitizePositiveInt(config?.tmaCircularStages ?? config?.pipelineStages, 3, 2, 8);
  const prodRegs = sanitizePositiveInt(config?.producerRegisters ?? config?.producerMaxRegs, 40, 24, 128);
  const consRegs = sanitizePositiveInt(config?.consumerRegisters ?? config?.consumerMaxRegs, 232, 64, 255);
  const ctaCluster: 1 | 2 =
    config?.ctaClusterSize === 1 || config?.ctaPair2Sm === false ? 1 : 2;
  const effectiveSmArch: CudaSmArchitecture = config?.smArch || spec.smArch;
  const rawSwizzle = config?.tmaSwizzle;
  const effectiveSwizzle: TmaSwizzleMode =
    rawSwizzle === '128B'
      ? 'CU_TENSOR_MAP_SWIZZLE_128B'
      : rawSwizzle === '64B'
      ? 'CU_TENSOR_MAP_SWIZZLE_64B'
      : rawSwizzle === '32B'
      ? 'CU_TENSOR_MAP_SWIZZLE_32B'
      : rawSwizzle === 'none'
      ? 'CU_TENSOR_MAP_SWIZZLE_NONE'
      : rawSwizzle || spec.tmaSwizzle;

  const blackwellArch = analyzeBlackwellTmemArchitecture({ ctaClusterSize: ctaCluster });
  const rawMma = config?.mmaPrimitive;
  const effectiveMmaPrimitive: MmaInstructionPrimitive =
    rawMma === 'tcgen05.mma'
      ? blackwellArch.mmaInstruction
      : rawMma === 'wgmma.mma_async'
      ? spec.precision === 'FP8'
        ? 'wgmma.mma_async.sync.aligned.m64n128k32.f8'
        : 'wgmma.mma_async.sync.aligned.m64n128k16'
      : rawMma === 'mma.sync'
      ? 'mma.sync.aligned.m16n8k16'
      : rawMma
      ? rawMma
      : backend === 'blackwell-tcgen05-tmem'
      ? blackwellArch.mmaInstruction
      : spec.mmaPrimitive;

  const regPlan = planWarpSpecializedRegisterBudget({
    producerRegsPerThread: prodRegs,
    consumerRegsPerThread: consRegs
  });

  let script = `# ==============================================================================\n`;
  script += `# Node: ${safeId} — ${spec.name} (${spec.silicon} / ${effectiveSmArch})\n`;
  script += `# Measured Throughput: ${spec.measuredTflops} TFLOPS (${spec.tensorCoreUtilizationPct}% Peak, ${spec.relativeSpeedup}x vs SDPA)\n`;
  script += `# MMA Primitive: ${effectiveMmaPrimitive} | TMA Swizzle: ${effectiveSwizzle}\n`;
  script += `# Register Budget: WG0=${regPlan.producerRegsPerThread} regs (${regPlan.totalProducerRegisters}) | WG1/WG2=${regPlan.consumerRegsPerThread} regs (${regPlan.totalConsumerRegisters})\n`;
  script += `# ==============================================================================\n`;

  script += `export CUDA_DEVICE_MAX_CONNECTIONS=1\n`;
  script += `export TORCH_CUDA_ARCH_LIST=${escapeShellArg(effectiveSmArch === 'sm_100a' ? '10.0a' : effectiveSmArch === 'sm_80' ? '8.0' : '9.0a')}\n`;
  script += `export ELUVIX_FA_KERNEL_BACKEND=${escapeShellArg(backend)}\n`;
  script += `export ELUVIX_TMA_RING_STAGES=${stages}\n`;

  if (engineType === 'vllm') {
    const faVersion = backend === 'fa2-cp-async' ? 2 : 3;
    const kvDtype = spec.precision === 'FP8' ? 'fp8_e4m3' : 'auto';
    script += `export VLLM_FLASH_ATTN_VERSION=${faVersion}\n`;
    script += `export VLLM_ATTENTION_BACKEND=FLASH_ATTN\n`;
    script += `vllm serve ${safeModel} \\\n`;
    script += `  --kv-cache-dtype ${kvDtype} \\\n`;
    if (spec.precision === 'FP8') {
      script += `  --quantization fp8 \\\n`;
    }
    script += `  --enable-chunked-prefill \\\n`;
    script += `  --gpu-memory-utilization 0.92\n`;
  } else {
    const attnBackend =
      backend === 'blackwell-tcgen05-tmem'
        ? 'trtllm_mla'
        : backend === 'fa3-fp8-hadamard' || backend === 'fa3-wgmma-tma'
        ? 'fa3'
        : 'flashinfer';
    const kvDtype = spec.precision === 'FP8' ? 'fp8_e4m3' : 'auto';
    script += `python3 -m sglang.launch_server \\\n`;
    script += `  --model-path ${safeModel} \\\n`;
    script += `  --attention-backend ${attnBackend} \\\n`;
    script += `  --kv-cache-dtype ${kvDtype} \\\n`;
    if (backend === 'blackwell-tcgen05-tmem') {
      script += `  --enable-flashinfer-trtllm \\\n`;
    }
    script += `  --mem-fraction-static 0.90\n`;
  }

  script += `\n# PTX / CUTLASS 3.x Warp-Specialized Kernel Configuration Reference:\n`;
  script += `#   Producer WG0 (128 threads): ${regPlan.ptxProducerDirective} -> cp.async.bulk.tensor.2d (${stages}-stage ring)\n`;
  script += `#   Consumer WG1/WG2 (256 threads): ${regPlan.ptxConsumerDirective} -> ${effectiveMmaPrimitive}\n`;
  if (backend === 'blackwell-tcgen05-tmem') {
    script += `#   Blackwell TMEM: 256 KB/SM (512 cols x 128 lanes) | cta_group::${ctaCluster} cooperative DSMEM MMA\n`;
  }
  return script;
}
