import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  estimateKvCacheFootprint,
  estimateRawNetworkTransferMs,
  calculateRooflineRidgePoint,
  simulateDisaggregatedRdma,
} from '../kv-math.js';
import { Eluvix, computeKvPrefixHash } from '../index.js';

describe('Disaggregated LLM Serving & KV Cache Mathematics', () => {
  describe('KV Cache Footprint & MLA Compression Ratio', () => {
    it('calculates exact GQA KV cache footprint for Llama-3.3-70B in FP8 and BF16', () => {
      // 80 layers, 8 kv heads, head_dim 128 -> 2 * 80 * 8 * 128 = 163,840 bytes/tok in FP8
      const fp8Footprint = estimateKvCacheFootprint({
        modelArch: 'llama-3.3-70b',
        kvPrecision: 'fp8',
        tokens: 4096,
      });

      expect(fp8Footprint.bytesPerToken).toBe(163840);
      expect(fp8Footprint.kibPerToken).toBe(160);
      expect(fp8Footprint.totalMiB).toBe(640);
      expect(fp8Footprint.mlaCompressionRatio).toBe(1.0);

      // In BF16 (2 bytes per element), footprint doubles to 320 KiB/tok
      const bf16Footprint = estimateKvCacheFootprint({
        modelArch: 'llama-3.3-70b',
        kvPrecision: 'bf16',
        tokens: 4096,
      });

      expect(bf16Footprint.bytesPerToken).toBe(327680);
      expect(bf16Footprint.kibPerToken).toBe(320);
      expect(bf16Footprint.totalMiB).toBe(1280);
    });

    it('calculates DeepSeek-V3/R1 Multi-Head Latent Attention (MLA) footprint with ~4.66x compression', () => {
      // 61 layers, kv_lora_rank 512 + qk_rope 64 = 576 elements/layer -> 61 * 576 = 35,136 bytes/tok in FP8
      const fp8Mla = estimateKvCacheFootprint({
        modelArch: 'deepseek-v3',
        kvPrecision: 'fp8',
        tokens: 4096,
      });

      expect(fp8Mla.bytesPerToken).toBe(35136);
      expect(fp8Mla.kibPerToken).toBeCloseTo(34.31, 1);
      expect(fp8Mla.totalMiB).toBeCloseTo(137.25, 1);
      // Compression ratio vs GQA-8 (160 KiB / 34.31 KiB) is ~4.66x
      expect(fp8Mla.mlaCompressionRatio).toBeCloseTo(4.66, 1);
    });

    it('calculates Llama-3.1-8B footprint', () => {
      // 32 layers, 8 kv heads, head_dim 128 -> 2 * 32 * 8 * 128 = 65,536 bytes/tok in FP8 (64 KiB/tok)
      const fp88b = estimateKvCacheFootprint({
        modelArch: 'llama-3.1-8b',
        kvPrecision: 'fp8',
        tokens: 2048,
      });

      expect(fp88b.bytesPerToken).toBe(65536);
      expect(fp88b.kibPerToken).toBe(64);
      expect(fp88b.totalMiB).toBe(128);
    });
  });

  describe('RDMA / RoCEv2 Wire Transfer Duration', () => {
    it('computes raw transfer duration across 100G, 200G, 400G, and 800G fabrics', () => {
      const bytes = 625 * 1024 * 1024; // 625 MiB (~655.36 MB)

      const time100G = estimateRawNetworkTransferMs(bytes, 100);
      const time200G = estimateRawNetworkTransferMs(bytes, 200);
      const time400G = estimateRawNetworkTransferMs(bytes, 400);
      const time800G = estimateRawNetworkTransferMs(bytes, 800);

      // Higher bandwidth yields proportional lower transfer latency
      expect(time100G).toBeCloseTo(time200G * 2, 0);
      expect(time200G).toBeCloseTo(time400G * 2, 0);
      expect(time400G).toBeCloseTo(time800G * 2, 0);

      // On 400Gbps (50 GB/s wire), 655MB takes ~13.1ms raw wire time
      expect(time400G).toBeGreaterThan(10);
      expect(time400G).toBeLessThan(16);
    });
  });

  describe('Hardware Roofline Model Ridge Point', () => {
    it('calculates H100 SXM5 FP8 dense ridge point as 295.3 FLOPs/Byte', () => {
      const h100Roofline = calculateRooflineRidgePoint('h100-sxm5', 'fp8');
      expect(h100Roofline.peakTflops).toBe(989.4);
      expect(h100Roofline.memoryBandwidthTBps).toBe(3.35);
      expect(h100Roofline.ridgePointFlopsPerByte).toBe(295.3);

      // Decode is memory-bound (intensity ~16-32 FLOPs/B < 295.3)
      const decodeIntensity = 20;
      expect(decodeIntensity < h100Roofline.ridgePointFlopsPerByte).toBe(true);

      // Prefill with 4k prompt is compute-bound (intensity > 2,000 FLOPs/B > 295.3)
      const prefillIntensity = 4096;
      expect(prefillIntensity > h100Roofline.ridgePointFlopsPerByte).toBe(true);
    });

    it('calculates A100 SXM4 FP16 ridge point as 156.4 FLOPs/Byte', () => {
      const a100Roofline = calculateRooflineRidgePoint('a100-sxm4', 'fp16');
      expect(a100Roofline.peakTflops).toBe(312.0);
      expect(a100Roofline.memoryBandwidthTBps).toBe(2.0);
      expect(a100Roofline.ridgePointFlopsPerByte).toBe(156.0);
    });
  });

  describe('Pipelined NIXL / Mooncake RDMA Simulation', () => {
    it('simulates layer-by-layer overlap exposing only ~1-2ms latency for Llama-70B on 400G', () => {
      const sim = simulateDisaggregatedRdma({
        modelArch: 'llama-3.3-70b',
        kvPrecision: 'fp8',
        fabricBandwidthGbps: 400,
        contextTokens: 4096,
        gpuType: 'h100-sxm5',
      });

      expect(sim.overlapPercentage).toBeGreaterThan(90.0);
      expect(sim.exposedLatencyMs).toBeLessThan(3.0);
      expect(sim.exposedLatencyMs).toBeGreaterThan(0.05);
      expect(sim.totalKvCacheMebibytes).toBe(640);
    });

    it('simulates DeepSeek MLA requiring even lower wire transfer time', () => {
      const sim = simulateDisaggregatedRdma({
        modelArch: 'deepseek-v3',
        kvPrecision: 'fp8',
        fabricBandwidthGbps: 400,
        contextTokens: 4096,
        gpuType: 'h100-sxm5',
      });

      expect(sim.rawWireTransferMs).toBeLessThan(3.5);
      expect(sim.overlapPercentage).toBeGreaterThanOrEqual(80.0);
      expect(sim.exposedLatencyMs).toBeLessThanOrEqual(1.5);
    });
  });

  describe('Prefix Hashing & KV Prefix Affinity', () => {
    it('produces deterministic SHA-256 prefix hash from messages', () => {
      const messages1 = [
        { role: 'system', content: 'You are a disaggregated LLM cluster assistant.' },
        { role: 'user', content: 'What is RDMA?' },
      ];
      const messages2 = [
        { role: 'system', content: 'You are a disaggregated LLM cluster assistant.' },
        { role: 'user', content: 'What is InfiniBand?' },
      ];

      const hash1 = computeKvPrefixHash(messages1);
      const hash2 = computeKvPrefixHash(messages2);

      // System prefix is identical, so common prefix hash matches
      expect(hash1).toBeDefined();
      expect(hash1.length).toBe(8);
      expect(hash1).toBe(hash2);
    });
  });

  describe('Switchyard Prefill-Isolation Routing', () => {
    let router: Eluvix;
    let fetchSpy: any;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: Date.now(),
            choices: [{ index: 0, message: { role: 'assistant', content: 'Mock response from upstream' } }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      });

      router = new Eluvix({
        upstreams: [
          {
            id: 'vllm-prefill',
            name: 'vLLM Prefill Worker',
            type: 'vllm',
            endpoint: 'http://prefill.local:8000',
            priority: 30,
            models: ['*'],
            disaggregation: {
              role: 'prefill',
              kvConnector: 'NixlConnector',
              kvCacheDtype: 'fp8_e4m3',
            },
          },
          {
            id: 'vllm-decode',
            name: 'vLLM Decode Worker',
            type: 'vllm',
            endpoint: 'http://decode.local:8001',
            priority: 30,
            models: ['*'],
            disaggregation: {
              role: 'decode',
              kvConnector: 'NixlConnector',
              kvCacheDtype: 'fp8_e4m3',
            },
          },
          {
            id: 'sglang-colocated',
            name: 'SGLang Colocated Node',
            type: 'sglang',
            endpoint: 'http://sglang.local:30000',
            priority: 20,
            models: ['*'],
            disaggregation: {
              role: 'colocated',
            },
          },
        ],
        switchyard: {
          strategy: 'prefill-isolation',
          prefillIsolationThresholdTokens: 1024,
          kvPrefixAffinity: true,
        },
      });
    });

    afterEach(() => {
      fetchSpy?.mockRestore();
    });

    it('steers heavy prompt (tokens >= 1024) to the prefill worker', async () => {
      // Long prompt (5,000 characters ~ 1,250 tokens)
      const longPrompt = 'Analyze the architectural differences between RoCEv2 and InfiniBand for large language model serving. '.repeat(45);

      const decision = await router.routeChatCompletion({
        model: 'auto',
        messages: [{ role: 'user', content: longPrompt }],
      });

      // Response header indicates target upstream was selected by prefill-isolation
      const selectedUpstream = decision.headers.get('x-eluvix-upstream');
      const pdRole = decision.headers.get('x-eluvix-pd-role');

      expect(selectedUpstream).toBe('vllm-prefill');
      expect(pdRole).toBe('prefill');
    });

    it('steers short prompt (tokens < 1024) to the decode/colocated worker', async () => {
      const shortPrompt = 'Hello, can you explain RDMA in one sentence?';

      const decision = await router.routeChatCompletion({
        model: 'auto',
        messages: [{ role: 'user', content: shortPrompt }],
      });

      const selectedUpstream = decision.headers.get('x-eluvix-upstream');
      const pdRole = decision.headers.get('x-eluvix-pd-role');

      expect(selectedUpstream).toBe('vllm-decode');
      expect(pdRole).toBe('decode');
    });

    it('steers prompts sharing prefix to the same affinity node', async () => {
      const sysMsg = 'You are a specialized code analysis system for Linux kernel drivers.';

      const res1 = await router.routeChatCompletion({
        model: 'auto',
        messages: [
          { role: 'system', content: sysMsg },
          { role: 'user', content: 'Explain mlx5 driver registration.' }
        ],
      });
      const upstream1 = res1.headers.get('x-eluvix-upstream');
      const prefixHash1 = res1.headers.get('x-eluvix-kv-prefix-hash');

      const res2 = await router.routeChatCompletion({
        model: 'auto',
        messages: [
          { role: 'system', content: sysMsg },
          { role: 'user', content: 'How does ib_register_device work?' }
        ],
      });
      const upstream2 = res2.headers.get('x-eluvix-upstream');
      const prefixHash2 = res2.headers.get('x-eluvix-kv-prefix-hash');

      expect(prefixHash1).toBeDefined();
      expect(prefixHash1).toBe(prefixHash2);
      expect(upstream1).toBe(upstream2);
    });
  });
});
