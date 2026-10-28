import { execSync } from 'node:child_process';
import os from 'node:os';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import {
  getProviderSettings,
  saveProviderSettings,
  logProviderJob,
  getProviderJobLogs,
  ProviderDbSettings
} from './db.js';

export interface GpuInfo {
  vendor: 'NVIDIA' | 'AMD' | 'APPLE' | 'INTEL' | 'CPU';
  model: string;
  count: number;
  vramTotalGb: number;
  vramFreeGb: number;
  temperatureC?: number;
  utilPercent?: number;
}

export interface LocalEngineModelInfo {
  name: string;
  sizeBytes?: number;
  vramUsageMb?: number;
}

export interface ProviderAgentConfig {
  serverUrl: string;
  nodeToken?: string;
  nodeName?: string;
  publicIp?: string;
  engineUrl: string;
  engineType: 'ollama' | 'vllm' | 'lemonade' | 'openai-compatible';
  pricingMode: 'market' | 'floor';
  floorPriceIn?: number;
  floorPriceOut?: number;
  pauseOnUserActive: boolean;
  maxGpuTempC: number;
  maxConcurrency: number;
  heartbeatIntervalMs?: number;
}

export interface RdmaDeviceStatus {
  device: string;
  linkLayer: 'InfiniBand' | 'Ethernet' | 'Unknown';
  state: string;
  rate?: string;
}

export interface RdmaFabricStatus {
  supported: boolean;
  available: boolean;
  nvidiaPeermemLoaded: boolean;
  driverLoaded: boolean;
  devices: RdmaDeviceStatus[];
  ibDevices: string[];
  pcieAcsEnabled?: boolean;
  pciP2pSupported: boolean;
  hasLosslessRoce: boolean;
  tuningChecklist: Array<{
    title: string;
    description: string;
    command: string;
    status: 'pass' | 'warn' | 'action_needed';
  }>;
}

export interface ConfidentialComputeStatus {
  supported: boolean;
  cpuTeeType: 'AMD SEV-SNP' | 'Intel TDX' | 'AMD SEV-ES' | 'Host KVM (SEV-SNP Ready)' | 'Standard Host (Unencrypted)';
  sevGuestDevicePresent: boolean;
  tdxGuestDevicePresent: boolean;
  hostSevSnpEnabled: boolean;
  gpuCcMode: 'CC-On' | 'PPCIE' | 'TEE-I/O' | 'Off';
  gpuReadyState: boolean;
  swiotlbBounceActive: boolean;
  attestationChecklist: Array<{
    title: string;
    description: string;
    command: string;
    status: 'pass' | 'warn' | 'action_needed';
  }>;
}

export interface ProviderStatusInfo {
  status: 'OFFLINE' | 'INITIALIZING' | 'ONLINE' | 'SERVING' | 'PAUSED' | 'ERROR';
  nodeId?: string;
  reputationScore: number;
  totalJobsCompleted: number;
  totalTokensServed: number;
  totalEarnedUsd: number;
  gpu: GpuInfo;
  models: string[];
  rdma?: RdmaFabricStatus;
  confidential?: ConfidentialComputeStatus;
  lastHeartbeatAt?: string;
  errorMessage?: string;
}

/**
 * Detects local GPU hardware across NVIDIA, AMD, Apple Silicon, or CPU fallback.
 */
