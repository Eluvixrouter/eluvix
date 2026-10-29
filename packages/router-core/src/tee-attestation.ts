import crypto from 'node:crypto';

// Cached ephemeral P-384 keypair used for signing simulated Entity Attestation Tokens (EAT)
const ephemeralP384Key = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });

/**
 * Zero-Trust Silicon: Confidential Computing with AMD SEV-SNP, Intel TDX,
 * and NVIDIA H100 CC-Mode / Blackwell B200 TEE-I/O Attestation (IETF RATS & Trustee KBS).
 */

export type EnclaveArchitectureId =
  | 'sev-snp-h100-cc'
  | 'tdx-b200-tee-io'
  | 'sev-es-passthrough'
  | 'standard-kvm';

export type HypervisorAttackId =
  | 'host_dram_dump'
  | 'npt_aliasing'
  | 'wesee_vc_spoof'
  | 'pcie_bar1_snoop'
  | 'rim_firmware_tamper';

export interface EnclaveArchitectureProfile {
  id: EnclaveArchitectureId;
  name: string;
  badge: string;
  cpuTee: 'amd-sev-snp' | 'intel-tdx' | 'amd-sev-es' | 'none';
  gpuTee: 'h100-cc-on' | 'b200-tee-io' | 'none';
  dramCipherMode: string;
  pageTableIntegrity: string;
  guestPageAcceptance: string;
  exceptionGuard: string;
  hardwareRootOfTrust: string;
  gpuDmaMode: string;
  effectiveH2dBandwidthGBps: number;
  singleGpuThroughputPct: number;
  longContextTtftOverheadPct: number;
  multiGpuAllReducePct: number;
  spdmSessionInitSeconds: number;
  hasCpuMemoryEncryption: boolean;
  hasRmpOrSeptIntegrity: boolean;
  hasRestrictedInjection: boolean;
  hasGpuBarFirewallAndEncryptedDma: boolean;
  hasHardwareLaunchAttestation: boolean;
}

