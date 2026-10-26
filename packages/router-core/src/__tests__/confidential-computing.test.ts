import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  simulateConfidentialEnclave,
  computeReportDataBinding,
  verifyDualAttestationReport,
  ENCLAVE_ARCHITECTURES,
  type HypervisorAttackId,
} from '../tee-attestation.js';
import { Eluvix, isConfidentialEnclaveUpstream, type UpstreamConfig } from '../index.js';

describe('Confidential Computing: AMD SEV-SNP, Intel TDX & NVIDIA CC-Mode Attestation', () => {
  describe('Hardware Threat & Performance Simulator', () => {
    const allAttacks: HypervisorAttackId[] = [
      'host_dram_dump',
      'npt_aliasing',
      'wesee_vc_spoof',
      'pcie_bar1_snoop',
      'rim_firmware_tamper',
    ];

    it('evaluates AMD SEV-SNP + NVIDIA H100 CC-On (SWIOTLB Bounce Buffer) blocking host hypervisor memory/bus attacks', () => {
      const sim = simulateConfidentialEnclave({
        architectureId: 'sev-snp-h100-cc',
        activeAttacks: ['host_dram_dump', 'npt_aliasing', 'wesee_vc_spoof', 'pcie_bar1_snoop'],
        checkpointSizeGb: 70,
      });

      expect(sim.enclavePosture).toBe('ISOLATED');
      expect(sim.kbsKeyRelease).toBe('GRANTED');
      expect(sim.attackEvaluations.filter((a) => a.outcome === 'blocked')).toHaveLength(4);
      expect(sim.attackEvaluations.filter((a) => a.outcome === 'compromised')).toHaveLength(0);

      // SWIOTLB AES-GCM-256 bounce buffer caps effective H2D bandwidth at ~10.2 GB/s (6.9s for 70GB)
      expect(sim.architecture.effectiveH2dBandwidthGBps).toBe(10.2);
      expect(sim.coldH2dTransferSeconds).toBeCloseTo(6.9, 1);
      // Single-GPU decode tok/s is 94.5% of baseline (74.1 tok/s vs 78.4 tok/s)
      expect(sim.inferenceThroughputPct).toBe(94.5);
      expect(sim.shortPromptTokPerSec).toBe(74.1);
      expect(sim.multiGpuAllReducePct).toBe(81.4);
    });

    it('evaluates Intel TDX + NVIDIA Blackwell B200 TEE-I/O (PCIe Gen6 IDE + Inline NVLink) eliminating bounce buffers', () => {
      const sim = simulateConfidentialEnclave({
        architectureId: 'tdx-b200-tee-io',
        activeAttacks: ['host_dram_dump', 'npt_aliasing', 'wesee_vc_spoof', 'pcie_bar1_snoop'],
        checkpointSizeGb: 70,
      });

      expect(sim.enclavePosture).toBe('ISOLATED');
      expect(sim.kbsKeyRelease).toBe('GRANTED');
      expect(sim.attackEvaluations.filter((a) => a.outcome === 'blocked')).toHaveLength(4);

      // PCIe Gen6 IDE inline encryption reaches ~52.0 GB/s (2.9s cold load for 70GB)
      expect(sim.architecture.effectiveH2dBandwidthGBps).toBe(52.0);
      expect(sim.coldH2dTransferSeconds).toBeCloseTo(2.9, 1);
      expect(sim.inferenceThroughputPct).toBe(98.9);
      expect(sim.multiGpuAllReducePct).toBe(98.6);
    });

    it('triggers ATTESTATION_BLOCKED and denies KBS key release when guest initrd or GPU RIM firmware is tampered', () => {
      const sim = simulateConfidentialEnclave({
        architectureId: 'sev-snp-h100-cc',
        activeAttacks: allAttacks,
        checkpointSizeGb: 70,
      });

      expect(sim.enclavePosture).toBe('ATTESTATION_BLOCKED');
      expect(sim.kbsKeyRelease).toBe('DENIED');

      const rimAttack = sim.attackEvaluations.find((a) => a.id === 'rim_firmware_tamper');
      expect(rimAttack?.outcome).toBe('attestation_aborted');
    });

    it('flags AMD SEV-ES + Standard Passthrough as compromised by NPT aliasing, WeSee #VC spoofing, and BAR1 snooping', () => {
      const sim = simulateConfidentialEnclave({
        architectureId: 'sev-es-passthrough',
        activeAttacks: ['host_dram_dump', 'npt_aliasing', 'wesee_vc_spoof', 'pcie_bar1_snoop'],
        checkpointSizeGb: 70,
      });

      expect(sim.enclavePosture).toBe('COMPROMISED');
      expect(sim.kbsKeyRelease).toBe('DENIED');
      expect(sim.attackEvaluations.filter((a) => a.outcome === 'blocked')).toHaveLength(1); // Only DRAM AES-128 blocked
      expect(sim.attackEvaluations.filter((a) => a.outcome === 'compromised')).toHaveLength(3);
    });
  });

  describe('IETF RATS Dual-Attestation & SHA-512 REPORT_DATA Binding', () => {
    const validLaunchDigest =
      'a8f90c3e4d12b56e789a0bcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef123456';

    it('computes deterministic 128-hex-char SHA-512 REPORT_DATA binding from nonce + ephemeral public key', () => {
      const nonce = '9f86d081884c7d659a2feaa0c55ad015';
      const pubkey = '-----BEGIN PUBLIC KEY-----\nMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE...\n-----END PUBLIC KEY-----';

      const binding1 = computeReportDataBinding(nonce, pubkey);
      const binding2 = computeReportDataBinding(nonce, pubkey);
      const bindingDifferentNonce = computeReportDataBinding('11223344556677889900aabbccddeeff', pubkey);

      expect(binding1).toHaveLength(128);
      expect(binding1).toBe(binding2);
      expect(binding1).not.toBe(bindingDifferentNonce);
    });

    it('grants KBS key release and issues EAT token when CPU SEV-SNP/TDX and GPU SPDM RIM dual evidence pass all checks', () => {
      const nonce = '9f86d081884c7d659a2feaa0c55ad015';
      const pubkey = 'ephemeral-kem-pubkey-secp384r1';
      const reportData = computeReportDataBinding(nonce, pubkey);

      const verdict = verifyDualAttestationReport(
        {
          cpuVendor: 'amd-sev-snp',
          vmpl: 0,
          restrictedInjectionEnabled: true,
          launchMeasurementSha384: validLaunchDigest,
          reportedTcbSvn: { bootloader: 4, tee: 0, snp: 22, microcode: 219 },
          reportDataHex: reportData,
          vcekSignatureValid: true,
          gpuCcStatus: 'ON',
          gpuDevToolsBlocked: true,
          gpuSpdmRimVerified: true,
        },
        {
          expectedMeasurementSha384: validLaunchDigest,
          requireVmplZero: true,
          requireRestrictedInjection: true,
          minTcbMicrocodeSvn: 210,
          requireGpuCcOn: true,
          expectedReportDataHex: reportData,
        }
      );

      expect(verdict.affirming).toBe(true);
      expect(verdict.kbsKeyRelease).toBe('GRANTED');
      expect(verdict.eatTokenIssued).toContain('eyJhbGciOiJFUzM4NCIsInR5cCI6IkVBVCJ9.');
    });

    it('denies KBS key release when VMPL > 0 (paravisor privilege escalation risk)', () => {
      const nonce = '9f86d081884c7d659a2feaa0c55ad015';
      const pubkey = 'ephemeral-kem-pubkey-secp384r1';
      const reportData = computeReportDataBinding(nonce, pubkey);

      const verdict = verifyDualAttestationReport(
        {
          cpuVendor: 'amd-sev-snp',
          vmpl: 1,
          restrictedInjectionEnabled: true,
          launchMeasurementSha384: validLaunchDigest,
          reportedTcbSvn: { bootloader: 4, tee: 0, snp: 22, microcode: 219 },
          reportDataHex: reportData,
          vcekSignatureValid: true,
          gpuCcStatus: 'ON',
          gpuDevToolsBlocked: true,
          gpuSpdmRimVerified: true,
        },
        {
          expectedMeasurementSha384: validLaunchDigest,
          requireVmplZero: true,
        }
      );

      expect(verdict.affirming).toBe(false);
      expect(verdict.kbsKeyRelease).toBe('DENIED');
      expect(verdict.eatTokenIssued).toBeNull();
      expect(verdict.reasons.some((r) => r.includes('VMPL 1'))).toBe(true);
    });

    it('denies KBS key release on tampered GPU SPDM RIM or mismatched REPORT_DATA binding', () => {
      const verdict = verifyDualAttestationReport(
        {
          cpuVendor: 'intel-tdx',
          vmpl: 0,
          restrictedInjectionEnabled: true,
          launchMeasurementSha384: validLaunchDigest,
          reportedTcbSvn: { bootloader: 4, tee: 0, snp: 22, microcode: 219 },
          reportDataHex: 'forged-report-data-hex',
          vcekSignatureValid: true,
          gpuCcStatus: 'PPCIE',
          gpuDevToolsBlocked: true,
          gpuSpdmRimVerified: false,
        },
        {
          expectedMeasurementSha384: validLaunchDigest,
          expectedReportDataHex: 'expected-report-data-hex',
        }
      );

      expect(verdict.affirming).toBe(false);
      expect(verdict.kbsKeyRelease).toBe('DENIED');
      expect(verdict.reasons.some((r) => r.includes('REPORT_DATA'))).toBe(true);
      expect(verdict.reasons.some((r) => r.includes('RIM'))).toBe(true);
    });
  });

  describe('Zero-Trust Confidential Enclave Routing & Fail-Closed Enforcement', () => {
    let fetchSpy: any;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-tee-test',
            object: 'chat.completion',
            created: Date.now(),
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Confidential enclave response' },
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      });
    });

    afterEach(() => {
      fetchSpy?.mockRestore();
    });

    it('correctly identifies hardware-attested TEE upstreams via isConfidentialEnclaveUpstream()', () => {
      const dualAttestedUpstream: UpstreamConfig = {
        id: 'vllm-h100-cc',
        name: 'vLLM H100 CC Enclave',
        type: 'vllm',
        endpoint: 'http://enclave.local:8000',
        priority: 30,
        models: ['*'],
        confidential: {
          enabled: true,
          architecture: 'sev-snp-h100-cc',
          cpuTee: 'amd-sev-snp',
          gpuTee: 'h100-cc-on',
          restrictedInjection: true,
          vmpl: 0,
          spdmAttested: true,
        },
      };

      const plaintextUpstream: UpstreamConfig = {
        id: 'vllm-plaintext',
        name: 'vLLM Plaintext KVM',
        type: 'vllm',
        endpoint: 'http://plaintext.local:8001',
        priority: 20,
        models: ['*'],
      };

      expect(isConfidentialEnclaveUpstream(dualAttestedUpstream, 'require-dual-attestation')).toBe(true);
      expect(isConfidentialEnclaveUpstream(plaintextUpstream, 'require-tee')).toBe(false);
    });

    it('filters out non-TEE upstreams and attaches x-eluvix-tee-* headers under require-dual-attestation', async () => {
      const router = new Eluvix({
        upstreams: [
          {
            id: 'vllm-plaintext',
            name: 'Plaintext KVM Worker',
            type: 'vllm',
            endpoint: 'http://plaintext.local:8001',
            priority: 100, // Higher priority, but unattested!
            models: ['*'],
          },
          {
            id: 'vllm-sev-snp-h100',
            name: 'AMD SEV-SNP + H100 CC Enclave',
            type: 'vllm',
            endpoint: 'http://enclave.local:8000',
            priority: 30,
            models: ['*'],
            confidential: {
              enabled: true,
              architecture: 'sev-snp-h100-cc',
              cpuTee: 'amd-sev-snp',
              gpuTee: 'h100-cc-on',
              restrictedInjection: true,
              vmpl: 0,
              spdmAttested: true,
            },
          },
        ],
        switchyard: {
          strategy: 'priority',
          confidentialPolicy: 'require-dual-attestation',
        },
      });

      const response = await router.routeChatCompletion({
        model: 'auto',
        messages: [{ role: 'user', content: 'Process confidential patient genomics record.' }],
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('x-eluvix-upstream')).toBe('vllm-sev-snp-h100');
      expect(response.headers.get('x-eluvix-tee-posture')).toBe('ATTESTED_DUAL_ENCLAVE');
      expect(response.headers.get('x-eluvix-tee-arch')).toBe('sev-snp-h100-cc');
      expect(response.headers.get('x-eluvix-rats-kbs')).toBe('GRANTED');
    });

    it('fails closed with HTTP 503 confidential_enclave_unavailable when require-dual-attestation has no attested enclave', async () => {
      const router = new Eluvix({
        upstreams: [
          {
            id: 'vllm-plaintext',
            name: 'Plaintext KVM Worker',
            type: 'vllm',
            endpoint: 'http://plaintext.local:8001',
            priority: 30,
            models: ['*'],
          },
        ],
        switchyard: {
          strategy: 'priority',
          confidentialPolicy: 'require-dual-attestation',
        },
      });

      const response = await router.routeChatCompletion({
        model: 'auto',
        messages: [{ role: 'user', content: 'Must never leak to plaintext host DRAM.' }],
      });

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.error.type).toBe('confidential_enclave_unavailable');
    });
  });
});
