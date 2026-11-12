import type { UpstreamConfig } from '../index.js';
import type { AttentionKernelBackend } from '../flash-attention-kernels.js';

/**
 * Resolves the effective attention kernel backend for an upstream from either
 * `upstream.attentionKernel` or `upstream.capabilities`.
 */
export function resolveEffectiveAttentionBackend(
  upstream: UpstreamConfig
): AttentionKernelBackend | null {
  if (!upstream) return null;
  const ak = upstream.attentionKernel;
  if (ak && ak.enabled !== false && ak.backend) {
    return ak.backend;
  }
  const caps = upstream.capabilities || [];
  if (caps.includes('blackwell-tmem') || ak?.blackwellTmem || ak?.blackwellTmemEnabled) {
    return 'blackwell-tcgen05-tmem';
  }
  if (
    caps.includes('fp8-hadamard') ||
    ak?.fp8HadamardSmoothing ||
    ak?.fp8HadamardIncoherent ||
    ak?.fp8BlockHad
  ) {
    return 'fa3-fp8-hadamard';
  }
  if (caps.includes('fa3-warp-specialized') || (ak && ak.enabled !== false && ak.warpSpecialized === true)) {
    return 'fa3-wgmma-tma';
  }
  return null;
}

/**
 * Evaluates whether an upstream is equipped with a Warp-Specialized FlashAttention-3
 * (`WGMMA` + `TMA` + `mbarrier` Ping-Pong) or Blackwell `tcgen05.mma` + `256 KB TMEM` kernel.
 */
export function isWarpSpecializedAttentionUpstream(upstream: UpstreamConfig): boolean {
  const b = resolveEffectiveAttentionBackend(upstream);
  return (
    b === 'fa3-wgmma-tma' ||
    b === 'fa3-fp8-hadamard' ||
    b === 'blackwell-tcgen05-tmem'
  );
}

/**
 * Evaluates whether an upstream supports FP8 Ping-Pong scheduling with Walsh-Hadamard
 * incoherent processing (`fa3-fp8-hadamard`) or Blackwell `tcgen05.mma` + `256 KB TMEM`.
 */
export function isFp8PingPongAttentionUpstream(upstream: UpstreamConfig): boolean {
  if (!upstream || isLegacySynchronousAttentionUpstream(upstream)) return false;
  const ak = upstream.attentionKernel;
  if (ak && ak.enabled !== false && ak.pingPongSchedule === false) return false;
  const b = resolveEffectiveAttentionBackend(upstream);
  if (b === 'blackwell-tcgen05-tmem' || b === 'fa3-fp8-hadamard') return true;
  const caps = upstream.capabilities || [];
  if (caps.includes('blackwell-tmem') || caps.includes('fp8-hadamard')) return true;
  if (
    ak &&
    ak.enabled !== false &&
    ak.pingPongSchedule !== false &&
    (ak.fp8HadamardSmoothing || ak.fp8HadamardIncoherent || ak.fp8BlockHad)
  ) {
    return true;
  }
  return false;
}

/**
 * Evaluates whether an upstream is explicitly configured with a legacy synchronous
 * attention kernel (`pytorch-sdpa` or `fa2-cp-async`) that suffers from the 64:1 SFU softmax stall.
 */
export function isLegacySynchronousAttentionUpstream(upstream: UpstreamConfig): boolean {
  if (!upstream) return false;
  const ak = upstream.attentionKernel;
  if (!ak || ak.enabled === false) return false;
  return ak.backend === 'pytorch-sdpa' || ak.backend === 'fa2-cp-async' || ak.warpSpecialized === false;
}

/**
 * Evaluates whether an upstream is equipped with Neuro-Symbolic CRS verification
 * (Backward Program Slicing, SymCC/Z3 Concolic Verification, or ASan Shadow Triage).
 */
export function isNeuroSymbolicCrsUpstream(upstream: UpstreamConfig): boolean {
  if (!upstream) return false;
  if (upstream.capabilities?.includes('neuro-symbolic-crs')) return true;
  const c = upstream.crs;
  if (!c || c.enabled === false) return false;
  return true;
}

/**
 * Evaluates whether an upstream is deployed on a collision-free Rail-Optimized
 * Leaf-Spine Clos fabric (NCCL PxN, SRv6 uSID deterministic spine pinning, or
 * Switch DLB packet spraying with ConnectX-7/8 OOO-DDP).
 */
export function isCollisionFreeRailFabricUpstream(upstream: UpstreamConfig): boolean {
  if (!upstream) return false;
  if (upstream.capabilities?.includes('rail-srv6-dlb')) return true;
  const f = upstream.fabric;
  if (!f || f.enabled === false) return false;
  return (
    f.topology === 'rail-dlb-oooddp' ||
    f.topology === 'rail-srv6-usid' ||
    (f.topology === 'rail-pxn-ecmp' && f.ncclPxn !== false)
  );
}

/**
 * Evaluates whether an upstream is deployed on a legacy Top-of-Rack (ToR) static
 * 5-tuple ECMP fabric subject to 99.76% spine hash collision probability and PFC pause storms.
 */
export function isLegacyEcmpFabricUpstream(upstream: UpstreamConfig): boolean {
  if (!upstream) return false;
  const f = upstream.fabric;
  if (!f || f.enabled === false) return false;
  return f.topology === 'tor-static-ecmp';
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
 * (INT4-AWQ, INT4-GPTQ, or unrotated MXFP4/NVFP4 without Walsh-Hadamard outlier smoothing).
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