export const ENCLAVE_ARCHITECTURES: Record<EnclaveArchitectureId, EnclaveArchitectureProfile> = {
  'sev-snp-h100-cc': {
    id: 'sev-snp-h100-cc',
    name: 'AMD SEV-SNP + NVIDIA H100 (CC-On Mode)',
    badge: 'PRODUCTION CVM + GPU',
    cpuTee: 'amd-sev-snp',
    gpuTee: 'h100-cc-on',
    dramCipherMode: 'AES-128/256-XEX (Physical Address Tweak) + C-bit=1',
    pageTableIntegrity: 'Hardware RMP (Reverse Map Table): 16B entry per 4KB SPA',
    guestPageAcceptance: 'PVALIDATE instruction sets Validated bit inside RMP (Ring-0)',
    exceptionGuard: 'Restricted Injection (#HV, vector 28) + ASP-verified CPUID page',
    hardwareRootOfTrust: 'On-die ARM AMD Secure Processor (ARK -> ASK -> VCEK) + H100 GSP',
    gpuDmaMode: 'SWIOTLB Bounce Buffer + H100 Copy Engine AES-GCM-256 over SPDM 1.2',
    effectiveH2dBandwidthGBps: 10.2,
    singleGpuThroughputPct: 94.5,
    longContextTtftOverheadPct: 5.2,
    multiGpuAllReducePct: 81.4,
    spdmSessionInitSeconds: 0.0,
    hasCpuMemoryEncryption: true,
    hasRmpOrSeptIntegrity: true,
    hasRestrictedInjection: true,
    hasGpuBarFirewallAndEncryptedDma: true,
    hasHardwareLaunchAttestation: true,
  },
  'tdx-b200-tee-io': {
    id: 'tdx-b200-tee-io',
    name: 'Intel TDX / SEV-SNP + Blackwell B200 (TEE-I/O + PCIe IDE)',
    badge: 'LINE-RATE TEE-I/O',
    cpuTee: 'intel-tdx',
    gpuTee: 'b200-tee-io',
    dramCipherMode: 'AES-XTS-128/256 + 28-bit SHA-3 MAC in DDR5 ECC bits',
    pageTableIntegrity: 'Secure EPT (S-EPT) managed inside CPU SEAM (TDX Module)',
    guestPageAcceptance: 'TDG.MEM.PAGE.ACCEPT (SEAMCALL) accepts pending pages into TD',
    exceptionGuard: 'SEPT_VE_DISABLE + TDX Module exception filtering & hardened MMIO',
    hardwareRootOfTrust: 'CPU SEAM + SGX Quoting Enclave (Intel PCK) + B200 GSP',
    gpuDmaMode: 'Line-Rate PCIe Gen6 IDE / TDISP + Inline Encrypted 5th-Gen NVLink (1.8 TB/s)',
    effectiveH2dBandwidthGBps: 52.0,
    singleGpuThroughputPct: 98.9,
    longContextTtftOverheadPct: 1.0,
    multiGpuAllReducePct: 98.6,
    spdmSessionInitSeconds: 1.55,
    hasCpuMemoryEncryption: true,
    hasRmpOrSeptIntegrity: true,
    hasRestrictedInjection: true,
    hasGpuBarFirewallAndEncryptedDma: true,
    hasHardwareLaunchAttestation: true,
  },
  'sev-es-passthrough': {
    id: 'sev-es-passthrough',
    name: 'First-Gen AMD SEV-ES + Standard GPU Passthrough',
    badge: 'NO RMP / GPU EXPOSED',
    cpuTee: 'amd-sev-es',
    gpuTee: 'none',
    dramCipherMode: 'AES-128 DRAM + VMSA Register Encryption (No Integrity Tree)',
    pageTableIntegrity: 'None (Untrusted KVM controls Nested Page Tables GPA -> SPA)',
    guestPageAcceptance: 'None (No PVALIDATE; hypervisor can remap or alias pages)',
    exceptionGuard: 'Unrestricted #VC (vector 29) — vulnerable to WeSee / Ahoi injection',
    hardwareRootOfTrust: 'AMD SP (Legacy SEV-ES without VCEK SNP RMP enforcement)',
    gpuDmaMode: 'Unencrypted PCIe Passthrough (Plaintext BAR1 aperture)',
    effectiveH2dBandwidthGBps: 26.5,
    singleGpuThroughputPct: 98.0,
    longContextTtftOverheadPct: 1.5,
    multiGpuAllReducePct: 99.0,
    spdmSessionInitSeconds: 0.0,
    hasCpuMemoryEncryption: true,
    hasRmpOrSeptIntegrity: false,
    hasRestrictedInjection: false,
    hasGpuBarFirewallAndEncryptedDma: false,
    hasHardwareLaunchAttestation: false,
  },
  'standard-kvm': {
    id: 'standard-kvm',
    name: 'Standard KVM / QEMU VM (No Confidential Computing)',
    badge: 'PLAINTEXT SILICON',
    cpuTee: 'none',
    gpuTee: 'none',
    dramCipherMode: 'Plaintext DDR5 RAM (Readable via host /dev/mem)',
    pageTableIntegrity: 'Host KVM EPT / NPT (Full host root inspection & remapping)',
    guestPageAcceptance: 'None',
    exceptionGuard: 'None (Full hypervisor interrupt & register access)',
    hardwareRootOfTrust: 'None (Host hypervisor & BMC sit at apex of trust)',
    gpuDmaMode: 'Plaintext PCIe DMA (Host can mmap() GPU HBM3 via BAR1)',
    effectiveH2dBandwidthGBps: 27.0,
    singleGpuThroughputPct: 100.0,
    longContextTtftOverheadPct: 0.0,
    multiGpuAllReducePct: 100.0,
    spdmSessionInitSeconds: 0.0,
    hasCpuMemoryEncryption: false,
    hasRmpOrSeptIntegrity: false,
    hasRestrictedInjection: false,
    hasGpuBarFirewallAndEncryptedDma: false,
    hasHardwareLaunchAttestation: false,
  },
};

export interface AttackEvaluation {
  id: HypervisorAttackId;
  name: string;
  active: boolean;
  outcome: 'blocked' | 'compromised' | 'attestation_aborted' | 'inactive';
  mechanism: string;
}

export interface ConfidentialEnclaveSimulationResult {
  architecture: EnclaveArchitectureProfile;
  checkpointSizeGb: number;
  coldH2dTransferSeconds: number;
  inferenceThroughputPct: number;
  shortPromptTokPerSec: number;
  longContext16kTtftMs: number;
  multiGpuAllReducePct: number;
  enclavePosture: 'ISOLATED' | 'ATTESTATION_BLOCKED' | 'COMPROMISED';
  kbsKeyRelease: 'GRANTED' | 'DENIED';
  summaryMessage: string;
  attackEvaluations: AttackEvaluation[];
}

/**
 * Simulates confidential enclave hardware defenses, PCIe H2D transfer physics,
 * and Trustee KBS (IETF RATS) key-release policy under adversarial host attacks.
 */