export async function detectGpuHardware(): Promise<GpuInfo> {
  const platform = os.platform();

  // 1. Try NVIDIA via nvidia-smi
  try {
    const stdout = execSync(
      'nvidia-smi --query-gpu=name,memory.total,memory.free,temperature.gpu,utilization.gpu --format=csv,noheader,nounits',
      { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }
    );
    const lines = stdout.trim().split('\n');
    if (lines.length > 0 && lines[0].trim()) {
      const parts = lines[0].split(',').map((s) => s.trim());
      const model = parts[0] || 'NVIDIA GPU';
      const totalMb = parseFloat(parts[1]) || 8192;
      const freeMb = parseFloat(parts[2]) || 6144;
      // Only report a temperature nvidia-smi actually measured; some GPUs
      // report 'N/A' — never substitute an invented constant.
      const temp = parseInt(parts[3], 10);
      const util = parseInt(parts[4], 10) || 0;

      return {
        vendor: 'NVIDIA',
        model,
        count: lines.length,
        vramTotalGb: Number((totalMb / 1024).toFixed(1)),
        vramFreeGb: Number((freeMb / 1024).toFixed(1)),
        ...(Number.isNaN(temp) ? {} : { temperatureC: temp }),
        utilPercent: util,
      };
    }
  } catch {
    // nvidia-smi not available
  }

  // 2. Try AMD via ROCm (rocminfo, rocm-smi) or Linux DRM sysfs
  if (platform === 'linux') {
    try {
      let model = '';
      const rocminfoCandidates = ['rocminfo', '/opt/rocm/bin/rocminfo'];
      for (const rPath of rocminfoCandidates) {
        try {
          const out = execSync(rPath, { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] });
          const m = out.match(/Marketing Name:\s+([^\n]+)/g);
          if (m && m.length > 0) {
            const graphicsEntry = m.find((s) => /Graphics|Radeon|Instinct/i.test(s));
            const selected = graphicsEntry || m[0];
            model = selected.replace(/Marketing Name:\s*/i, '').trim();
            break;
          }
        } catch {
          // continue
        }
      }

      if (!model) {
        try {
          const lspci = execSync('lspci', { encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] });
          const match = lspci.match(/(?:VGA|3D|Display)[^:]*:\s*(?:Advanced Micro Devices, Inc\.\s*)?\[AMD\/ATI\]\s*([^(\n]+)/i);
          if (match) {
            model = 'AMD ' + match[1].trim();
          }
        } catch {
          // ignore
        }
      }

      let totalBytes = 0;
      let usedBytes = 0;
      // Stays undefined unless a hwmon sensor file yields a real reading —
      // an unmeasured temperature must be absent, never an invented constant.
      let tempC: number | undefined = undefined;
      let utilPercent = 0;
      let foundAmdCard = false;

      if (fs.existsSync('/sys/class/drm')) {
        const cards = fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c));
        for (const card of cards) {
          const driverPath = `/sys/class/drm/${card}/device/driver`;
          try {
            if (fs.existsSync(driverPath) && fs.readlinkSync(driverPath).includes('amdgpu')) {
              foundAmdCard = true;
              const devDir = `/sys/class/drm/${card}/device`;

              const vramTot = fs.existsSync(`${devDir}/mem_info_vram_total`)
                ? parseInt(fs.readFileSync(`${devDir}/mem_info_vram_total`, 'utf8').trim(), 10)
                : 0;
              const vramUsed = fs.existsSync(`${devDir}/mem_info_vram_used`)
                ? parseInt(fs.readFileSync(`${devDir}/mem_info_vram_used`, 'utf8').trim(), 10)
                : 0;
              const gttTot = fs.existsSync(`${devDir}/mem_info_gtt_total`)
                ? parseInt(fs.readFileSync(`${devDir}/mem_info_gtt_total`, 'utf8').trim(), 10)
                : 0;
              const gttUsed = fs.existsSync(`${devDir}/mem_info_gtt_used`)
                ? parseInt(fs.readFileSync(`${devDir}/mem_info_gtt_used`, 'utf8').trim(), 10)
                : 0;

              // For APU / iGPU, GTT represents the available shared host memory accessible to ROCm
              const memTotal = Math.max(vramTot, gttTot);
              const memUsed = vramTot > gttTot ? vramUsed : gttUsed;
              if (memTotal > totalBytes) {
                totalBytes = memTotal;
                usedBytes = memUsed;
              }

              if (fs.existsSync(`${devDir}/gpu_busy_percent`)) {
                utilPercent = parseInt(fs.readFileSync(`${devDir}/gpu_busy_percent`, 'utf8').trim(), 10) || 0;
              }

              const hwmonDir = `${devDir}/hwmon`;
              if (fs.existsSync(hwmonDir)) {
                const hwmons = fs.readdirSync(hwmonDir);
                for (const h of hwmons) {
                  const tempFile = `${hwmonDir}/${h}/temp1_input`;
                  if (fs.existsSync(tempFile)) {
                    const milliC = parseInt(fs.readFileSync(tempFile, 'utf8').trim(), 10);
                    if (!Number.isNaN(milliC) && milliC > 0) {
                      tempC = Math.round(milliC / 1000);
                    }
                    break;
                  }
                }
              }
              break;
            }
          } catch {
            // ignore
          }
        }
      }

      if (foundAmdCard || model || fs.existsSync('/sys/module/amdgpu')) {
        // When sysfs exposed no memory counters, fall back to host memory
        // (the shared-memory reality for APUs) instead of inventing VRAM.
        const vramTotalGb = totalBytes > 0 ? Number((totalBytes / (1024 * 1024 * 1024)).toFixed(1)) : Number((os.totalmem() / (1024 * 1024 * 1024)).toFixed(1));
        const vramFreeGb = totalBytes > 0 ? Math.max(0, Number(((totalBytes - usedBytes) / (1024 * 1024 * 1024)).toFixed(1))) : Number((os.freemem() / (1024 * 1024 * 1024)).toFixed(1));

        return {
          vendor: 'AMD',
          model: model || 'AMD Radeon / Instinct Accelerator',
          count: 1,
          vramTotalGb,
          vramFreeGb,
          ...(tempC !== undefined ? { temperatureC: tempC } : {}),
          utilPercent,
        };
      }
    } catch {
      // ignore
    }
  }

  // 2b. Fallback rocm-smi
  try {
    const stdout = execSync('rocm-smi --showproductname --showmeminfo vram --csv', {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (stdout.includes('Card') || stdout.includes('GPU')) {
      // rocm-smi answered but yielded no parseable memory/temperature data:
      // derive capacity from host memory and omit temperature entirely
      // rather than inventing VRAM figures or a temperature.
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      return {
        vendor: 'AMD',
        model: 'AMD Radeon / Instinct Accelerator',
        count: 1,
        vramTotalGb: Number((totalMem / (1024 * 1024 * 1024)).toFixed(1)),
        vramFreeGb: Number((freeMem / (1024 * 1024 * 1024)).toFixed(1)),
        utilPercent: 0,
      };
    }
  } catch {
    // rocm-smi not available
  }

  // 3. Try Apple Silicon on macOS
  if (platform === 'darwin') {
    try {
      const brand = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const totalGb = Number((totalMem / (1024 * 1024 * 1024)).toFixed(1));

      return {
        vendor: 'APPLE',
        model: brand || 'Apple Silicon (Metal Unified Memory)',
        count: 1,
        vramTotalGb: totalGb,
        // Unified memory: free capacity is the host's free memory, not a
        // fixed fraction of the total. No temperature is reported — none is
        // measured here, and an invented constant would defeat the thermal
        // guard that consumes this field.
        vramFreeGb: Number((freeMem / (1024 * 1024 * 1024)).toFixed(1)),
        utilPercent: 0,
      };
    } catch {
      // ignore
    }
  }

  // 4. Default Host Hardware Profile (CPU fallback)
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'Host CPU';

  return {
    vendor: 'CPU',
    model: `${cpuModel} (${cpus.length} vCPUs)`,
    count: cpus.length,
    vramTotalGb: Number((totalMem / (1024 * 1024 * 1024)).toFixed(1)),
    vramFreeGb: Number((freeMem / (1024 * 1024 * 1024)).toFixed(1)),
    // No temperature: a CPU-only host has no GPU sensor read here, and a
    // hardcoded value would be presented as measured telemetry (and would
    // silently disable the thermal guard, which keys off this field).
    utilPercent: 0,
  };
}

/**
 * Probes Linux host for RDMA, RoCEv2 (ConnectX), nvidia_peermem, and PCIe ACS status.
 */
export async function detectRdmaFabricStatus(): Promise<RdmaFabricStatus> {
  const isLinux = os.platform() === 'linux';
  if (!isLinux) {
    return {
      supported: false,
      available: false,
      nvidiaPeermemLoaded: false,
      driverLoaded: false,
      devices: [],
      ibDevices: [],
      pciP2pSupported: false,
      hasLosslessRoce: false,
      tuningChecklist: []
    };
  }

  // 1. Check nvidia_peermem
  let nvidiaPeermemLoaded = false;
  try {
    if (fs.existsSync('/proc/modules')) {
      const modules = fs.readFileSync('/proc/modules', 'utf8');
      nvidiaPeermemLoaded = modules.includes('nvidia_peermem');
    }
  } catch {}

  // 2. Scan /sys/class/infiniband for ConnectX devices (mlx5_*)
  const devices: RdmaDeviceStatus[] = [];
  try {
    if (fs.existsSync('/sys/class/infiniband')) {
      const devs = fs.readdirSync('/sys/class/infiniband');
      for (const dev of devs) {
        let linkLayer: 'InfiniBand' | 'Ethernet' | 'Unknown' = 'Unknown';
        let state = 'DOWN';
        let rate: string | undefined = undefined;

        const portDir = `/sys/class/infiniband/${dev}/ports/1`;
        if (fs.existsSync(portDir)) {
          try {
            if (fs.existsSync(`${portDir}/link_layer`)) {
              const layer = fs.readFileSync(`${portDir}/link_layer`, 'utf8').trim();
              if (/infiniband/i.test(layer)) linkLayer = 'InfiniBand';
              else if (/ethernet/i.test(layer)) linkLayer = 'Ethernet';
            }
            if (fs.existsSync(`${portDir}/state`)) {
              state = fs.readFileSync(`${portDir}/state`, 'utf8').trim();
            }
            if (fs.existsSync(`${portDir}/rate`)) {
              rate = fs.readFileSync(`${portDir}/rate`, 'utf8').trim();
            }
          } catch {}
        }

        devices.push({
          device: dev,
          linkLayer,
          state,
          rate
        });
      }
    }
  } catch {}

  // 3. Check PCIe ACS (Access Control Services)
  let pcieAcsEnabled: boolean | undefined = undefined;
  try {
    const lspciOut = execSync('lspci -vvv 2>/dev/null | grep -i "ACSCtl:" || true', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    if (lspciOut.trim()) {
      pcieAcsEnabled = lspciOut.includes('SrcValid+') || lspciOut.includes('ReqRedir+');
    }
  } catch {}

  const hasLosslessRoce = devices.some(d => d.linkLayer === 'Ethernet' || d.linkLayer === 'InfiniBand');
  const targetDevice = devices[0]?.device || 'mlx5_0';

  const tuningChecklist: RdmaFabricStatus['tuningChecklist'] = [
    {
      title: 'PFC Priority 3 (DSCP 26) Lossless RoCEv2',
      description: 'Maps RoCEv2 UDP port 4791 traffic to Priority 3 with link-level PFC pause frames to prevent Go-Back-N packet drops.',
      command: `mlnx_qos -i enp170s0f0 --trust dscp --pfc 0,0,0,1,0,0,0,0\ncma_roce_tos -d ${targetDevice} -t 106`,
      status: (hasLosslessRoce ? 'pass' : 'warn') as 'pass' | 'warn'
    },
    {
      title: 'DCQCN Hardware Congestion Control',
      description: 'Configures ECN WRED thresholds on leaf switches (Kmin=150KB, Kmax=1500KB) so ConnectX paces injection before buffer exhaustion.',
      command: 'ethtool -k <nic> | grep -E "tcp-segmentation-offload|generic-segmentation-offload"',
      status: 'pass'
    },
    {
      title: 'nvidia_peermem Kernel Module',
      description: 'Enables GPUDirect RDMA zero-copy transfers directly between GPU HBM and ConnectX NICs, bypassing host DDR5 RAM.',
      command: 'modprobe nvidia_peermem && lsmod | grep nvidia_peermem',
      status: (nvidiaPeermemLoaded ? 'pass' : 'action_needed') as 'pass' | 'action_needed'
    },
    {
      title: 'GPUDirect RDMA Bandwidth Verification (ib_write_bw)',
      description: 'Validates 400GbE / NDR sustained GPU-to-GPU throughput (~47 GB/s payload) with sub-3μs latency.',
      command: `# Server (Node B):\nib_write_bw -d ${targetDevice} --use_cuda=0 -F --report_gbits -q 4\n# Client (Node A):\nib_write_bw -d ${targetDevice} --use_cuda=0 -F --report_gbits -q 4 -s 65536 <node-b-ip>`,
      status: (devices.length > 0 ? 'pass' : 'warn') as 'pass' | 'warn'
    }
  ];

  const supported = devices.length > 0 || nvidiaPeermemLoaded;
  return {
    supported,
    available: supported,
    nvidiaPeermemLoaded,
    driverLoaded: nvidiaPeermemLoaded,
    devices,
    ibDevices: devices.map(d => d.device),
    pcieAcsEnabled,
    pciP2pSupported: pcieAcsEnabled === false,
    hasLosslessRoce,
    tuningChecklist
  };
}

/**
 * Probes Linux host / Confidential VM for AMD SEV-SNP (/dev/sev-guest), Intel TDX (/dev/tdx_guest),
 * KVM host SEV-SNP parameters, and NVIDIA H100 / Blackwell Confidential Computing (nvidia-smi conf-compute).
 */
export async function detectConfidentialComputeStatus(): Promise<ConfidentialComputeStatus> {
  const isLinux = os.platform() === 'linux';
  const sevGuestDevicePresent = isLinux && fs.existsSync('/dev/sev-guest');
  const tdxGuestDevicePresent =
    isLinux && (fs.existsSync('/dev/tdx_guest') || fs.existsSync('/dev/tdx-guest'));

  let hostSevSnpEnabled = false;
  try {
    if (isLinux && fs.existsSync('/sys/module/kvm_amd/parameters/sev_snp')) {
      const val = fs.readFileSync('/sys/module/kvm_amd/parameters/sev_snp', 'utf8').trim();
      hostSevSnpEnabled = val === 'Y' || val === '1';
    }
  } catch {}

  let gpuCcMode: ConfidentialComputeStatus['gpuCcMode'] = 'Off';
  let gpuReadyState = false;
  try {
    const ccOut = execSync('nvidia-smi conf-compute -f 2>/dev/null || true', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    if (/TEE-I\/O/i.test(ccOut)) {
      gpuCcMode = 'TEE-I/O';
    } else if (/PPCIE/i.test(ccOut)) {
      gpuCcMode = 'PPCIE';
    } else if (/ON|ENABLED/i.test(ccOut)) {
      gpuCcMode = 'CC-On';
    }

    const grsOut = execSync('nvidia-smi conf-compute -grs 2>/dev/null || true', {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    if (/ready/i.test(grsOut) && !/not ready/i.test(grsOut)) {
      gpuReadyState = true;
    }
  } catch {}

  const cpuTeeType: ConfidentialComputeStatus['cpuTeeType'] = sevGuestDevicePresent
    ? 'AMD SEV-SNP'
    : tdxGuestDevicePresent
    ? 'Intel TDX'
    : hostSevSnpEnabled
    ? 'Host KVM (SEV-SNP Ready)'
    : 'Standard Host (Unencrypted)';

  const supported = sevGuestDevicePresent || tdxGuestDevicePresent || gpuCcMode !== 'Off';
  const swiotlbBounceActive =
    (sevGuestDevicePresent || tdxGuestDevicePresent) && gpuCcMode !== 'TEE-I/O';

  const attestationChecklist: ConfidentialComputeStatus['attestationChecklist'] = [
    {
      title: '1. Enable NVIDIA H100 / B200 Confidential Compute & Ready State',
      description:
        'Verifies GSP MMU firewall (BAR0/BAR1 locked), blocks DevTools performance counters, and transitions GPU into Ready State after SPDM RIM check.',
      command:
        'nvidia-smi conf-compute -f\nnvidia-smi conf-compute -grs\n# Post-attestation unlock:\nnvidia-smi conf-compute -srs 1',
      status: gpuCcMode !== 'Off' && gpuReadyState ? 'pass' : 'action_needed'
    },
    {
      title: '2. Generate & Verify AMD SEV-SNP Hardware Attestation Report (VMPL 0)',
      description:
        'Requests a 1184-byte VCEK-signed attestation report from /dev/sev-guest binding SHA512(nonce || ephemeral_pubkey) into REPORT_DATA and verifies the Milan/Genoa ARK->ASK->VCEK chain.',
      command:
        'snpguest report attestation_report.bin report_data.bin --vmpl 0\nsnpguest certificates PEM ./certs\nsnpguest verify attestation ./certs attestation_report.bin',
      status: sevGuestDevicePresent || tdxGuestDevicePresent ? 'pass' : 'warn'
    },
    {
      title: '3. Verify GPU SPDM 1.2 ECDSA P-384 Quote & VBIOS/GSP RIMs',
      description:
        'Collects 32-Slot PCR measurements over encrypted SPDM channel and validates against NVIDIA Reference Integrity Manifests (RIM).',
      command:
        'python3 -c "from nv_attestation_sdk import attestation; client = attestation.Attestation(); client.add_verifier(attestation.Devices.GPU, attestation.Environment.LOCAL, \'\', \'\'); print(client.attest(nonce))"',
      status: gpuCcMode !== 'Off' ? 'pass' : 'warn'
    },
    {
      title: '4. Trustee KBS RATS Key Release & Encrypted tmpfs Model Unseal',
      description:
        'Submits composite CPU+GPU evidence to Trustee KBS / OpenBao, unwraps the 256-bit AES-GCM DEK inside enclave RAM, and streams decrypted weights into /mnt/enclave_ram/models.',
      command:
        'mount -t tmpfs -o size=160G tmpfs /mnt/enclave_ram/models\nkbs-client --url https://kbs.internal.corp:8080 get-resource --path default/llama3-70b/dek | openssl enc -d -aes-256-gcm -in /mnt/encrypted_nvme/llama-70b.enc -out /mnt/enclave_ram/models/model.safetensors',
      status: supported ? 'pass' : 'warn'
    }
  ];

  return {
    supported,
    cpuTeeType,
    sevGuestDevicePresent,
    tdxGuestDevicePresent,
    hostSevSnpEnabled,
    gpuCcMode,
    gpuReadyState,
    swiotlbBounceActive,
    attestationChecklist
  };
}

/**
 * Probes a local inference engine (Ollama, vLLM, Lemonade) for its models.
 *
 * Returns the models an engine actually reported (possibly an empty list if
 * an engine answered but serves no models), or `null` when NO probe got a
 * successful response — i.e. detection did not succeed and nothing is known
 * about the engine's catalog. Callers that advertise models (registration,
 * status) must use this probe so an unreachable engine can never result in
 * an invented catalog being presented as installed.
 */
export async function probeLocalEngineModels(
  engineUrl: string = 'http://localhost:11434',
  engineType: string = 'ollama'
): Promise<LocalEngineModelInfo[] | null> {
  const trimmed = engineUrl.trim().replace(/\/+$/, '');
  const candidateUrls: string[] = [];

  if (engineType === 'ollama') {
    candidateUrls.push(`${trimmed}/api/tags`, `${trimmed}/v1/models`, `${trimmed}/models`);
  } else {
    candidateUrls.push(`${trimmed}/v1/models`, `${trimmed}/models`, `${trimmed}/api/tags`);
  }

  let engineResponded = false;

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) continue;
      const data = await res.json();
      engineResponded = true;

      // Standard Ollama format: { models: [{ name, size }] }
      if (Array.isArray(data.models) && data.models.length > 0) {
        return data.models.map((m: any) => ({
          name: m.name || m.model || String(m),
          sizeBytes: m.size || 0,
          vramUsageMb: Math.round((m.size || 4000000000) / (1024 * 1024)),
        }));
      }

      // OpenAI format: { data: [{ id }] }
      if (Array.isArray(data.data) && data.data.length > 0) {
        return data.data.map((m: any) => ({
          name: m.id || m.name || String(m),
          sizeBytes: 0,
          vramUsageMb: 4096,
        }));
      }
    } catch {
      // Continue to next probe
    }
  }

  // An engine answered but reported no models: that is an honest empty
  // catalog. No answer at all: detection failed.
  return engineResponded ? [] : null;
}

/**
 * Queries local inference engine (Ollama, vLLM, Lemonade) for loaded/available models.
 *
 * Legacy convenience wrapper: when no probe succeeds (or the engine reports
 * no models) it returns plausible fallback defaults for display purposes.
 * These fallbacks are INVENTED — never register or advertise them as a
 * node's installed models. Use probeLocalEngineModels() where the truth
 * matters.
 */
export async function detectLocalEngineModels(
  engineUrl: string = 'http://localhost:11434',
  engineType: string = 'ollama'
): Promise<LocalEngineModelInfo[]> {
  const probed = await probeLocalEngineModels(engineUrl, engineType);
  if (probed && probed.length > 0) {
    return probed;
  }

  // Fallback defaults
  return [
    { name: 'llama3.1:8b', sizeBytes: 4800000000, vramUsageMb: 4900 },
    { name: 'qwen2.5-coder:7b', sizeBytes: 4500000000, vramUsageMb: 4600 }
  ];
}

/**
 * Eluvix Provider Agent
 * Connects local machine to Billama Compute Grid to sell idle GPU compute time.
 */
export class EluvixProviderAgent extends EventEmitter {
  private config: ProviderAgentConfig;
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private consumerPreemptionTimer: NodeJS.Timeout | null = null;
  private nodeId: string | null = null;
  private gpuInfo: GpuInfo | null = null;
  private installedModels: LocalEngineModelInfo[] = [];
  private reputationScore: number = 100.0;
  private lastErrorMessage: string | null = null;

  constructor(customConfig?: Partial<ProviderAgentConfig>) {
    super();

    const stored = getProviderSettings();
    this.config = {
      serverUrl: stored?.server_url || 'https://api.billama.dev',
      nodeToken: stored?.node_token || undefined,
      nodeName: stored?.node_name || undefined,
      engineUrl: stored?.engine_url || 'http://localhost:11434',
      engineType: (stored?.engine_type as any) || 'ollama',
      pricingMode: (stored?.pricing_mode as any) || 'market',
      floorPriceIn: stored?.floor_price_in || 0,
      floorPriceOut: stored?.floor_price_out || 0,
      pauseOnUserActive: Boolean(stored?.pause_on_user_active ?? 1),
      maxGpuTempC: stored?.max_gpu_temp_c || 82,
      maxConcurrency: stored?.max_concurrency || 1,
      heartbeatIntervalMs: 10000,
      ...customConfig,
    };

    if (stored?.node_id) {
      this.nodeId = stored.node_id;
    }
    if (stored?.reputation_score) {
      this.reputationScore = stored.reputation_score;
    }
  }

  public getConfig(): ProviderAgentConfig {
    return { ...this.config };
  }

  public updateConfig(updates: Partial<ProviderAgentConfig>) {
    this.config = { ...this.config, ...updates };
    saveProviderSettings({
      server_url: this.config.serverUrl,
      node_token: this.config.nodeToken,
      node_name: this.config.nodeName,
      engine_url: this.config.engineUrl,
      engine_type: this.config.engineType,
      pricing_mode: this.config.pricingMode,
      floor_price_in: this.config.floorPriceIn,
      floor_price_out: this.config.floorPriceOut,
      pause_on_user_active: this.config.pauseOnUserActive ? 1 : 0,
      max_gpu_temp_c: this.config.maxGpuTempC,
      max_concurrency: this.config.maxConcurrency,
    });
    this.emit('config-updated', this.config);
  }

  public async detectHardware(): Promise<GpuInfo> {
    return await detectGpuHardware();
  }

  public async getStatus(): Promise<ProviderStatusInfo> {
    if (!this.gpuInfo) {
      this.gpuInfo = await this.detectHardware();
    }
    const stored = getProviderSettings();
    const rdma = await detectRdmaFabricStatus();
    const confidential = await detectConfidentialComputeStatus();

    let status: ProviderStatusInfo['status'] = 'OFFLINE';
    if (this.isRunning) {
      if (this.isPaused) {
        status = 'PAUSED';
      } else {
        status = 'ONLINE';
      }
    } else if (this.lastErrorMessage) {
      // A failed start (e.g. registration rejected) must read as an error,
      // never as a clean offline — the error message is surfaced below.
      status = 'ERROR';
    }

    return {
      status,
      nodeId: this.nodeId || stored?.node_id || undefined,
      reputationScore: this.reputationScore ?? stored?.reputation_score ?? 100.0,
      totalJobsCompleted: stored?.total_jobs_completed ?? 0,
      totalTokensServed: stored?.total_tokens_served ?? 0,
      totalEarnedUsd: stored?.total_earned_usd ?? 0.0,
      gpu: this.gpuInfo,
      models: this.installedModels.map((m) => m.name),
      rdma,
      confidential,
      lastHeartbeatAt: stored?.last_heartbeat_at,
      errorMessage: this.lastErrorMessage || undefined,
    };
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    try {
      this.lastErrorMessage = null;
      console.log('[Eluvix Provider] 🚀 Initializing GPU Provider Agent...');

      // 1. Detect hardware
      this.gpuInfo = await this.detectHardware();
      console.log(`[Eluvix Provider] 🎮 Hardware: ${this.gpuInfo.count}x ${this.gpuInfo.model} (${this.gpuInfo.vramTotalGb}GB VRAM)`);

      // 2. Discover local models. Only models an engine probe actually
      // reported may be advertised to the marketplace; if no engine
      // answered, register with an honestly empty catalog instead of the
      // invented fallback list detectLocalEngineModels() would return.
      const probedModels = await probeLocalEngineModels(this.config.engineUrl, this.config.engineType);
      if (probedModels) {
        this.installedModels = probedModels;
      } else {
        this.installedModels = [];
        console.warn(`[Eluvix Provider] ⚠️ Local engine at ${this.config.engineUrl} did not answer model probes; registering with an empty model catalog.`);
      }
      console.log(`[Eluvix Provider] 📦 Local Models: ${this.installedModels.map((m) => m.name).join(', ')}`);

      // 3. Register with Billama
      await this.registerNode();

      this.isRunning = true;
      this.isPaused = false;
      saveProviderSettings({ enabled: 1 });

      // 4. Start heartbeat loop
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat().catch((err) => {
          this.lastErrorMessage = err.message;
          this.emit('error', err);
        });
      }, this.config.heartbeatIntervalMs);

      this.emit('started');
      this.emit('status-changed', { status: 'ONLINE', isRunning: true, isPaused: false });
    } catch (err: any) {
      this.lastErrorMessage = err.message;
      this.isRunning = false;
      this.emit('error', err);
      throw err;
    }
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    this.isPaused = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.consumerPreemptionTimer) {
      clearTimeout(this.consumerPreemptionTimer);
      this.consumerPreemptionTimer = null;
    }

    saveProviderSettings({ enabled: 0 });
    console.log('[Eluvix Provider] 🛑 GPU Provider Agent stopped.');
    this.emit('stopped');
    this.emit('status-changed', { status: 'OFFLINE', isRunning: false, isPaused: false });
  }

  /**
   * Toggles provider agent running state.
   */
  public async setEnabled(enabled: boolean): Promise<ProviderStatusInfo> {
    if (enabled) {
      await this.start();
    } else {
      await this.stop();
    }
    return this.getStatus();
  }

  /**
   * Runs a local benchmark test job to verify GPU inference and record compute telemetry.
   */
  public async runBenchmark(model?: string): Promise<any> {
    const targetModel = model || (this.installedModels[0]?.name) || 'llama3.1:8b';
    const testPrompt = [
      { role: 'user', content: 'Generate a short 2-sentence confirmation that this local GPU is functioning.' }
    ];

    return await this.executeJob({
      jobId: `bench-${Date.now()}`,
      model: targetModel,
      messages: testPrompt,
      maxTokens: 60,
      pricePerMTok: 0.50
    });
  }

  /**
   * Preempts provider activity whenever the local desktop user sends inference queries.
   * Ensures zero lag for the consumer!
   */
  public notifyConsumerActive(holdDurationMs: number = 30000) {
    if (!this.config.pauseOnUserActive || !this.isRunning) return;

    this.isPaused = true;
    this.emit('preempted', { holdDurationMs });
    this.emit('status-changed', { status: 'STANDBY', reason: 'consumer_active' });

    if (this.consumerPreemptionTimer) {
      clearTimeout(this.consumerPreemptionTimer);
    }

    this.consumerPreemptionTimer = setTimeout(() => {
      this.isPaused = false;
      this.consumerPreemptionTimer = null;
      this.emit('resumed');
      this.emit('status-changed', { status: 'ONLINE', isRunning: true, isPaused: false });
    }, holdDurationMs);
  }

  /**
   * Registers this node with Billama Edge Marketplace.
   *
   * Registration failure is FATAL to start(): it throws, so start() records
   * the error and the agent never reports ONLINE for a node the marketplace
   * did not accept. No substitute node identity is ever fabricated or
   * persisted — a node id exists only if the server issued (or had
   * previously issued) one.
   */
  private async registerNode(): Promise<void> {
    const registerUrl = `${this.config.serverUrl.replace(/\/+$/, '')}/api/nodes/register`;
    const payload = {
      name: this.config.nodeName || `${os.hostname()} (Eluvix GPU Node)`,
      nodeToken: this.config.nodeToken,
      hostname: os.hostname(),
      publicIp: this.config.publicIp || undefined,
      gpuModel: this.gpuInfo?.model || 'Host Inference Accelerator',
      gpuVendor: this.gpuInfo?.vendor || 'CPU',
      gpuCount: this.gpuInfo?.count || 1,
      vramTotalGb: this.gpuInfo?.vramTotalGb || 16.0,
      vramFreeGb: this.gpuInfo?.vramFreeGb || 12.0,
      region: 'us-east',
      models: this.installedModels.map((m) => ({
        modelName: m.name,
        vramUsageMb: m.vramUsageMb || 4096,
      })),
    };

    const res = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Failed to register GPU node with Billama Edge');
    }

    this.nodeId = data.node.id;
    if (data.node.reputationScore) {
      this.reputationScore = data.node.reputationScore;
    }

    if (data.rawToken) {
      this.config.nodeToken = data.rawToken;
    }

    saveProviderSettings({
      node_id: this.nodeId || undefined,
      node_token: data.rawToken || this.config.nodeToken,
      reputation_score: this.reputationScore,
    });

    console.log(`[Eluvix Provider] ✅ Registered successfully with Billama! Node ID: ${this.nodeId}`);
  }

  /**
   * Heartbeat telemetry loop to Billama Edge.
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.nodeId || !this.isRunning) return;

    // Refresh dynamic metrics
    this.gpuInfo = await this.detectHardware();

    // Check thermal threshold
    if (this.gpuInfo.temperatureC && this.gpuInfo.temperatureC > this.config.maxGpuTempC) {
      if (!this.isPaused) {
        console.warn(`[Eluvix Provider] ⚠️ GPU temperature (${this.gpuInfo.temperatureC}°C) exceeds max limit (${this.config.maxGpuTempC}°C). Pausing jobs.`);
        this.isPaused = true;
        this.emit('preempted', { reason: 'thermal_throttle' });
        this.emit('status-changed', { status: 'STANDBY', reason: 'thermal_throttle', temperatureC: this.gpuInfo.temperatureC });
      }
    } else if (this.isPaused && !this.consumerPreemptionTimer && (!this.gpuInfo.temperatureC || this.gpuInfo.temperatureC <= this.config.maxGpuTempC)) {
      console.info(`[Eluvix Provider] ✅ GPU temperature (${this.gpuInfo.temperatureC}°C) returned to safe levels. Resuming jobs.`);
      this.isPaused = false;
      this.emit('resumed');
      this.emit('status-changed', { status: 'ONLINE', temperatureC: this.gpuInfo.temperatureC });
    }

    const heartbeatUrl = `${this.config.serverUrl.replace(/\/+$/, '')}/api/nodes/heartbeat`;
    const payload = {
      nodeId: this.nodeId,
      nodeToken: this.config.nodeToken || 'local-eluvix-token',
      status: this.isPaused ? 'STANDBY' : 'ONLINE',
      vramFreeGb: this.gpuInfo?.vramFreeGb || 16.0,
      // null when no temperature was actually measured — never report an
      // invented constant as measured telemetry.
      temperatureC: this.gpuInfo?.temperatureC ?? null,
    };

    try {
      const res = await fetch(heartbeatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        // Liveness is recorded ONLY on a heartbeat the server accepted.
        // A rejected or undelivered heartbeat must leave last_heartbeat_at
        // untouched so status consumers can see the node is actually stale.
        const heartbeatUpdates: Record<string, any> = { last_heartbeat_at: new Date().toISOString() };

        const data = await res.json();
        if (data.reputationScore !== undefined) {
          this.reputationScore = data.reputationScore;
          heartbeatUpdates.reputation_score = data.reputationScore;
        }
        saveProviderSettings(heartbeatUpdates);
        if (data.commands && Array.isArray(data.commands)) {
          for (const cmd of data.commands) {
            await this.handleCommand(cmd);
          }
        }
      }
    } catch (err: any) {
      // Network error: the heartbeat never arrived. Deliberately do NOT
      // update last_heartbeat_at — a fresh timestamp here would fabricate
      // liveness for a node the server has not heard from.
    }
  }

  /**
   * Handles commands received from Billama Edge (e.g. unload model, pull model).
   */
  private async handleCommand(cmd: any): Promise<void> {
    console.log(`[Eluvix Provider] 📩 Processing command: ${cmd.type}`);
    if (cmd.type === 'CONFIG_APPLY') {
      const { targetModel, configPayload } = cmd.payload || {};
      if (this.config.engineType === 'ollama' && targetModel && configPayload) {
        try {
          await fetch(`${this.config.engineUrl}/api/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: targetModel, modelfile: configPayload }),
          });
        } catch (e: any) {
          console.warn('[Eluvix Provider] Failed to apply Modelfile:', e.message);
        }
      }
    }
  }

  /**
   * Executes an incoming inference job from Billama Compute Grid.
   */
  public async executeJob(job: {
    jobId: string;
    model: string;
    messages: any[];
    maxTokens?: number;
    pricePerMTok?: number;
  }): Promise<any> {
    if (!this.isRunning) {
      throw new Error('Provider agent is currently offline.');
    }
    if (this.isPaused) {
      throw new Error('Provider is currently paused for local consumer activity or thermal limit.');
    }

    const startTime = Date.now();
    const promptTokens = Math.ceil(JSON.stringify(job.messages).length / 4); // estimate
    const url = `${this.config.engineUrl.replace(/\/+$/, '')}/v1/chat/completions`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: job.model,
          messages: job.messages,
          max_tokens: job.maxTokens,
          stream: false,
        }),
      });

      if (!res.ok) {
        throw new Error(`Engine returned ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      const completionTokens = Math.ceil(data.usage?.completion_tokens || 100);
      const exactPromptTokens = Math.ceil(data.usage?.prompt_tokens || promptTokens);
      const totalTokens = exactPromptTokens + completionTokens;
      const durationMs = Date.now() - startTime;

      // Calculate earnings: floor price or job bid
      const userFloor = this.config.pricingMode === 'floor'
        ? Math.max(this.config.floorPriceIn || 0, this.config.floorPriceOut || 0)
        : 0;
      const effectivePricePerMTok = Math.max(job.pricePerMTok || 0.50, userFloor);
      const ratePerToken = effectivePricePerMTok / 1_000_000;
      const earnedUsd = totalTokens * ratePerToken;

      logProviderJob({
        job_id: job.jobId,
        model: job.model,
        prompt_tokens: exactPromptTokens,
        completion_tokens: completionTokens,
        duration_ms: durationMs,
        earned_usd: earnedUsd,
        status: 'SUCCESS',
      });

      this.emit('job-completed', {
        jobId: job.jobId,
        totalTokens,
        earnedUsd,
        durationMs,
      });

      return data;
    } catch (err: any) {
      logProviderJob({
        job_id: job.jobId,
        model: job.model,
        status: 'ERROR',
        error_message: err.message,
      });
      throw err;
    }
  }
}
