'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';

interface GpuInfo {
  vendor: string;
  model: string;
  count: number;
  vramTotalGb: number;
  vramFreeGb: number;
  temperatureC?: number;
  utilPercent?: number;
}

interface ProviderStatus {
  status: 'OFFLINE' | 'INITIALIZING' | 'ONLINE' | 'SERVING' | 'PAUSED' | 'ERROR';
  nodeId?: string;
  reputationScore: number;
  totalJobsCompleted: number;
  totalTokensServed: number;
  totalEarnedUsd: number;
  gpu?: GpuInfo;
  models?: string[];
  lastHeartbeatAt?: string;
  errorMessage?: string;
  rdma?: {
    available?: boolean;
    supported?: boolean;
    driverLoaded?: boolean;
    nvidiaPeermemLoaded?: boolean;
    ibDevices?: string[];
    hasLosslessRoce: boolean;
    pciP2pSupported?: boolean;
    tuningChecklist: {
      item?: string;
      title?: string;
      status: 'pass' | 'warn' | 'fail' | 'action_needed';
      detail?: string;
      description?: string;
      remediation?: string;
      command?: string;
    }[];
  };
  confidential?: {
    supported: boolean;
    cpuTeeType: string;
    sevGuestDevicePresent: boolean;
    tdxGuestDevicePresent: boolean;
    hostSevSnpEnabled: boolean;
    gpuCcMode: 'CC-On' | 'PPCIE' | 'TEE-I/O' | 'Off';
    gpuReadyState: boolean;
    swiotlbBounceActive: boolean;
    attestationChecklist: {
      title: string;
      description: string;
      command: string;
      status: 'pass' | 'warn' | 'action_needed';
    }[];
  };
}

interface JobLog {
  id: number;
  job_id: string;
  timestamp: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  earned_usd: number;
  status: string;
  error_message?: string;
}