export function simulateConfidentialEnclave(params: {
  architectureId: EnclaveArchitectureId;
  activeAttacks?: HypervisorAttackId[];
  checkpointSizeGb?: number;
}): ConfidentialEnclaveSimulationResult {
  const arch = ENCLAVE_ARCHITECTURES[params.architectureId] || ENCLAVE_ARCHITECTURES['sev-snp-h100-cc'];
  const activeSet = new Set<HypervisorAttackId>(params.activeAttacks || []);
  const checkpointSizeGb = Math.max(1, params.checkpointSizeGb ?? 70);

  // Baseline Llama-3.3-70B FP8 metrics from article:
  // Standard KVM: 78.4 tok/s, 1420ms 16K TTFT, 2.6s 70GB load
  // H100 CC-On: 74.1 tok/s (-5.5%), 1495ms 16K TTFT (+5.2%), 6.8s 70GB load
  // B200 TEE-I/O: 77.5 tok/s (-1.1%), 1435ms 16K TTFT (+1.0%), 2.9s 70GB load
  const coldH2dTransferSeconds = Number(
    (checkpointSizeGb / arch.effectiveH2dBandwidthGBps + arch.spdmSessionInitSeconds).toFixed(1)
  );
  const shortPromptTokPerSec = Number(((78.4 * arch.singleGpuThroughputPct) / 100).toFixed(1));
  const longContext16kTtftMs = Math.round(1420 * (1 + arch.longContextTtftOverheadPct / 100));

  const attackDefinitions: Array<{
    id: HypervisorAttackId;
    name: string;
    evaluate: () => { outcome: AttackEvaluation['outcome']; mechanism: string };
  }> = [
    {
      id: 'host_dram_dump',
      name: '1. Host Root `/dev/mem` & Cold-Boot DRAM Dump',
      evaluate: () => {
        if (arch.hasCpuMemoryEncryption) {
          return {
            outcome: 'blocked',
            mechanism: `${arch.dramCipherMode} returns indecipherable ciphertext to host /dev/mem reads.`,
          };
        }
        return {
          outcome: 'compromised',
          mechanism: 'Plaintext guest DRAM exposed! Host root dumped model weights and user prompts via /dev/mem.',
        };
      },
    },
    {
      id: 'npt_aliasing',
      name: '2. Nested Page Table (`GPA -> SPA`) Aliasing / Replay',
      evaluate: () => {
        if (arch.hasRmpOrSeptIntegrity) {
          return {
            outcome: 'blocked',
            mechanism:
              arch.cpuTee === 'amd-sev-snp'
                ? 'Hardware RMP detected GPA_2 -> SPA_1 ownership mismatch and aborted access with #PF (RMP Violation).'
                : 'CPU SEAM Secure-EPT (S-EPT) and 28-bit ECC MAC blocked hypervisor page remapping.',
          };
        }
        return {
          outcome: 'compromised',
          mechanism: 'No RMP/S-EPT integrity! Compromised KVM aliased two GPAs to the same SPA and replayed ciphertext.',
        };
      },
    },
    {
      id: 'wesee_vc_spoof',
      name: '3. Spoofed `#VC` / `#VE` Exception Injection (`WeSee`)',
      evaluate: () => {
        if (arch.hasRestrictedInjection) {
          return {
            outcome: 'blocked',
            mechanism:
              arch.cpuTee === 'amd-sev-snp'
                ? 'Restricted Injection (VMSA.SEV_FEATURES[3]=1) blocked vector 29 (#VC); only doorbell #HV (vector 28) allowed.'
                : 'SEPT_VE_DISABLE and TDX Module exception filtering blocked forged #VE interrupts.',
          };
        }
        return {
          outcome: 'compromised',
          mechanism: 'WeSee attack succeeded! Hypervisor injected fake #VC interrupt and leaked guest GHCB registers.',
        };
      },
    },
    {
      id: 'pcie_bar1_snoop',
      name: '4. PCIe Root Complex / GPU `BAR1 mmap()` Snoop',
      evaluate: () => {
        if (arch.hasGpuBarFirewallAndEncryptedDma) {
          return {
            outcome: 'blocked',
            mechanism: `${arch.gpuDmaMode} + GSP BAR1 MMU Firewall blocked host mmap() and PCIe analyzer snooping.`,
          };
        }
        return {
          outcome: 'compromised',
          mechanism: 'GPU BAR1 exposed! Adversary snooped plaintext weights and token IDs across PCIe root complex.',
        };
      },
    },
    {
      id: 'rim_firmware_tamper',
      name: '5. Tamper with Guest Initrd / GPU GSP Firmware (`RIM`)',
      evaluate: () => {
        if (arch.hasHardwareLaunchAttestation) {
          return {
            outcome: 'attestation_aborted',
            mechanism:
              'SHA-384 Launch Measurement (MEASUREMENT/MRTD) & NVIDIA SPDM RIM digest mismatch detected! Trustee KBS aborted key release.',
          };
        }
        return {
          outcome: 'compromised',
          mechanism: 'No hardware remote attestation! Backdoored initramfs booted and exfiltrated model weights.',
        };
      },
    },
  ];

  let anyCompromised = false;
  let anyAttestationAborted = false;

  const attackEvaluations: AttackEvaluation[] = attackDefinitions.map((def) => {
    const isActive = activeSet.has(def.id);
    if (!isActive) {
      return {
        id: def.id,
        name: def.name,
        active: false,
        outcome: 'inactive',
        mechanism: 'Attack vector not injected.',
      };
    }
    const res = def.evaluate();
    if (res.outcome === 'compromised') anyCompromised = true;
    if (res.outcome === 'attestation_aborted') anyAttestationAborted = true;
    return {
      id: def.id,
      name: def.name,
      active: true,
      outcome: res.outcome,
      mechanism: res.mechanism,
    };
  });

  // Trustee KBS only releases the decryption key if the architecture actually supports
  // hardware launch attestation (SEV-SNP/TDX + H100/B200) AND no firmware/initrd tamper
  // invalidated the SHA-384 MEASUREMENT / RIM digests AND the enclave isn't compromised.
  let enclavePosture: ConfidentialEnclaveSimulationResult['enclavePosture'] = 'ISOLATED';
  let kbsKeyRelease: ConfidentialEnclaveSimulationResult['kbsKeyRelease'] = 'GRANTED';
  let summaryMessage =
    'All host hypervisor attacks neutralized: RMP/S-EPT blocked page remapping (#PF), Restricted Injection blocked fake #VC, and SPDM AES-GCM-256 / PCIe IDE protected all GPU H2D/D2H transfers.';

  if (anyCompromised || !arch.hasHardwareLaunchAttestation) {
    enclavePosture = anyCompromised ? 'COMPROMISED' : 'ATTESTATION_BLOCKED';
    kbsKeyRelease = 'DENIED';
    summaryMessage = anyCompromised
      ? 'CRITICAL BREACH: Enclave memory or PCIe bus compromised by untrusted host hypervisor. Trustee KBS revoked model key.'
      : 'UNATTESTED SILICON: Target node lacks dual CPU + GPU hardware roots of trust (SEV-SNP/TDX + H100/B200 CC). Trustee KBS refused key release.';
  } else if (anyAttestationAborted) {
    enclavePosture = 'ATTESTATION_BLOCKED';
    kbsKeyRelease = 'DENIED';
    summaryMessage =
      'ZERO-TRUST DEFENSE TRIGGERED: Modified initrd or GPU GSP firmware caused SHA-384 LAUNCH_MEASUREMENT / RIM verification failure. Trustee KBS refused to unseal the 70B model key!';
  }

  return {
    architecture: arch,
    checkpointSizeGb,
    coldH2dTransferSeconds,
    inferenceThroughputPct: arch.singleGpuThroughputPct,
    shortPromptTokPerSec,
    longContext16kTtftMs,
    multiGpuAllReducePct: arch.multiGpuAllReducePct,
    enclavePosture,
    kbsKeyRelease,
    summaryMessage,
    attackEvaluations,
  };
}

