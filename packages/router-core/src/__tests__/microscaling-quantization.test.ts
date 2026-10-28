import { describe, it, expect, vi } from 'vitest';
import {
  Eluvix,
  E2M1_LOOKUP_TABLE,
  E2M1_POSITIVE_MAGNITUDES,
  HADAMARD_ROTATION_POINTS,
  quantizeScalarToE2M1,
  quantizeScaleToE8M0,
  quantizeScaleToFp8E4M3,
  quantizeBlockMxfp4,
  quantizeBlockNvfp4,
  quantizeBlockInt4Awq,
  fastHadamardRotateBlock,
  simulateMicroscalingQuantization,
  generateModelOptNvfp4Script,
  isLosslessSub4BitUpstream,
  isNaiveSub4BitUpstream,
  estimateKvCacheFootprint,
  calculateRooflineRidgePoint,
  type RouterConfig
} from '../index.js';

describe('Sub-4-Bit Frontier: OCP MXFP4, NVIDIA Blackwell NVFP4 (E2M1) & Walsh-Hadamard Rotation', () => {
  describe('E2M1 4-Bit Floating-Point Format & Scales', () => {
    it('defines all 8 exact positive E2M1 magnitudes with zero Inf/NaN bit waste', () => {
      expect(E2M1_POSITIVE_MAGNITUDES).toEqual([0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0]);
      expect(E2M1_LOOKUP_TABLE).toHaveLength(8);
      expect(quantizeScalarToE2M1(0)).toBe(0);
      expect(quantizeScalarToE2M1(0.49)).toBe(0.5);
      expect(quantizeScalarToE2M1(-1.45)).toBe(-1.5);
      expect(quantizeScalarToE2M1(5.8)).toBe(6.0);
      expect(quantizeScalarToE2M1(-99.0)).toBe(-6.0);
    });

    it('demonstrates E8M0 sawtooth jump at 6.05 vs fractional FP8 E4M3 scale in NVFP4', () => {
      // At maxAbs = 6.05, rawScale = 6.05 / 6.0 = 1.00833.
      // E8M0 has 0 mantissa bits and must jump to 2^1 = 2.0 (max representable = 12.0, wasting ~50% range).
      const e8m0Scale = quantizeScaleToE8M0(6.05);
      expect(e8m0Scale).toBe(2.0);

      // FP8 E4M3 has 3 mantissa bits (step 0.125) and represents 1.0 / 1.125 without jumping to 2.0
      const e4m3Scale = quantizeScaleToFp8E4M3(6.05 / 6.0);
      expect(e4m3Scale).toBeLessThanOrEqual(1.125);
    });

    it('achieves lower quantization MSE with 16-element two-level NVFP4 than 32-element MXFP4', () => {
      const block: number[] = [];
      for (let i = 0; i < 64; i++) {
        block.push(Math.sin(i * 0.37) * 6.05);
      }

      const mxfp4 = quantizeBlockMxfp4(block);
      const nvfp4 = quantizeBlockNvfp4(block);
      const int4 = quantizeBlockInt4Awq(block);

      expect(mxfp4.blockSize).toBe(32);
      expect(mxfp4.effectiveBitsPerWeight).toBe(4.25);
      expect(nvfp4.blockSize).toBe(16);
      expect(nvfp4.effectiveBitsPerWeight).toBe(4.5);
      expect(int4.effectiveBitsPerWeight).toBe(4.125);

      expect(nvfp4.mse).toBeLessThan(mxfp4.mse);
      expect(nvfp4.sqnrDb).toBeGreaterThan(mxfp4.sqnrDb);
    });
  });

  describe('Fast Walsh-Hadamard Transform (FWHT) Outlier Smoothing', () => {
    it('smears a 120.0 channel-0 activation spike across all channels while preserving exact L2 norm', () => {
      const d = 256;
      const xRaw = new Array(d).fill(0).map((_, i) => Math.sin(i + 1) * 0.15);
      xRaw[0] = 120.0;

      const xRot = fastHadamardRotateBlock(xRaw);

      const rawMax = Math.max(...xRaw.map(Math.abs));
      const rotMax = Math.max(...xRot.map(Math.abs));
      expect(rawMax).toBe(120.0);
      // Damped by ~sqrt(256) = 16x -> ~7.5
      expect(rotMax).toBeLessThan(9.0);

      // Verify exact L2 norm invariance: ||xRaw||_2 == ||xRot||_2
      const normRaw = Math.sqrt(xRaw.reduce((s, v) => s + v * v, 0));
      const normRot = Math.sqrt(xRot.reduce((s, v) => s + v * v, 0));
      expect(normRot).toBeCloseTo(normRaw, 5);

      // Verify involution property: H * (H * x) == x
      const xRecovered = fastHadamardRotateBlock(xRot);
      expect(xRecovered[0]).toBeCloseTo(120.0, 4);
      expect(xRecovered[17]).toBeCloseTo(xRaw[17], 4);
    });

    it('documents all 4 transformer rotation points (R1..R4) and simulates 70B single-GPU fit', () => {
      expect(Object.keys(HADAMARD_ROTATION_POINTS)).toEqual(['R1', 'R2', 'R3', 'R4']);
      expect(HADAMARD_ROTATION_POINTS.R1.runtimeCostPct).toBe(0);
      expect(HADAMARD_ROTATION_POINTS.R2.runtimeCostPct).toBe(0);

      const sim = simulateMicroscalingQuantization({
        modelParamsBillions: 70,
        hiddenDim: 8192,
        outlierSpikeMagnitude: 120.0,
        enableHadamardRotation: true
      });

      expect(sim.l2NormPreserved).toBe(true);
      expect(sim.theoreticalDampingFactor).toBeCloseTo(90.5, 1);
      expect(sim.hadamardMseImprovementRatio).toBeGreaterThan(1.5);

      const nvfp4Row = sim.formats.find((f) => f.id === 'nvfp4')!;
      expect(nvfp4Row.weightMemoryGb).toBe(39.4);
      expect(nvfp4Row.fitsSingleB200Gpu).toBe(true);
      expect(nvfp4Row.math500Pct).toBe(76.1);
      expect(nvfp4Row.relativeThroughput).toBe(3.42);

      const script = generateModelOptNvfp4Script({
        modelIn: 'meta-llama/Llama-3.3-70B-Instruct',
        qformat: 'nvfp4',
        tensorParallelSize: 1
      });
      expect(script).toContain('--qformat nvfp4');
      expect(script).toContain('--tensor-parallel-size 1');
    });
  });

  describe('Blackwell B200 Roofline & NVFP4/MXFP4 KV-Cache Math', () => {
    it('computes NVFP4 and MXFP4 KV-cache footprints and Blackwell SM100 20 PFLOPS roofline', () => {
      const fp8Kv = estimateKvCacheFootprint('llama-3.3-70b', 4096, 'fp8_e4m3');
      const nvfp4Kv = estimateKvCacheFootprint('llama-3.3-70b', 4096, 'nvfp4');
      const mxfp4Kv = estimateKvCacheFootprint('llama-3.3-70b', 4096, 'mxfp4');

      expect(nvfp4Kv.bytesPerElement).toBe(0.5625);
      expect(mxfp4Kv.bytesPerElement).toBe(0.53125);
      expect(nvfp4Kv.totalMiB).toBeLessThan(fp8Kv.totalMiB);

      const b200Roofline = calculateRooflineRidgePoint('b200-sxm6', 'nvfp4');
      expect(b200Roofline.peakTflops).toBe(20000.0);
      expect(b200Roofline.memoryBandwidthTBps).toBe(8.0);
      expect(b200Roofline.ridgePointFlopsPerByte).toBe(2500.0);
    });
  });

  describe('Quantization-Aware Switchyard Routing & Telemetry Headers', () => {
    const baseConfig: RouterConfig = {
      upstreams: [
        {
          id: 'vllm-int4-awq',
          name: 'Naive INT4-AWQ Worker',
          type: 'vllm',
          endpoint: 'http://localhost:8001',
          priority: 40,
          models: ['llama-3.3-70b'],
          costPer1kTokens: 0,
          maxComplexityScore: 4,
          quantization: {
            enabled: true,
            format: 'int4_awq',
            outlierMitigation: 'none'
          }
        },
        {
          id: 'vllm-mxfp4-naive',
          name: 'Unrotated MXFP4 Worker',
          type: 'vllm',
          endpoint: 'http://localhost:8002',
          priority: 35,
          models: ['llama-3.3-70b'],
          costPer1kTokens: 0,
          maxComplexityScore: 4,
          quantization: {
            enabled: true,
            format: 'mxfp4',
            outlierMitigation: 'none'
          }
        },
        {
          id: 'vllm-nvfp4-quarot',
          name: 'Blackwell NVFP4 + QuaRot Hadamard Worker',
          type: 'vllm',
          endpoint: 'http://localhost:8000',
          priority: 25,
          models: ['llama-3.3-70b'],
          costPer1kTokens: 0,
          maxComplexityScore: 4,
          quantization: {
            enabled: true,
            format: 'nvfp4',
            outlierMitigation: 'hadamard-quarot',
            rotationPoints: ['R1', 'R2', 'R3', 'R4'],
            ptxInstruction: 'tcgen05.mma.kind::mxf4nvf4'
          }
        }
      ],
      strategy: 'cost-complexity',
      switchyard: {
        quantizationPolicy: 'lossless-reasoning'
      }
    };

    it('correctly classifies lossless NVFP4+Hadamard vs naive INT4/MXFP4 upstreams', () => {
      expect(isNaiveSub4BitUpstream(baseConfig.upstreams[0])).toBe(true);
      expect(isNaiveSub4BitUpstream(baseConfig.upstreams[1])).toBe(true);
      expect(isNaiveSub4BitUpstream(baseConfig.upstreams[2])).toBe(false);
      expect(isLosslessSub4BitUpstream(baseConfig.upstreams[2])).toBe(true);
    });

    it('filters out naive INT4-AWQ and unrotated MXFP4 upstreams under lossless-reasoning policy', () => {
      const router = new Eluvix(baseConfig);
      const explanation = router.explainRoute({
        model: 'llama-3.3-70b',
        messages: [{ role: 'user', content: 'Prove the Walsh-Hadamard L2 norm invariance theorem.' }]
      });

      expect(explanation.chosenUpstreamId).toBe('vllm-nvfp4-quarot');
      const guardStep = explanation.steps.find((s) => s.stage === 'quantization-aware-guard');
      expect(guardStep).toBeDefined();
      expect(guardStep?.removed).toEqual(['vllm-int4-awq', 'vllm-mxfp4-naive']);
      expect(guardStep?.kept).toEqual(['vllm-nvfp4-quarot']);
    });

    it('emits x-eluvix-quantization-format, x-eluvix-outlier-rotation, and x-eluvix-tensor-core-ptx headers', async () => {
      const globalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'chatcmpl-nvfp4',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Proof complete.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      try {
        const router = new Eluvix(baseConfig);
        const res = await router.routeChatCompletion({
          model: 'llama-3.3-70b',
          messages: [{ role: 'user', content: 'Solve this MATH-500 problem.' }]
        });

        expect(res.headers.get('x-eluvix-upstream')).toBe('vllm-nvfp4-quarot');
        expect(res.headers.get('x-eluvix-quantization-format')).toBe('nvfp4');
        expect(res.headers.get('x-eluvix-outlier-rotation')).toBe('hadamard-quarot');
        expect(res.headers.get('x-eluvix-tensor-core-ptx')).toBe('tcgen05.mma.kind::mxf4nvf4');
      } finally {
        globalThis.fetch = globalFetch;
      }
    });
  });
});