export default function ProviderPage() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [recentJobs, setRecentJobs] = useState<JobLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Form states
  const [serverUrl, setServerUrl] = useState('https://api.billama.dev');
  const [nodeToken, setNodeToken] = useState('');
  const [nodeName, setNodeName] = useState('');
  const [engineUrl, setEngineUrl] = useState('http://localhost:11434');
  const [engineType, setEngineType] = useState('ollama');
  const [pricingMode, setPricingMode] = useState('market');
  const [floorPriceIn, setFloorPriceIn] = useState(0.25);
  const [floorPriceOut, setFloorPriceOut] = useState(0.50);
  const [pauseOnUserActive, setPauseOnUserActive] = useState(true);
  const [maxGpuTempC, setMaxGpuTempC] = useState(82);

  // RDMA & Roofline Simulator state
  const [simModel, setSimModel] = useState<'llama-3.3-70b' | 'deepseek-v3' | 'llama-3.1-8b' | 'qwen-2.5-72b'>('llama-3.3-70b');
  const [simPrecision, setSimPrecision] = useState<'fp8' | 'bf16'>('fp8');
  const [simBandwidthGbps, setSimBandwidthGbps] = useState<100 | 200 | 400 | 800>(400);
  const [simTokens, setSimTokens] = useState<number>(4096);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  // Confidential Computing Enclave Lab state
  const [enclaveArch, setEnclaveArch] = useState<
    'sev-snp-h100-cc' | 'tdx-b200-tee-io' | 'sev-es-passthrough' | 'standard-kvm'
  >('sev-snp-h100-cc');
  const [enclaveWeightGb, setEnclaveWeightGb] = useState<8 | 40 | 70 | 140>(70);
  const [enclaveAttacks, setEnclaveAttacks] = useState<string[]>([
    'host_dram_dump',
    'npt_aliasing',
    'wesee_vc_spoof',
    'pcie_bar1_snoop'
  ]);

  const toggleEnclaveAttack = (attackId: string) => {
    setEnclaveAttacks((prev) =>
      prev.includes(attackId) ? prev.filter((a) => a !== attackId) : [...prev, attackId]
    );
  };

  // Sub-4-Bit Microscaling (MXFP4 / Blackwell NVFP4) & Walsh-Hadamard Outlier Lab state
  const [fp4ModelParamsB, setFp4ModelParamsB] = useState<70 | 405 | 671>(70);
  const [fp4OutlierSpike, setFp4OutlierSpike] = useState<40 | 80 | 120>(120);
  const [fp4EnableHadamard, setFp4EnableHadamard] = useState<boolean>(true);
  const [fp4SvdRank, setFp4SvdRank] = useState<0 | 16>(16);

  const fp4SimResult = useMemo(() => {
    const hiddenDim = fp4ModelParamsB === 405 ? 16384 : fp4ModelParamsB === 671 ? 7168 : 8192;
    const dampingFactor = Number(Math.sqrt(hiddenDim).toFixed(1));
    const rotatedMax = Number((fp4OutlierSpike / Math.sqrt(256) + 0.35).toFixed(2));
    const scale = fp4ModelParamsB / 70.0;
    const svdOverheadGb = fp4SvdRank > 0 ? Number((0.8 * scale).toFixed(1)) : 0;
    const spikePenalty = (fp4OutlierSpike - 40) / 80;

    const rows = [
      {
        id: 'bf16',
        name: 'BF16 (Baseline)',
        bits: '16.00 b',
        weightGb: Number((140.0 * scale).toFixed(1)),
        mmluPro: '68.9%',
        math500: '76.4%',
        liveCode: '54.2%',
        speedup: '1.00x',
        ptx: 'wgmma.mma_async (BF16)',
        status: 'baseline'
      },
      {
        id: 'fp8_e4m3',
        name: 'FP8 (W8A8 E4M3)',
        bits: '8.00 b',
        weightGb: Number((70.0 * scale).toFixed(1)),
        mmluPro: '68.7%',
        math500: '76.1%',
        liveCode: '54.0%',
        speedup: '1.85x',
        ptx: 'wgmma.mma_async (E4M3)',
        status: 'good'
      },
      {
        id: 'int4_awq',
        name: 'Weight-Only INT4-AWQ (W4A16)',
        bits: '4.125 b',
        weightGb: Number((36.2 * scale).toFixed(1)),
        mmluPro: `${(67.1 - spikePenalty * 0.4).toFixed(1)}%`,
        math500: `${(71.2 - spikePenalty * 1.1).toFixed(1)}% (-5.2%)`,
        liveCode: `${(50.8 - spikePenalty * 0.8).toFixed(1)}%`,
        speedup: '2.10x (BW Only)',
        ptx: 'Dequant -> FP16 Tensor Core',
        status: 'degraded'
      },
      {
        id: 'mxfp4',
        name: fp4EnableHadamard ? 'OCP MXFP4 + Hadamard (32-el E8M0)' : 'Naive OCP MXFP4 (No Rotation)',
        bits: '4.25 b',
        weightGb: Number((37.2 * scale + svdOverheadGb).toFixed(1)),
        mmluPro: fp4EnableHadamard ? '67.9%' : `${(66.4 - spikePenalty * 0.6).toFixed(1)}%`,
        math500: fp4EnableHadamard ? '74.3%' : `${(68.9 - spikePenalty * 1.5).toFixed(1)}% (-7.5%)`,
        liveCode: fp4EnableHadamard ? '52.6%' : `${(49.1 - spikePenalty * 1.1).toFixed(1)}%`,
        speedup: '3.35x',
        ptx: 'tcgen05.mma.kind::mxf4',
        status: fp4EnableHadamard ? 'good' : 'degraded'
      },
      {
        id: 'nvfp4',
        name: fp4EnableHadamard
          ? `NVIDIA NVFP4 + Hadamard${fp4SvdRank ? ' + SVD-16' : ''} (W4A4)`
          : 'NVIDIA NVFP4 (Unrotated 16-el E4M3)',
        bits: '4.50 b',
        weightGb: Number((39.4 * scale + svdOverheadGb).toFixed(1)),
        mmluPro: fp4EnableHadamard ? '68.6%' : '67.5%',
        math500: fp4EnableHadamard ? `${fp4SvdRank ? '76.3%' : '76.1%'} (99.6% Rec)` : '72.4% (-4.0%)',
        liveCode: fp4EnableHadamard ? (fp4SvdRank ? '54.0%' : '53.9%') : '51.5%',
        speedup: '3.42x (Compute + BW)',
        ptx: 'tcgen05.mma.kind::mxf4nvf4 (20 PFLOPS)',
        status: fp4EnableHadamard ? 'optimal' : 'warn'
      }
    ];

    const modelName =
      fp4ModelParamsB === 405
        ? 'meta-llama/Llama-3.1-405B-Instruct'
        : fp4ModelParamsB === 671
        ? 'deepseek-ai/DeepSeek-R1'
        : 'meta-llama/Llama-3.3-70B-Instruct';
    const exportDir = `/models/${modelName.split('/')[1]}-NVFP4-QuaRot`;
    const tpSize = fp4ModelParamsB === 70 ? 1 : 4;
    const modelOptCmd = [
      `python3 -m modelopt.torch.quantization.examples.llm_ptq \\`,
      `  --model "${modelName}" \\`,
      `  --qformat nvfp4 \\`,
      `  --kv_cache_dtype fp8 \\`,
      `  --calib_size 512 \\`,
      `  --auto_quantize_bits 4.5 \\`,
      `  --export_path "${exportDir}"`,
      ``,
      `vllm serve "${exportDir}" \\`,
      `  --quantization modelopt \\`,
      `  --kv-cache-dtype fp8_e4m3 \\`,
      `  --tensor-parallel-size ${tpSize} \\`,
      `  --gpu-memory-utilization 0.92 \\`,
      `  --port 8000`
    ].join('\n');

    return {
      hiddenDim,
      dampingFactor,
      rotatedMax,
      nvfp4WeightGb: Number((39.4 * scale + svdOverheadGb).toFixed(1)),
      bf16WeightGb: Number((140.0 * scale).toFixed(1)),
      tpSize,
      rows,
      modelOptCmd
    };
  }, [fp4ModelParamsB, fp4OutlierSpike, fp4EnableHadamard, fp4SvdRank]);

  const enclaveSimResult = useMemo(() => {
    const profiles = {
      'sev-snp-h100-cc': {
        label: 'AMD SEV-SNP + NVIDIA H100 CC-On',
        cpuTee: 'AMD SEV-SNP (AES-128 XEX + RMP)',
        gpuTee: 'NVIDIA H100 CC-On (SWIOTLB + CE AES-GCM-256)',
        pcieMode: 'SWIOTLB Bounce Buffer + Copy Engine AES-GCM',
        effectiveH2dBandwidthGbps: 8.64,
        singleGpuTokPerSec: 74.1,
        ttft16kMs: 1495,
        allReduceEfficiencyPct: 81.4
      },
      'tdx-b200-tee-io': {
        label: 'Intel TDX + Blackwell B200 TEE-I/O',
        cpuTee: 'Intel TDX (AES-XTS-256 + 28-bit MAC + S-EPT)',
        gpuTee: 'NVIDIA Blackwell B200 TEE-I/O (PCIe IDE + TDISP + Encrypted NVLink 5)',
        pcieMode: 'Hardware PCIe Gen6 IDE Line-Rate TLP Encryption',
        effectiveH2dBandwidthGbps: 24.1,
        singleGpuTokPerSec: 77.5,
        ttft16kMs: 1435,
        allReduceEfficiencyPct: 98.6
      },
      'sev-es-passthrough': {
        label: 'Legacy AMD SEV-ES + Unprotected GPU Passthrough',
        cpuTee: 'AMD SEV-ES (AES-128, No Reverse Map Table)',
        gpuTee: 'Unprotected VFIO GPU Passthrough (BAR1 Open)',
        pcieMode: 'Plaintext PCIe DMA via Shared Unencrypted SWIOTLB',
        effectiveH2dBandwidthGbps: 26.8,
        singleGpuTokPerSec: 78.0,
        ttft16kMs: 1425,
        allReduceEfficiencyPct: 99.5
      },
      'standard-kvm': {
        label: 'Standard Unencrypted KVM Host',
        cpuTee: 'None (Plaintext DDR5 & VMCB)',
        gpuTee: 'Standard GPU (CC-Off)',
        pcieMode: 'Direct Pinned DMA (Plaintext)',
        effectiveH2dBandwidthGbps: 28.0,
        singleGpuTokPerSec: 78.4,
        ttft16kMs: 1420,
        allReduceEfficiencyPct: 100.0
      }
    } as const;

    const p = profiles[enclaveArch];
    const baselineTokPerSec = 78.4;
    const coldLoadTimeSec = Number((enclaveWeightGb / p.effectiveH2dBandwidthGbps).toFixed(1));
    const singleGpuOverheadPct = Number(
      (((p.singleGpuTokPerSec - baselineTokPerSec) / baselineTokPerSec) * 100).toFixed(1)
    );

    const attackDefs = [
      {
        id: 'host_dram_dump',
        title: 'Host Root DRAM Cold-Boot / /dev/mem Dump',
        Evaluate: () => {
          if (enclaveArch === 'standard-kvm') {
            return {
              blocked: false,
              mechanism: 'Plaintext DDR5',
              detail: 'EXPOSED: Host root dumps plaintext model weights and KV-cache directly from /dev/mem.'
            };
          }
          return {
            blocked: true,
            mechanism:
              enclaveArch === 'tdx-b200-tee-io'
                ? 'Per-TD Ephemeral AES-XTS-256 + 28-bit SHA-3 MAC'
                : 'Per-VM ASID Ephemeral AES-128 XEX Engine',
            detail:
              'MITIGATED: Host reads only ciphertext randomized with physical-address tweak.'
          };
        }
      },
      {
        id: 'npt_aliasing',
        title: 'Hypervisor NPT / EPT Page Remapping & Aliasing',
        Evaluate: () => {
          if (enclaveArch === 'sev-snp-h100-cc') {
            return {
              blocked: true,
              mechanism: 'Reverse Map Table (RMP) + PVALIDATE',
              detail:
                'MITIGATED: Hardware MMU checks RMP (SPA -> ASID, GPA) on every memory access and raises #PF on remapped pages.'
            };
          }
          if (enclaveArch === 'tdx-b200-tee-io') {
            return {
              blocked: true,
              mechanism: 'SEAM Secure EPT (S-EPT) + TDG.MEM.PAGE.ACCEPT',
              detail:
                'MITIGATED: S-EPT lives inside CPU-protected SEAM range; hypervisor cannot alias guest pages.'
            };
          }
          return {
            blocked: false,
            mechanism: 'Unchecked Nested Page Tables (NPT)',
            detail:
              'COMPROMISED: Without RMP/S-EPT, hypervisor remaps two GPAs to one SPA to corrupt control flow and leak ciphertexts.'
          };
        }
      },
      {
        id: 'wesee_vc_spoof',
        title: 'WeSee / Ahoi Fake #VC / #VE Interrupt Spoofing',
        Evaluate: () => {
          if (enclaveArch === 'sev-snp-h100-cc') {
            return {
              blocked: true,
              mechanism: 'Restricted Injection (#HV Doorbell, Vector 28)',
              detail:
                'MITIGATED: Hypervisor is forbidden from injecting #VC (vector 29); fake CPUID/MMIO returns cannot coerce guest register disclosure.'
            };
          }
          if (enclaveArch === 'tdx-b200-tee-io') {
            return {
              blocked: true,
              mechanism: 'SEPT_VE_DISABLE + TDX Module Filtering',
              detail:
                'MITIGATED: Unsolicited #VE virtualization exceptions from host VMM are rejected by CPU.'
            };
          }
          return {
            blocked: false,
            mechanism: 'Unauthenticated Exception Injection',
            detail:
              'COMPROMISED: Hypervisor injects forged #VC (vector 29), tricking guest handler into copying registers into shared GHCB.'
          };
        }
      },
      {
        id: 'pcie_bar1_snoop',
        title: 'PCIe Bus Interposer & BAR1 VRAM Mapping Snoop',
        Evaluate: () => {
          if (enclaveArch === 'sev-snp-h100-cc') {
            return {
              blocked: true,
              mechanism: 'GSP MMU BAR1 Firewall + CE AES-GCM-256 DMA',
              detail:
                'MITIGATED: H100 GSP blocks host BAR0/BAR1 MMIO reads and encrypts all PCIe DMA with 96-bit IV + 128-bit GMAC.'
            };
          }
          if (enclaveArch === 'tdx-b200-tee-io') {
            return {
              blocked: true,
              mechanism: 'PCIe Gen6 IDE + TDISP Hardware Link Encryption',
              detail:
                'MITIGATED: Root port and GPU encrypt PCIe TLPs inline at wire speed; physical bus interposer sees only AES-GCM.'
            };
          }
          return {
            blocked: false,
            mechanism: 'Plaintext PCIe TLPs & Host BAR1 Aperture',
            detail:
              'COMPROMISED: Prompts cross shared SWIOTLB in plaintext and host root maps GPU BAR1 to read HBM3 KV-cache directly.'
          };
        }
      },
      {
        id: 'rim_firmware_tamper',
        title: 'Tampered GPU VBIOS / GSP Firmware Injection',
        Evaluate: () => {
          if (enclaveArch === 'sev-snp-h100-cc' || enclaveArch === 'tdx-b200-tee-io') {
            return {
              blocked: true,
              mechanism: 'DMTF SPDM 1.2 ECDSA P-384 + Golden RIM Verification',
              detail:
                'ATTESTATION BLOCKED: SPDM PCR hash mismatches NVIDIA Golden RIM; GPU stays locked out of Ready State and Trustee KBS denies model DEK.'
            };
          }
          return {
            blocked: false,
            mechanism: 'No SPDM Device Attestation',
            detail:
              'COMPROMISED: Modified GPU firmware executes undetected without SPDM measurement verification.'
          };
        }
      }
    ];

    const evaluatedAttacks = attackDefs
      .filter((d) => enclaveAttacks.includes(d.id))
      .map((d) => {
        const res = d.Evaluate();
        return {
          id: d.id,
          title: d.title,
          ...res
        };
      });

    const anyUnblocked = evaluatedAttacks.some((a) => !a.blocked);
    const rimTampered = enclaveAttacks.includes('rim_firmware_tamper');
    const isFullDualTee =
      enclaveArch === 'sev-snp-h100-cc' || enclaveArch === 'tdx-b200-tee-io';

    const enclavePosture = anyUnblocked
      ? 'COMPROMISED'
      : rimTampered && isFullDualTee
      ? 'ATTESTATION_BLOCKED'
      : isFullDualTee
      ? 'ISOLATED'
      : 'COMPROMISED';

    const kbsKeyRelease = enclavePosture === 'ISOLATED' ? 'GRANTED' : 'DENIED';

    return {
      ...p,
      coldLoadTimeSec,
      singleGpuOverheadPct,
      evaluatedAttacks,
      enclavePosture,
      kbsKeyRelease
    };
  }, [enclaveArch, enclaveWeightGb, enclaveAttacks]);

  const copyToClipboard = (cmd: string) => {
    navigator.clipboard.writeText(cmd);
    setCopiedCmd(cmd);
    setTimeout(() => setCopiedCmd(null), 2500);
  };

  const simResult = useMemo(() => {
    const bytesPerElement = simPrecision === 'fp8' ? 1 : 2;
    let bytesPerToken = 0;
    let layers = 80;
    let activeParamsB = 70;
    let archType = 'GQA (8 kv heads)';

    if (simModel === 'llama-3.3-70b') {
      layers = 80;
      activeParamsB = 70;
      bytesPerToken = 2 * 80 * 8 * 128 * bytesPerElement; // 163,840 bytes for fp8 = 160 KiB
      archType = 'GQA (8 kv heads)';
    } else if (simModel === 'deepseek-v3') {
      layers = 61;
      activeParamsB = 37; // active in MoE
      bytesPerToken = 61 * (512 + 64) * bytesPerElement; // 35,136 bytes for fp8 = 34.3 KiB
      archType = 'MLA (Latent Compression)';
    } else if (simModel === 'llama-3.1-8b') {
      layers = 32;
      activeParamsB = 8;
      bytesPerToken = 2 * 32 * 8 * 128 * bytesPerElement; // 65,536 bytes for fp8 = 64 KiB
      archType = 'GQA (8 kv heads)';
    } else if (simModel === 'qwen-2.5-72b') {
      layers = 80;
      activeParamsB = 72;
      bytesPerToken = 2 * 80 * 8 * 128 * bytesPerElement;
      archType = 'GQA (8 kv heads)';
    }

    const totalBytes = bytesPerToken * simTokens;
    const totalMb = totalBytes / (1024 * 1024);
    const wireBps = (simBandwidthGbps * 1e9) / 8; // B/s in decimal
    const rawWireTimeMs = (totalBytes / wireBps) * 1000;

    // H100 SXM5 FP8 dense roofline: 989.4 TFLOPS, 3.35 TB/s HBM3 -> Ridge: 295.3 FLOPs/B
    const prefillFlops = 2 * activeParamsB * 1e9 * simTokens;
    const effectiveTflops = 989.4 * 0.60 * 1e12; // 60% MFU on H100
    const prefillComputeTimeMs = (prefillFlops / effectiveTflops) * 1000;

    // Layer-pipelined overlap (NIXL / Mooncake RDMA)
    const singleLayerWireTimeMs = rawWireTimeMs / layers;
    const exposedLatencyMs = Number((singleLayerWireTimeMs + 0.005).toFixed(2));
    const overlapPct = Math.min(99.2, Number((((rawWireTimeMs - singleLayerWireTimeMs) / Math.max(1, rawWireTimeMs)) * 100).toFixed(1)));

    return {
      bytesPerTokenKb: (bytesPerToken / 1024).toFixed(1),
      totalMb: totalMb.toFixed(2),
      rawWireTimeMs: rawWireTimeMs.toFixed(1),
      prefillComputeTimeMs: prefillComputeTimeMs.toFixed(1),
      exposedLatencyMs,
      overlapPct,
      archType,
      layers,
      ridgePoint: 295.3,
    };
  }, [simModel, simPrecision, simBandwidthGbps, simTokens]);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/v1/provider/status');
      const data = await res.json();
      if (data.success) {
        setStatus(data.status);
        if (data.settings) {
          setServerUrl(data.settings.server_url || 'https://api.billama.dev');
          setNodeToken(data.settings.node_token || '');
          setNodeName(data.settings.node_name || '');
          setEngineUrl(data.settings.engine_url || 'http://localhost:11434');
          setEngineType(data.settings.engine_type || 'ollama');
          setPricingMode(data.settings.pricing_mode || 'market');
          setFloorPriceIn(data.settings.floor_price_in || 0.25);
          setFloorPriceOut(data.settings.floor_price_out || 0.50);
          setPauseOnUserActive(Boolean(data.settings.pause_on_user_active ?? 1));
          setMaxGpuTempC(data.settings.max_gpu_temp_c || 82);
        }
        if (Array.isArray(data.recentJobs)) {
          setRecentJobs(data.recentJobs);
        }
      }
    } catch (err) {
      console.error('Failed to fetch provider status:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleToggle = async () => {
    setActionLoading(true);
    const newEnabled = status?.status === 'OFFLINE' || status?.status === 'ERROR';
    try {
      const res = await fetch('/api/v1/provider/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newEnabled })
      });
      const data = await res.json();
      if (data.success && data.status) {
        setStatus(data.status);
      }
    } catch (err) {
      console.error('Failed to toggle provider:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionLoading(true);
    setSaveMessage('Saving settings...');
    try {
      const res = await fetch('/api/v1/provider/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverUrl,
          nodeToken,
          nodeName,
          engineUrl,
          engineType,
          pricingMode,
          floorPriceIn,
          floorPriceOut,
          pauseOnUserActive,
          maxGpuTempC
        })
      });
      const data = await res.json();
      if (data.success) {
        setSaveMessage('✓ Configuration saved successfully!');
        if (data.status) setStatus(data.status);
        setTimeout(() => setSaveMessage(null), 3000);
      } else {
        setSaveMessage(`Failed: ${data.error}`);
      }
    } catch (err: any) {
      setSaveMessage(`Error: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRunBenchmark = async () => {
    setBenchmarkLoading(true);
    try {
      const res = await fetch('/api/v1/provider/benchmark', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: status?.models?.[0] || 'llama3.1:8b'
        })
      });
      const data = await res.json();
      if (data.success) {
        alert('✓ Benchmark completed successfully! Output verified and earnings recorded.');
        fetchStatus();
      } else {
        alert(`Benchmark failed: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Benchmark error: ${err.message}`);
    } finally {
      setBenchmarkLoading(false);
    }
  };

  const isOnline = status?.status === 'ONLINE' || status?.status === 'SERVING';
  const isPaused = status?.status === 'PAUSED';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-12 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center pb-6 border-b border-slate-800 gap-4">
          <div>
            <div className="flex items-center gap-3">
              <Link
                href="/"
                className="text-xs font-semibold text-slate-400 hover:text-sky-400 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg transition"
              >
                ← Consumer Router
              </Link>
              <Link
                href="/docs"
                className="text-xs font-semibold text-sky-400 hover:text-sky-300 bg-slate-900 border border-sky-500/30 px-3 py-1.5 rounded-lg transition flex items-center gap-1"
              >
                <span>📖</span> Docs
              </Link>
              <div className="h-4 w-px bg-slate-800" />
              <h1 className="text-2xl font-black text-amber-400 flex items-center gap-2">
                <span>⚡</span> Sell GPU Time with Billama
              </h1>
            </div>
            <p className="text-slate-400 text-xs mt-1">
              Monetize your desktop or workstation GPU during idle periods. Consumer queries are always given instant priority.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleRunBenchmark}
              disabled={benchmarkLoading}
              className="bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs px-3.5 py-2 rounded-lg font-medium transition disabled:opacity-50"
            >
              {benchmarkLoading ? 'Running Test...' : '🧪 Run Local Benchmark'}
            </button>
            <button
              onClick={handleToggle}
              disabled={actionLoading}
              className={`text-xs font-bold px-5 py-2 rounded-lg shadow-lg transition flex items-center gap-2 disabled:opacity-50 ${
                isOnline || isPaused
                  ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-600/20'
                  : 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/20'
              }`}
            >
              <span>{isOnline || isPaused ? '⏹ Stop Sharing' : '▶ Start Sharing GPU'}</span>
            </button>
          </div>
        </header>

        {/* Live Status Hero Banner */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg relative overflow-hidden">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Node Status</div>
            <div className="flex items-center gap-2">
              <span
                className={`w-3 h-3 rounded-full ${
                  loading
                    ? 'bg-slate-500 animate-pulse'
                    : isOnline
                    ? 'bg-emerald-400 animate-pulse'
                    : isPaused
                    ? 'bg-amber-400'
                    : 'bg-slate-600'
                }`}
              />
              <span className="text-lg font-bold text-slate-100">
                {loading ? 'CONNECTING...' : status?.status || 'OFFLINE'}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 mt-2 font-mono truncate">
              ID: {status?.nodeId || 'Unregistered'}
            </div>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Total Earned</div>
            <div className="text-2xl font-black text-emerald-400">
              ${(status?.totalEarnedUsd || 0).toFixed(4)}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              {status?.reputationScore || 100}% Network Reputation
            </div>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Tokens Served</div>
            <div className="text-2xl font-black text-sky-400">
              {(status?.totalTokensServed || 0).toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Across {status?.totalJobsCompleted || 0} completed jobs
            </div>
          </div>

          <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">Detected GPU</div>
            <div className="text-sm font-bold text-slate-200 truncate">
              {status?.gpu?.model || 'Detecting GPU...'}
            </div>
            <div className="text-[11px] text-slate-400 mt-1 flex items-center justify-between">
              <span>{status?.gpu?.vramTotalGb || 0} GB VRAM</span>
              <span>{status?.gpu?.temperatureC || 45}°C</span>
            </div>
          </div>
        </div>

        {/* Priority & Preemption Safeguard Note */}
        <div className="p-4 rounded-xl border border-sky-900/60 bg-sky-950/20 flex items-start gap-3 text-xs text-sky-300">
          <span className="text-base mt-0.5">🛡️</span>
          <div>
            <strong className="text-sky-200">Consumer Zero-Lag Guarantee:</strong> Whenever you send a request via your local Eluvix proxy, provider compute jobs automatically yield and pause immediately. Your local applications, coding harnesses (OpenCode, Cursor), and games retain 100% GPU priority.
          </div>
        </div>

        {/* Configuration & Settings Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Settings Form */}
          <div className="lg:col-span-2 bg-slate-900/70 border border-slate-800 rounded-xl p-6 shadow-xl">
            <h2 className="text-base font-bold text-slate-200 mb-4 flex items-center gap-2">
              <span>⚙️</span> Provider Settings &amp; Safeguards
            </h2>

            <form onSubmit={handleSaveConfig} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Billama Gateway URL</label>
                  <input
                    type="text"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    placeholder="https://api.billama.dev"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:border-amber-400 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Node Token (from Billama dashboard)</label>
                  <input
                    type="password"
                    value={nodeToken}
                    onChange={(e) => setNodeToken(e.target.value)}
                    placeholder="blm_node_... (optional for local/test)"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:border-amber-400 outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Local Inference Engine</label>
                  <select
                    value={engineType}
                    onChange={(e) => setEngineType(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-amber-400 outline-none"
                  >
                    <option value="ollama">Ollama (Default :11434)</option>
                    <option value="vllm">vLLM (:8000)</option>
                    <option value="lemonade">Lemonade Router (:13305)</option>
                    <option value="openai-compatible">Custom OpenAI Compatible</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Engine Endpoint</label>
                  <input
                    type="text"
                    value={engineUrl}
                    onChange={(e) => setEngineUrl(e.target.value)}
                    placeholder="http://localhost:11434"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:border-amber-400 outline-none"
                  />
                </div>
              </div>

              <div className="border-t border-slate-800 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Pricing Strategy</label>
                  <select
                    value={pricingMode}
                    onChange={(e) => setPricingMode(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-amber-400 outline-none"
                  >
                    <option value="market">Market Dynamic (Recommended)</option>
                    <option value="floor">Strict Floor Price</option>
                  </select>
                </div>
                {pricingMode === 'floor' && (
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="block text-slate-400 font-medium mb-1">Floor ($/1M Prompt)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={floorPriceIn}
                        onChange={(e) => setFloorPriceIn(parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:border-amber-400 outline-none"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="block text-slate-400 font-medium mb-1">Floor ($/1M Completion)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={floorPriceOut}
                        onChange={(e) => setFloorPriceOut(parseFloat(e.target.value) || 0)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 font-mono focus:border-amber-400 outline-none"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="border-t border-slate-800 pt-4 space-y-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pauseOnUserActive}
                    onChange={(e) => setPauseOnUserActive(e.target.checked)}
                    className="rounded bg-slate-950 border-slate-700 text-amber-500 focus:ring-0"
                  />
                  <span className="text-slate-200 font-medium">
                    Automatically pause provider when local desktop user queries Eluvix
                  </span>
                </label>

                <div>
                  <div className="flex justify-between text-slate-400 font-medium mb-1">
                    <span>Max GPU Temperature Threshold</span>
                    <span className="text-amber-400 font-mono">{maxGpuTempC}°C</span>
                  </div>
                  <input
                    type="range"
                    min="60"
                    max="90"
                    value={maxGpuTempC}
                    onChange={(e) => setMaxGpuTempC(parseInt(e.target.value, 10))}
                    className="w-full accent-amber-500"
                  />
                  <span className="text-[11px] text-slate-500">
                    If GPU exceeds this temperature, the agent will pause jobs until cooling.
                  </span>
                </div>
              </div>

              {saveMessage && (
                <div className="p-2.5 rounded bg-slate-800 text-sky-300 font-medium text-xs">
                  {saveMessage}
                </div>
              )}

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={actionLoading}
                  className="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold px-4 py-2 rounded-lg transition disabled:opacity-50"
                >
                  Save Settings
                </button>
              </div>
            </form>
          </div>

          {/* Right Column: Models & Payout Info */}
          <div className="space-y-6">
            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-5 shadow-xl space-y-3">
              <h3 className="text-sm font-bold text-slate-200">📦 Discovered Local Models</h3>
              <p className="text-[11px] text-slate-400">
                Models available to serve incoming Billama Grid token traffic:
              </p>
              <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
                {status?.models && status.models.length > 0 ? (
                  status.models.map((m) => (
                    <span
                      key={m}
                      className="text-[10px] bg-slate-950 border border-slate-800 text-slate-300 px-2 py-1 rounded font-mono"
                    >
                      {m}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-slate-500 italic">No models currently loaded</span>
                )}
              </div>
            </div>

            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-5 shadow-xl space-y-3">
              <h3 className="text-sm font-bold text-slate-200">💳 Payout &amp; Settlement</h3>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Earnings accrue automatically in USD. Providers can redeem earned balances for Billama cloud compute credits, or request monthly payouts via Stripe Connect or crypto settlement.
              </p>
              <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 text-xs flex justify-between items-center">
                <span className="text-slate-400">Redemption Status:</span>
                <span className="text-emerald-400 font-bold">Active</span>
              </div>
            </div>
          </div>
        </div>

        {/* RoCEv2 & GPUDirect RDMA Readiness Checklist */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-6 shadow-xl space-y-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center pb-3 border-b border-slate-800 gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-sky-400 uppercase tracking-wider">Hardware Fabric Probe</span>
                <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold border ${
                  status?.rdma?.available
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                    : 'bg-slate-850 text-slate-400 border-slate-700'
                }`}>
                  {status?.rdma?.available ? 'RDMA / RoCEv2 Capable' : 'Standard Host Network (TCP/IP)'}
                </span>
              </div>
              <h2 className="text-base font-bold text-slate-100 mt-1">
                RoCEv2 &amp; GPUDirect RDMA Fabric Readiness
              </h2>
            </div>
            <div className="text-[11px] text-slate-400">
              Mellanox ConnectX / InfiniBand &bull; nvidia-peermem &bull; PFC / ECN
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">Kernel Driver (nvidia-peermem)</span>
              <div className="mt-1 font-mono text-xs font-bold flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${status?.rdma?.driverLoaded ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                <span className={status?.rdma?.driverLoaded ? 'text-emerald-300' : 'text-amber-300'}>
                  {status?.rdma?.driverLoaded ? 'Loaded' : 'Not Detected'}
                </span>
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">InfiniBand / RoCE Devices</span>
              <div className="mt-1 font-mono text-xs font-bold text-slate-200 truncate">
                {status?.rdma?.ibDevices && status.rdma.ibDevices.length > 0
                  ? status.rdma.ibDevices.join(', ')
                  : 'None detected'}
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">Lossless RoCE (PFC / ECN)</span>
              <div className="mt-1 font-mono text-xs font-bold flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${status?.rdma?.hasLosslessRoce ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                <span className={status?.rdma?.hasLosslessRoce ? 'text-emerald-300' : 'text-slate-400'}>
                  {status?.rdma?.hasLosslessRoce ? 'Configured' : 'DSCP Default'}
                </span>
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">PCIe P2P Direct DMA</span>
              <div className="mt-1 font-mono text-xs font-bold flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${status?.rdma?.pciP2pSupported ? 'bg-emerald-400' : 'bg-slate-500'}`} />
                <span className={status?.rdma?.pciP2pSupported ? 'text-emerald-300' : 'text-slate-400'}>
                  {status?.rdma?.pciP2pSupported ? 'Supported' : 'Check IOMMU/ACS'}
                </span>
              </div>
            </div>
          </div>

          {/* Tuning Checklist Table */}
          {status?.rdma?.tuningChecklist && status.rdma.tuningChecklist.length > 0 && (
            <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950/60 mt-3">
              <table className="w-full text-left text-xs font-sans">
                <thead className="bg-slate-900/90 text-slate-400 font-semibold border-b border-slate-800">
                  <tr>
                    <th className="p-2.5 w-16">Status</th>
                    <th className="p-2.5 w-48">Check Item</th>
                    <th className="p-2.5">Details &amp; Tuning Recommendation</th>
                    <th className="p-2.5 w-24 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-850">
                  {status.rdma.tuningChecklist.map((check, idx) => {
                    const label = check.item || check.title || 'Check';
                    const desc = check.detail || check.description || '';
                    const cmd = check.remediation || check.command;
                    return (
                      <tr key={idx} className="hover:bg-slate-900/40">
                        <td className="p-2.5">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded font-mono ${
                            check.status === 'pass'
                              ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                              : check.status === 'warn'
                              ? 'bg-amber-950 text-amber-400 border border-amber-800'
                              : 'bg-rose-950 text-rose-400 border border-rose-800'
                          }`}>
                            {check.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="p-2.5 font-semibold text-slate-200">{label}</td>
                        <td className="p-2.5 text-slate-400 text-[11px] leading-relaxed">
                          {desc}
                        </td>
                        <td className="p-2.5 text-right">
                          {cmd ? (
                            <button
                              type="button"
                              onClick={() => copyToClipboard(cmd)}
                              className="bg-slate-800 hover:bg-slate-700 text-sky-300 text-[11px] font-mono px-2 py-1 rounded border border-slate-700 transition"
                              title={cmd}
                            >
                              {copiedCmd === cmd ? 'Copied!' : 'Copy Fix'}
                            </button>
                          ) : (
                            <span className="text-slate-600 text-[11px]">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Interactive Roofline & Disaggregated KV-Transfer Simulator */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-6 shadow-xl space-y-5">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center pb-3 border-b border-slate-800 gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-indigo-400 uppercase tracking-wider">Roofline &amp; Network Lab</span>
                <span className="bg-indigo-950 text-indigo-300 text-[10px] px-2 py-0.5 rounded border border-indigo-800 font-mono font-semibold">
                  Disaggregation Simulator
                </span>
              </div>
              <h2 className="text-base font-bold text-slate-100 mt-1">
                Prefill-Decode KV Transfer &amp; Arithmetic Intensity Modeling
              </h2>
            </div>
            <div className="text-[11px] text-slate-400">
              Simulates GQA vs. DeepSeek MLA across 100G/200G/400G/800G RDMA fabrics
            </div>
          </div>

          {/* Interactive Controls */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            {/* Model Architecture */}
            <div>
              <label className="block text-slate-400 font-medium mb-1">Target Model Architecture</label>
              <select
                value={simModel}
                onChange={(e) => setSimModel(e.target.value as any)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-200 focus:border-indigo-400 outline-none"
              >
                <option value="llama-3.3-70b">Llama-3.3-70B (80 layers, GQA-8)</option>
                <option value="deepseek-v3">DeepSeek-V3 / R1 (61 layers, MLA)</option>
                <option value="llama-3.1-8b">Llama-3.1-8B (32 layers, GQA-8)</option>
                <option value="qwen-2.5-72b">Qwen-2.5-72B (80 layers, GQA-8)</option>
              </select>
            </div>

            {/* Precision */}
            <div>
              <label className="block text-slate-400 font-medium mb-1">KV Cache Precision</label>
              <div className="flex gap-2">
                {(['fp8', 'bf16'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setSimPrecision(p)}
                    className={`flex-1 py-2 px-3 rounded-lg border text-xs font-mono uppercase transition ${
                      simPrecision === p
                        ? 'bg-indigo-600 border-indigo-500 text-white font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {p} ({p === 'fp8' ? '1 byte' : '2 bytes'})
                  </button>
                ))}
              </div>
            </div>

            {/* Network Fabric Bandwidth */}
            <div>
              <label className="block text-slate-400 font-medium mb-1">RDMA Fabric Bandwidth</label>
              <div className="grid grid-cols-4 gap-1">
                {([100, 200, 400, 800] as const).map((bw) => (
                  <button
                    key={bw}
                    type="button"
                    onClick={() => setSimBandwidthGbps(bw)}
                    className={`py-2 px-1 text-center rounded-lg border text-[11px] font-mono transition ${
                      simBandwidthGbps === bw
                        ? 'bg-sky-600 border-sky-500 text-white font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {bw}G
                  </button>
                ))}
              </div>
            </div>

            {/* Prompt Length */}
            <div>
              <div className="flex justify-between text-slate-400 font-medium mb-1">
                <span>Prompt Context</span>
                <span className="text-sky-400 font-mono">{simTokens.toLocaleString()} tokens</span>
              </div>
              <input
                type="range"
                min="512"
                max="65536"
                step="512"
                value={simTokens}
                onChange={(e) => setSimTokens(parseInt(e.target.value, 10))}
                className="w-full accent-sky-500"
              />
            </div>
          </div>

          {/* Simulation Output Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 pt-2">
            {/* KV Cache Footprint */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>KV Footprint</span>
                <span className="text-[10px] bg-slate-900 border border-slate-800 text-slate-300 px-1.5 py-0.5 rounded font-mono">
                  {simResult.archType}
                </span>
              </div>
              <div className="mt-2 text-2xl font-bold text-amber-400 font-mono">
                {simResult.totalMb} <span className="text-xs text-slate-400 font-normal">MB</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                Unit rate: <span className="text-slate-200 font-semibold">{simResult.bytesPerTokenKb} KiB/token</span>
              </div>
            </div>

            {/* Wire Transfer vs Prefill Compute */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>Raw Wire Transfer</span>
                <span className="text-[10px] text-sky-400 font-mono">{simBandwidthGbps} Gbps</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-sky-400 font-mono">
                {simResult.rawWireTimeMs} <span className="text-xs text-slate-400 font-normal">ms</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                Compute duration: <span className="text-slate-200 font-semibold">{simResult.prefillComputeTimeMs} ms</span>
              </div>
            </div>

            {/* Layer-Pipelined Overlap */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>Pipelined RDMA Overlap</span>
                <span className="text-[10px] bg-emerald-950 border border-emerald-800 text-emerald-300 px-1.5 py-0.5 rounded font-mono">
                  NIXL / Mooncake
                </span>
              </div>
              <div className="mt-2 text-2xl font-bold text-emerald-400 font-mono">
                {simResult.overlapPct}%
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                Exposed TTFT overhead: <span className="text-emerald-300 font-semibold">~{simResult.exposedLatencyMs} ms</span>
              </div>
            </div>

            {/* Roofline Operational Regime */}
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>Roofline Ridge Point</span>
                <span className="text-[10px] text-indigo-400 font-mono">H100 FP8</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-indigo-400 font-mono">
                {simResult.ridgePoint} <span className="text-xs text-slate-400 font-normal">FLOPs/B</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Prefill: <span className="text-purple-300 font-mono font-semibold">Compute-Bound</span> &bull; Decode: <span className="text-amber-300 font-mono font-semibold">Memory-Bound</span>
              </div>
            </div>
          </div>
        </div>

        {/* Zero-Trust Confidential Silicon Readiness (SEV-SNP / TDX / H100 CC) */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-6 shadow-xl space-y-4">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center pb-3 border-b border-slate-800 gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">Zero-Trust Silicon Probe</span>
                <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold border ${
                  status?.confidential?.supported
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                    : 'bg-slate-850 text-slate-400 border-slate-700'
                }`}>
                  {status?.confidential?.supported ? 'Confidential TEE Active' : 'Standard Unencrypted Host'}
                </span>
              </div>
              <h2 className="text-base font-bold text-slate-100 mt-1">
                AMD SEV-SNP, Intel TDX &amp; NVIDIA H100 CC-Mode Attestation Readiness
              </h2>
            </div>
            <div className="text-[11px] text-slate-400">
              RMP / S-EPT Memory Integrity &bull; DMTF SPDM 1.2 &bull; IETF RATS / Trustee KBS
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">CPU Enclave (/dev/sev-guest | tdx)</span>
              <div className="mt-1 font-mono text-xs font-bold flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${
                  status?.confidential?.sevGuestDevicePresent || status?.confidential?.tdxGuestDevicePresent
                    ? 'bg-emerald-400'
                    : status?.confidential?.hostSevSnpEnabled
                    ? 'bg-sky-400'
                    : 'bg-amber-400'
                }`} />
                <span className="text-slate-200 truncate">
                  {status?.confidential?.cpuTeeType || 'Standard Host (Unencrypted)'}
                </span>
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">NVIDIA GPU CC-Mode</span>
              <div className="mt-1 font-mono text-xs font-bold flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${
                  status?.confidential?.gpuCcMode && status.confidential.gpuCcMode !== 'Off'
                    ? 'bg-emerald-400'
                    : 'bg-slate-500'
                }`} />
                <span className={
                  status?.confidential?.gpuCcMode && status.confidential.gpuCcMode !== 'Off'
                    ? 'text-emerald-300'
                    : 'text-slate-400'
                }>
                  {status?.confidential?.gpuCcMode || 'Off'} ({status?.confidential?.gpuReadyState ? 'Ready' : 'Unattested'})
                </span>
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">PCIe DMA Bounce Buffer</span>
              <div className="mt-1 font-mono text-xs font-bold text-slate-200 truncate">
                {status?.confidential?.swiotlbBounceActive
                  ? 'SWIOTLB + CE AES-GCM-256'
                  : 'Direct DMA (Unbounced)'}
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3">
              <span className="text-[11px] text-slate-400">GSP BAR0/BAR1 Firewall</span>
              <div className="mt-1 font-mono text-xs font-bold flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${
                  status?.confidential?.gpuCcMode && status.confidential.gpuCcMode !== 'Off'
                    ? 'bg-emerald-400'
                    : 'bg-slate-500'
                }`} />
                <span className="text-slate-300">
                  {status?.confidential?.gpuCcMode && status.confidential.gpuCcMode !== 'Off'
                    ? 'Locked (DevTools Blocked)'
                    : 'Open Host MMIO'}
                </span>
              </div>
            </div>
          </div>

          {status?.confidential?.attestationChecklist && status.confidential.attestationChecklist.length > 0 && (
            <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950/60 mt-3">
              <table className="w-full text-left text-xs font-sans">
                <thead className="bg-slate-900/90 text-slate-400 font-semibold border-b border-slate-800">
                  <tr>
                    <th className="p-2.5 w-20">Status</th>
                    <th className="p-2.5 w-64">Attestation Step</th>
                    <th className="p-2.5">Cryptographic Verification &amp; Unseal Workflow</th>
                    <th className="p-2.5 w-24 text-right">CLI</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-850">
                  {status.confidential.attestationChecklist.map((step, idx) => (
                    <tr key={idx} className="hover:bg-slate-900/40">
                      <td className="p-2.5">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded font-mono ${
                          step.status === 'pass'
                            ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                            : step.status === 'warn'
                            ? 'bg-amber-950 text-amber-400 border border-amber-800'
                            : 'bg-rose-950 text-rose-400 border border-rose-800'
                        }`}>
                          {step.status === 'action_needed' ? 'ACTION' : step.status.toUpperCase()}
                        </span>
                      </td>
                      <td className="p-2.5 font-semibold text-slate-200">{step.title}</td>
                      <td className="p-2.5 text-slate-400 text-[11px] leading-relaxed">
                        {step.description}
                      </td>
                      <td className="p-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => copyToClipboard(step.command)}
                          className="bg-slate-800 hover:bg-slate-700 text-emerald-300 text-[11px] font-mono px-2 py-1 rounded border border-slate-700 transition"
                          title={step.command}
                        >
                          {copiedCmd === step.command ? 'Copied!' : 'Copy Cmd'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Interactive Confidential Silicon Enclave Lab */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-6 shadow-xl space-y-5">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center pb-3 border-b border-slate-800 gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">Confidential Silicon Enclave Lab</span>
                <span className={`text-[10px] px-2 py-0.5 rounded border font-mono font-bold ${
                  enclaveSimResult.enclavePosture === 'ISOLATED'
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-700'
                    : enclaveSimResult.enclavePosture === 'ATTESTATION_BLOCKED'
                    ? 'bg-amber-950 text-amber-300 border-amber-700'
                    : 'bg-rose-950 text-rose-300 border-rose-700'
                }`}>
                  Posture: {enclaveSimResult.enclavePosture}
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded border font-mono font-bold ${
                  enclaveSimResult.kbsKeyRelease === 'GRANTED'
                    ? 'bg-sky-950 text-sky-300 border-sky-700'
                    : 'bg-rose-950 text-rose-300 border-rose-700'
                }`}>
                  Trustee KBS DEK: {enclaveSimResult.kbsKeyRelease}
                </span>
              </div>
              <h2 className="text-base font-bold text-slate-100 mt-1">
                Hypervisor Attack Surface, SWIOTLB AES-GCM Overhead &amp; Dual Attestation Simulator
              </h2>
            </div>
            <div className="text-[11px] text-slate-400">
              AMD SEV-SNP RMP &bull; Intel TDX S-EPT &bull; H100 CC-On vs. Blackwell B200 TEE-I/O
            </div>
          </div>

          {/* Controls */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-xs">
            <div className="lg:col-span-2">
              <label className="block text-slate-400 font-medium mb-1">Enclave Hardware Architecture</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {([
                  { id: 'sev-snp-h100-cc', name: 'AMD SEV-SNP + H100 CC-On', sub: 'RMP + SWIOTLB CE AES-GCM-256' },
                  { id: 'tdx-b200-tee-io', name: 'Intel TDX + Blackwell B200 TEE-I/O', sub: 'S-EPT + PCIe Gen6 IDE + NVLink 5' },
                  { id: 'sev-es-passthrough', name: 'Legacy SEV-ES + VFIO GPU', sub: 'No RMP (Vulnerable to NPT/WeSee)' },
                  { id: 'standard-kvm', name: 'Standard Unencrypted KVM', sub: 'Plaintext DRAM, VMCB & PCIe BAR1' }
                ] as const).map((arch) => (
                  <button
                    key={arch.id}
                    type="button"
                    onClick={() => setEnclaveArch(arch.id)}
                    className={`p-2.5 rounded-lg border text-left transition ${
                      enclaveArch === arch.id
                        ? 'bg-emerald-950/60 border-emerald-500 text-slate-100'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="font-bold text-xs">{arch.name}</div>
                    <div className="text-[10px] font-mono text-slate-400 mt-0.5">{arch.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-slate-400 font-medium mb-1">Encrypted Model Checkpoint Size (FP8)</label>
              <div className="grid grid-cols-2 gap-2">
                {([8, 40, 70, 140] as const).map((gb) => (
                  <button
                    key={gb}
                    type="button"
                    onClick={() => setEnclaveWeightGb(gb)}
                    className={`py-2.5 px-3 rounded-lg border font-mono text-xs transition ${
                      enclaveWeightGb === gb
                        ? 'bg-emerald-600 border-emerald-400 text-slate-950 font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {gb} GB {gb === 70 ? '(70B)' : gb === 8 ? '(8B)' : gb === 140 ? '(405B/MoE)' : '(34B)'}
                  </button>
                ))}
              </div>
              <div className="mt-2 text-[11px] text-slate-400 font-mono">
                PCIe Mode: <span className="text-slate-200">{enclaveSimResult.pcieMode}</span>
              </div>
            </div>
          </div>

          {/* Telemetry Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>Cold H2D Weight Load</span>
                <span className="text-[10px] font-mono text-emerald-400">{enclaveSimResult.effectiveH2dBandwidthGbps} GB/s</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-amber-400 font-mono">
                {enclaveSimResult.coldLoadTimeSec} <span className="text-xs text-slate-400 font-normal">sec</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                {enclaveWeightGb} GB tmpfs &rarr; GPU HBM3
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>Single-GPU Decode (70B)</span>
                <span className="text-[10px] font-mono text-sky-400">Batch 32</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-sky-400 font-mono">
                {enclaveSimResult.singleGpuTokPerSec} <span className="text-xs text-slate-400 font-normal">tok/s</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                Encryption tax: <span className="text-slate-200 font-semibold">{enclaveSimResult.singleGpuOverheadPct}%</span> (16K TTFT: {enclaveSimResult.ttft16kMs}ms)
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>8x GPU TP AllReduce</span>
                <span className="text-[10px] font-mono text-indigo-400">Multi-GPU</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-indigo-400 font-mono">
                {enclaveSimResult.allReduceEfficiencyPct}%
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                {enclaveArch === 'tdx-b200-tee-io'
                  ? 'Inline Encrypted NVLink 5 (1.8 TB/s)'
                  : enclaveArch === 'sev-snp-h100-cc'
                  ? 'CPU Bounce-Buffer Encrypted AllReduce'
                  : 'Unencrypted NVLink'}
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>RATS Dual Attestation</span>
                <span className="text-[10px] font-mono text-emerald-400">SHA-512 Bound</span>
              </div>
              <div className={`mt-2 text-lg font-bold font-mono ${
                enclaveSimResult.kbsKeyRelease === 'GRANTED' ? 'text-emerald-400' : 'text-rose-400'
              }`}>
                {enclaveSimResult.kbsKeyRelease === 'GRANTED' ? 'UNSEAL GRANTED' : 'KEY DENIED'}
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                REPORT_DATA = SHA512(nonce || pubkey)
              </div>
            </div>
          </div>

          {/* Interactive Host / Bus Attack Matrix */}
          <div className="space-y-2.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <span className="text-xs font-bold text-slate-200">
                Simulate Untrusted Hypervisor &amp; Physical PCIe Bus Attack Vectors (Click to Toggle):
              </span>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { id: 'host_dram_dump', label: '/dev/mem DRAM Dump' },
                  { id: 'npt_aliasing', label: 'NPT Page Aliasing' },
                  { id: 'wesee_vc_spoof', label: 'WeSee #VC Spoof' },
                  { id: 'pcie_bar1_snoop', label: 'PCIe BAR1 Snoop' },
                  { id: 'rim_firmware_tamper', label: 'Tamper GPU Firmware RIM' }
                ].map((atk) => {
                  const active = enclaveAttacks.includes(atk.id);
                  return (
                    <button
                      key={atk.id}
                      type="button"
                      onClick={() => toggleEnclaveAttack(atk.id)}
                      className={`text-[11px] font-mono px-2.5 py-1 rounded border transition ${
                        active
                          ? 'bg-rose-950/80 border-rose-600 text-rose-200 font-semibold'
                          : 'bg-slate-950 border-slate-800 text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {active ? '⚡ ' : '+ '}
                      {atk.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {enclaveSimResult.evaluatedAttacks.map((atk) => (
                <div
                  key={atk.id}
                  className={`p-3 rounded-lg border text-xs ${
                    atk.blocked
                      ? 'bg-emerald-950/20 border-emerald-800/70'
                      : 'bg-rose-950/30 border-rose-800'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-slate-200">{atk.title}</span>
                    <span
                      className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                        atk.blocked
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-700'
                          : 'bg-rose-950 text-rose-300 border border-rose-700'
                      }`}
                    >
                      {atk.blocked ? 'HARDWARE BLOCKED' : 'EXPLOITED'}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-sky-300 mt-1">
                    Defense: {atk.mechanism}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                    {atk.detail}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Sub-4-Bit Frontier: OCP MXFP4, NVIDIA Blackwell NVFP4 & Walsh-Hadamard Outlier Lab */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-6 shadow-xl space-y-5">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center pb-3 border-b border-slate-800 gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">
                  Sub-4-Bit Microscaling &amp; Outlier Rotation Lab
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded border font-mono font-bold bg-amber-950 text-amber-300 border-amber-700">
                  Blackwell SM100 tcgen05.mma.kind::mxf4nvf4 (20 PFLOPS)
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded border font-mono font-bold ${
                  fp4EnableHadamard
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-700'
                    : 'bg-rose-950 text-rose-300 border-rose-700'
                }`}>
                  {fp4EnableHadamard ? 'QuaRot FWHT Active (99.6%MATH-500)' : 'Unrotated (Outlier Collapse Risk)'}
                </span>
              </div>
              <h2 className="text-base font-bold text-slate-100 mt-1">
                OCP MXFP4 vs. NVIDIA NVFP4 (E2M1) Two-Level Microscaling &amp; Walsh-Hadamard (R1..R4) Simulator
              </h2>
            </div>
            <div className="text-[11px] text-slate-400">
              16-Elem E2M1 + FP8 E4M3 Scale &bull; Fast Walsh-Hadamard O(d log d) &bull; SVDQuant Rank-16
            </div>
          </div>

          {/* Interactive Controls */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-xs">
            <div>
              <label className="block text-slate-400 font-medium mb-1">Reasoning Model Architecture</label>
              <div className="grid grid-cols-3 gap-2">
                {([
                  { b: 70, label: 'Llama-3.3-70B', sub: 'd=8192 (TP=1)' },
                  { b: 405, label: 'Llama-3.1-405B', sub: 'd=16384 (TP=4)' },
                  { b: 671, label: 'DeepSeek-R1', sub: '671B MoE MLA' }
                ] as const).map((m) => (
                  <button
                    key={m.b}
                    type="button"
                    onClick={() => setFp4ModelParamsB(m.b)}
                    className={`p-2 rounded-lg border text-left transition ${
                      fp4ModelParamsB === m.b
                        ? 'bg-amber-950/60 border-amber-500 text-slate-100'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <div className="font-bold text-[11px]">{m.label}</div>
                    <div className="text-[10px] font-mono text-slate-400 mt-0.5">{m.sub}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-slate-400 font-medium mb-1">
                Emergent SiLU_and_Mul Outlier Spike (down_proj)
              </label>
              <div className="grid grid-cols-3 gap-2">
                {([40, 80, 120] as const).map((spike) => (
                  <button
                    key={spike}
                    type="button"
                    onClick={() => setFp4OutlierSpike(spike)}
                    className={`py-2 px-3 rounded-lg border font-mono text-xs transition ${
                      fp4OutlierSpike === spike
                        ? 'bg-amber-600 border-amber-400 text-slate-950 font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {spike}.0x Spike
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-[10px] text-slate-400 font-mono">
                E2M1 Grid: &plusmn;&#123;0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0&#125; (Zero Inf/NaN waste)
              </div>
            </div>

            <div>
              <label className="block text-slate-400 font-medium mb-1">
                Outlier Rotation &amp; Low-Rank Absorption
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setFp4EnableHadamard(!fp4EnableHadamard)}
                  className={`p-2 rounded-lg border text-left transition ${
                    fp4EnableHadamard
                      ? 'bg-emerald-950/60 border-emerald-500 text-emerald-200'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  <div className="font-bold text-[11px]">
                    {fp4EnableHadamard ? '✓ Hadamard FWHT (R1-R4)' : '✗ No Hadamard Rotation'}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                    &lt;8&micro;s O(d log d) butterfly
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setFp4SvdRank(fp4SvdRank === 16 ? 0 : 16)}
                  className={`p-2 rounded-lg border text-left transition ${
                    fp4SvdRank === 16
                      ? 'bg-sky-950/60 border-sky-500 text-sky-200'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  <div className="font-bold text-[11px]">
                    {fp4SvdRank === 16 ? '✓ SVDQuant (Rank-16)' : '+ SVDQuant (Off)'}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                    Top-16 BF16 LoRA branch
                  </div>
                </button>
              </div>
            </div>
          </div>

          {/* Live Physics & Mathematical Telemetry Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>Hadamard Spike Damping</span>
                <span className="text-[10px] font-mono text-emerald-400">&radic;{fp4SimResult.hiddenDim} = {fp4SimResult.dampingFactor}x</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-emerald-400 font-mono">
                {fp4EnableHadamard ? fp4SimResult.rotatedMax : fp4OutlierSpike.toFixed(1)}{' '}
                <span className="text-xs text-slate-400 font-normal">max abs</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                Raw spike {fp4OutlierSpike}.0 &rarr; ||X&middot;H||&#8322; == ||X||&#8322;
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>NVFP4 Weight Footprint</span>
                <span className="text-[10px] font-mono text-amber-400">4.50 bits/elem</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-amber-400 font-mono">
                {fp4SimResult.nvfp4WeightGb} <span className="text-xs text-slate-400 font-normal">GB</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                vs. {fp4SimResult.bf16WeightGb} GB BF16 (Fits TP={fp4SimResult.tpSize})
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>Two-Level Scale Advantage</span>
                <span className="text-[10px] font-mono text-sky-400">k=16 E4M3 + FP32</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-sky-400 font-mono">
                2.4x <span className="text-xs text-slate-400 font-normal">Lower MSE</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                Eliminates MXFP4 E8M0 sawtooth jump
              </div>
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-4">
              <div className="flex justify-between items-center text-xs text-slate-400">
                <span>W4A4 Tensor Throughput</span>
                <span className="text-[10px] font-mono text-indigo-400">TMEM Accumulate</span>
              </div>
              <div className="mt-2 text-2xl font-bold text-indigo-400 font-mono">
                3.42x <span className="text-xs text-slate-400 font-normal">vs BF16</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1 font-mono">
                99.6% MATH-500 accuracy recovery
              </div>
            </div>
          </div>

          {/* Benchmark Comparison Table */}
          <div className="border border-slate-800 rounded-lg overflow-hidden bg-slate-950/60">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-slate-900/90 text-slate-400 font-semibold border-b border-slate-800">
                <tr>
                  <th className="p-2.5">Precision Format</th>
                  <th className="p-2.5">Bits/Weight</th>
                  <th className="p-2.5">Weight RAM</th>
                  <th className="p-2.5">MMLU-Pro</th>
                  <th className="p-2.5">MATH-500 (Reasoning)</th>
                  <th className="p-2.5">LiveCodeBench</th>
                  <th className="p-2.5">Throughput</th>
                  <th className="p-2.5">Hardware PTX</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {fp4SimResult.rows.map((r) => (
                  <tr
                    key={r.id}
                    className={
                      r.id === 'nvfp4'
                        ? 'bg-amber-950/25 text-amber-200 font-semibold'
                        : 'hover:bg-slate-900/40 text-slate-300'
                    }
                  >
                    <td className="p-2.5 font-sans font-semibold">{r.name}</td>
                    <td className="p-2.5">{r.bits}</td>
                    <td className="p-2.5">{r.weightGb} GB</td>
                    <td className="p-2.5">{r.mmluPro}</td>
                    <td className={`p-2.5 font-bold ${
                      r.status === 'degraded'
                        ? 'text-rose-400'
                        : r.status === 'optimal'
                        ? 'text-emerald-400'
                        : 'text-slate-200'
                    }`}>
                      {r.math500}
                    </td>
                    <td className="p-2.5">{r.liveCode}</td>
                    <td className="p-2.5 text-sky-300">{r.speedup}</td>
                    <td className="p-2.5 text-[10px] text-slate-400">{r.ptx}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* TensorRT ModelOpt PTQ + vLLM Single-GPU Launch Manifest */}
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-3.5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-amber-300 font-mono">
                TensorRT ModelOpt (nvidia-modelopt) NVFP4 + Walsh-Hadamard PTQ &amp; vLLM TP={fp4SimResult.tpSize} Launch Script
              </span>
              <button
                type="button"
                onClick={() => copyToClipboard(fp4SimResult.modelOptCmd)}
                className="bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 text-xs font-mono px-2.5 py-1 rounded transition"
              >
                {copiedCmd === fp4SimResult.modelOptCmd ? 'Copied!' : 'Copy NVFP4 Script'}
              </button>
            </div>
            <pre className="text-[11px] font-mono text-slate-300 overflow-x-auto bg-slate-900/80 p-3 rounded border border-slate-800/80">
              {fp4SimResult.modelOptCmd}
            </pre>
          </div>
        </div>

        {/* Live Job Feed */}
        <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-6 shadow-xl">
          <h2 className="text-base font-bold text-slate-200 mb-4 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span>📋</span> Recent Provider Compute Jobs
            </span>
            <span className="text-xs font-normal text-slate-400">
              {recentJobs.length} logged events
            </span>
          </h2>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="pb-2">Job ID</th>
                  <th className="pb-2">Model</th>
                  <th className="pb-2">Tokens</th>
                  <th className="pb-2">Duration</th>
                  <th className="pb-2">Earned</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {recentJobs.length > 0 ? (
                  recentJobs.map((job) => (
                    <tr key={job.id} className="hover:bg-slate-800/30 transition">
                      <td className="py-2.5 text-slate-400">{job.job_id.slice(0, 14)}...</td>
                      <td className="py-2.5 text-slate-200">{job.model}</td>
                      <td className="py-2.5 text-slate-300">
                        {job.prompt_tokens + job.completion_tokens}
                      </td>
                      <td className="py-2.5 text-slate-400">{job.duration_ms}ms</td>
                      <td className="py-2.5 text-emerald-400 font-bold">
                        +${job.earned_usd.toFixed(5)}
                      </td>
                      <td className="py-2.5">
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded font-semibold ${
                            job.status === 'SUCCESS'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : 'bg-rose-950 text-rose-300 border border-rose-800'
                          }`}
                        >
                          {job.status}
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-slate-500 italic">
                      No jobs executed yet. Start sharing GPU to begin receiving incoming requests!
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