/**
 * Computes the 64-byte cryptographic binding digest (`REPORT_DATA`) over a
 * remote Trustee KBS challenge nonce and the enclave's ephemeral public key:
 *   REPORT_DATA = SHA512(nonce || ephemeral_pubkey)
 */
export function computeReportDataBinding(kbsNonceHex: string, ephemeralPubkeyPem: string): string {
  const cleanHex = (kbsNonceHex || '').trim().replace(/^0x/i, '');
  if (!cleanHex || !/^[0-9a-fA-F]+$/.test(cleanHex) || cleanHex.length % 2 !== 0) {
    throw new Error(`Invalid KBS challenge nonce hex: ${kbsNonceHex}`);
  }
  const hash = crypto.createHash('sha512');
  hash.update(Buffer.from(cleanHex, 'hex'));
  hash.update(Buffer.from(ephemeralPubkeyPem, 'utf8'));
  return hash.digest('hex');
}

export interface DualAttestationEvidence {
  cpuVendor: 'amd-sev-snp' | 'intel-tdx';
  vmpl: number;
  restrictedInjectionEnabled: boolean;
  launchMeasurementSha384: string;
  reportedTcbSvn: {
    bootloader: number;
    tee: number;
    snp: number;
    microcode: number;
  };
  reportDataHex: string;
  vcekSignatureValid: boolean;
  gpuCcStatus: 'ON' | 'PPCIE' | 'OFF';
  gpuDevToolsBlocked: boolean;
  gpuSpdmRimVerified: boolean;
}

export interface AttestationPolicy {
  expectedMeasurementSha384?: string;
  requireVmplZero?: boolean;
  requireRestrictedInjection?: boolean;
  minTcbMicrocodeSvn?: number;
  requireGpuCcOn?: boolean;
  expectedReportDataHex?: string;
}

export interface DualAttestationVerdict {
  affirming: boolean;
  kbsKeyRelease: 'GRANTED' | 'DENIED';
  eatTokenIssued: string | null;
  reasons: string[];
}

/**
 * Evaluates dual CPU (AMD SEV-SNP / Intel TDX) + GPU (NVIDIA H100 / B200 SPDM 1.2)
 * attestation evidence against a relying-party policy (IETF RATS RFC 9334).
 */
export function verifyDualAttestationReport(
  evidence: DualAttestationEvidence,
  policy: AttestationPolicy = {}
): DualAttestationVerdict {
  const reasons: string[] = [];

  if (!evidence.vcekSignatureValid) {
    reasons.push('CPU hardware signature (AMD ARK->ASK->VCEK / Intel PCK) verification failed');
  }
  if ((policy.requireVmplZero ?? true) && evidence.vmpl !== 0) {
    reasons.push(`Attestation report generated at VMPL ${evidence.vmpl}; policy requires inner-ring VMPL 0`);
  }
  if ((policy.requireRestrictedInjection ?? true) && !evidence.restrictedInjectionEnabled) {
    reasons.push('Restricted Injection (#HV) is disabled; guest is vulnerable to WeSee #VC spoofing');
  }
  if (
    policy.expectedMeasurementSha384 &&
    evidence.launchMeasurementSha384.toLowerCase() !== policy.expectedMeasurementSha384.toLowerCase()
  ) {
    reasons.push('Launch Measurement (SHA-384 OVMF + Kernel + Initrd) does not match signed reference policy');
  }
  if (
    policy.minTcbMicrocodeSvn !== undefined &&
    evidence.reportedTcbSvn.microcode < policy.minTcbMicrocodeSvn
  ) {
    reasons.push(
      `CPU Microcode SVN (${evidence.reportedTcbSvn.microcode}) is below minimum required (${policy.minTcbMicrocodeSvn})`
    );
  }
  if (
    policy.expectedReportDataHex &&
    evidence.reportDataHex.toLowerCase() !== policy.expectedReportDataHex.toLowerCase()
  ) {
    reasons.push('REPORT_DATA binding mismatch (replay or MITM detected on KBS challenge nonce)');
  }
  if ((policy.requireGpuCcOn ?? true) && evidence.gpuCcStatus === 'OFF') {
    reasons.push('GPU Confidential Computing mode is OFF (PCIe BAR1 exposed)');
  }
  if ((policy.requireGpuCcOn ?? true) && !evidence.gpuDevToolsBlocked) {
    reasons.push('GPU DevTools / JTAG performance counters are not hardware-blocked');
  }
  if ((policy.requireGpuCcOn ?? true) && !evidence.gpuSpdmRimVerified) {
    reasons.push('GPU SPDM 1.2 Certificate Chain or VBIOS/GSP Reference Integrity Manifest (RIM) verification failed');
  }

  const affirming = reasons.length === 0;
  let eatTokenIssued: string | null = null;

  if (affirming) {
    const header = Buffer.from(
      JSON.stringify({ alg: 'ES384', typ: 'EAT' })
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'eluvix-rats-verifier',
        sub: `${evidence.cpuVendor}+gpu-${evidence.gpuCcStatus.toLowerCase()}`,
        eat_profile: 'urn:ietf:rfc:9334',
        vmpl: evidence.vmpl,
        meas: evidence.launchMeasurementSha384.slice(0, 32),
        gpu_rim: true,
        simulatedSiliconRoot: true,
        attestationMode: 'simulated-ephemeral-p384',
        iat: Math.floor(Date.now() / 1000),
      })
    ).toString('base64url');
    const signable = `${header}.${payload}`;
    const sig = crypto.sign('sha384', Buffer.from(signable), ephemeralP384Key.privateKey);
    eatTokenIssued = `${signable}.${sig.toString('base64url')}`;
  }

  return {
    affirming,
    kbsKeyRelease: affirming ? 'GRANTED' : 'DENIED',
    eatTokenIssued,
    reasons: affirming
      ? ['Dual CPU + GPU hardware roots of trust verified; Trustee KBS unsealing AES-256-GCM model key']
      : reasons,
  };
}
