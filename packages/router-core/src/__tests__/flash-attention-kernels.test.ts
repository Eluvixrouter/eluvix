import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FLASH_ATTENTION_BENCHMARK_TABLE,
  planWarpSpecializedRegisterBudget,
  simulateTmaCircularMbarrierPipeline,
  analyzePingPongScheduleOverlap,
  analyzeBlackwellTmemArchitecture,
  evaluateFp8HadamardAttention,
  generateFlashAttentionKernelLaunchScript,
  Eluvix
} from '../index.js';

describe('FlashAttention-3 & Warp-Specialized CUDA Kernels (SM90 / SM100)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plans Warp-Specialized CTA register budgets (setmaxnreg 40 / 232) within 65,536 SM ceiling', () => {
    const plan = planWarpSpecializedRegisterBudget({
      producerWarpgroups: 1,
      consumerWarpgroups: 2,
      producerRegsPerThread: 40,
      consumerRegsPerThread: 232
    });

    expect(plan.totalWarpsPerCta).toBe(12);
    expect(plan.totalThreadsPerCta).toBe(384);
    expect(plan.producerThreads).toBe(128);
    expect(plan.consumerThreads).toBe(256);
    expect(plan.totalProducerRegisters).toBe(5120);
    expect(plan.totalConsumerRegisters).toBe(59392);
    expect(plan.totalAllocatedRegisters).toBe(64512);
    expect(plan.unallocatedHeadroomRegisters).toBe(1024);
    expect(plan.fitsInSmRegisterFile).toBe(true);
    expect(plan.registerSpillBytes).toBe(0);
    expect(plan.ptxProducerDirective).toContain('setmaxnreg.dec.sync.aligned.u32 40');
    expect(plan.ptxConsumerDirective).toContain('setmaxnreg.inc.sync.aligned.u32 232');
  });

  it('simulates Hardware TMA + mbarrier K-stage circular ring with phase parity flipping and 128B XOR swizzle', () => {
    const sim = simulateTmaCircularMbarrierPipeline({
      kStages: 3,
      tileRows: 128,
      headDim: 128,
      bytesPerElement: 2,
      numKvBlocks: 6,
      swizzleMode: 'CU_TENSOR_MAP_SWIZZLE_128B'
    });

    expect(sim.kTileBytes).toBe(32768);
    expect(sim.expectedTxBytesPerStep).toBe(65536);
    expect(sim.totalSmemRingBytes).toBe(3 * 65536);
    expect(sim.sharedMemoryBankConflicts).toBe(0);
    expect(sim.steps).toHaveLength(6);

    // Stage 0,1,2 have phase=0 (waitEmptyParityBit=1); Stage 3,4,5 wrap to phase=1 (waitEmptyParityBit=0)
    expect(sim.steps[0].ringStage).toBe(0);
    expect(sim.steps[0].phaseParityBit).toBe(0);
    expect(sim.steps[0].waitEmptyParityBit).toBe(1);

    expect(sim.steps[2].ringStage).toBe(2);
    expect(sim.steps[2].phaseParityBit).toBe(0);

    expect(sim.steps[3].ringStage).toBe(0);
    expect(sim.steps[3].phaseParityBit).toBe(1);
    expect(sim.steps[3].waitEmptyParityBit).toBe(0);
  });

  it('quantifies the 64:1 Tensor Core vs. SFU MUFU.EX2 asymmetry and Ping-Pong overlap', () => {
    const sm90Bf16 = analyzePingPongScheduleOverlap({ smArch: 'sm_90a', precision: 'BF16' });
    expect(sm90Bf16.tensorCoreOpsPerCyclePerSm).toBe(1024);
    expect(sm90Bf16.sfuExp2OpsPerCyclePerSm).toBe(16);
    expect(sm90Bf16.throughputAsymmetryRatio).toBe(64);
    expect(sm90Bf16.pingPongOverlappedTensorCoreUtilPct).toBe(75.0);
    expect(sm90Bf16.interWarpgroupBarrierPtx).toContain('bar.sync');
    expect(sm90Bf16.intraWarpgroupWaitGroupPtx).toContain('wgmma.wait_group.sync.aligned 1');
  });

  it('models Blackwell SM100 256 KB Dedicated TMEM and 2-CTA cooperative tcgen05.mma', () => {
    const bw = analyzeBlackwellTmemArchitecture({ ctaClusterSize: 2 });
    expect(bw.tmemCapacityKbPerSm).toBe(256);
    expect(bw.tmemCapacityBytesPerSm).toBe(262144);
    expect(bw.singleThreadMmaIssue).toBe(true);
    expect(bw.mmaInstruction).toBe('tcgen05.mma.cta_group::2.m256n128k32');
    expect(bw.kvHbmReloadReductionPct).toBe(50.0);
    expect(bw.measuredFp8Tflops).toBe(3080);
  });

  it('verifies 16x16 Walsh-Hadamard dot-product invariance and reports unclamped FP8 E4M3 RMSE values', () => {
    const evalFp8 = evaluateFp8HadamardAttention();
    expect(evalFp8.orthogonalInvarianceVerified).toBe(true);
    expect(evalFp8.dotProductMaxAbsError).toBeLessThan(1e-9);
    // Hunt-2 L13: the old code clamped the headline to ~2.6x (naive floored
    // at 0.0468, Hadamard capped at naive/2.6). The honest measurement for
    // the default vectors is 0.3364 / 0.3029 = 1.11x.
    expect(evalFp8.naiveFp8AttentionRmse).toBeCloseTo(0.3364, 3);
    expect(evalFp8.hadamardFp8AttentionRmse).toBeCloseTo(0.3029, 3);
    expect(evalFp8.rmseReductionFactor).toBeCloseTo(1.11, 2);
    expect(evalFp8.vTransposePtx).toContain('stmatrix.sync.aligned.m8n8.x4.trans.shared.b16');
  });

  it('generates shell-safe vLLM and SGLang launch scripts with FA3 and Blackwell tcgen05 flags', () => {
    const vllmScript = generateFlashAttentionKernelLaunchScript(
      'hopper-fa3-node',
      'vllm',
      'meta-llama/Llama-3.3-70B-Instruct',
      {
        backend: 'fa3-fp8-hadamard',
        tmaCircularStages: 3,
        producerRegisters: 40,
        consumerRegisters: 232
      }
    );
    expect(vllmScript).toContain('export VLLM_FLASH_ATTN_VERSION=3');
    expect(vllmScript).toContain('setmaxnreg.dec.sync.aligned.u32 40');
    expect(vllmScript).toContain('setmaxnreg.inc.sync.aligned.u32 232');

    const sglangScript = generateFlashAttentionKernelLaunchScript(
      'blackwell-b200-node',
      'sglang',
      'deepseek-ai/DeepSeek-V3',
      {
        backend: 'blackwell-tcgen05-tmem',
        ctaClusterSize: 2
      }
    );
    expect(sglangScript).toContain('--attention-backend trtllm_mla');
    expect(sglangScript).toContain('--enable-flashinfer-trtllm');
    expect(sglangScript).toContain('tcgen05.mma.cta_group::2.m256n128k32');
  });

  it('enforces attentionPolicy in Switchyard routing and explainRoute', async () => {
    const router = new Eluvix({
      strategy: 'priority',
      switchyard: {
        attentionPolicy: 'prefer-blackwell-tmem'
      },
      upstreams: [
        {
          id: 'legacy-fa2-node',
          name: 'Legacy FA2 Node',
          type: 'vllm',
          endpoint: 'http://localhost:8001',
          priority: 50,
          models: ['*'],
          attentionKernel: {
            enabled: true,
            backend: 'fa2-cp-async'
          }
        },
        {
          id: 'hopper-fa3-node',
          name: 'Hopper FA3 FP8 Node',
          type: 'vllm',
          endpoint: 'http://localhost:8002',
          priority: 30,
          models: ['*'],
          attentionKernel: {
            enabled: true,
            backend: 'fa3-fp8-hadamard'
          }
        },
        {
          id: 'blackwell-tmem-node',
          name: 'Blackwell B200 TMEM Node',
          type: 'sglang',
          endpoint: 'http://localhost:30000',
          priority: 20,
          models: ['*'],
          attentionKernel: {
            enabled: true,
            backend: 'blackwell-tcgen05-tmem'
          }
        }
      ]
    });

    const explanation = router.explainRoute({
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      messages: [{ role: 'user', content: 'Summarize this 32K context document.' }]
    });

    // Even though legacy-fa2-node had priority 50, attentionPolicy=prefer-blackwell-tmem ranks blackwell-tmem-node first, then hopper-fa3-node
    expect(explanation.chosenUpstreamId).toBe('blackwell-tmem-node');
    expect(explanation.rankedUpstreams.map(u => u.id)).toEqual([
      'blackwell-tmem-node',
      'hopper-fa3-node',
      'legacy-fa2-node'
    ]);
    expect(explanation.steps.some(s => s.stage === 'flash-attention-kernel')).toBe(true);

    // Verify fail-closed 503 when require-fp8-ping-pong is active and only legacy FA2/SDPA upstreams exist
    const strictRouter = new Eluvix({
      switchyard: {
        attentionPolicy: 'require-fp8-ping-pong'
      },
      upstreams: [
        {
          id: 'legacy-sdpa',
          name: 'PyTorch SDPA Worker',
          type: 'vllm',
          endpoint: 'http://localhost:8001',
          priority: 50,
          models: ['*'],
          attentionKernel: {
            enabled: true,
            backend: 'pytorch-sdpa'
          }
        }
      ]
    });

    const res = await strictRouter.routeChatCompletion({
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      messages: [{ role: 'user', content: 'Test strict FA3 policy' }]
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('x-eluvix-attention-guard')).toBe('DENIED_SYNCHRONOUS_KERNEL');
    const body = await res.json();
    expect(body.error.type).toBe('attention_kernel_unavailable');
  });

  it('enforces require-fp8-ping-pong against BF16-only FA3 upstreams and differentiates prefer-blackwell-tmem vs prefer-fa3-warp-specialized', async () => {
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-fa3-bugfix',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: `routed:${url}` }, finish_reason: 'stop' }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    // 1. BF16-only FA3 upstream must be rejected under require-fp8-ping-pong
    const fp8StrictRouter = new Eluvix({
      egressPolicy: 'local-only',
      attentionPolicy: 'require-fp8-ping-pong',
      upstreams: [
        {
          id: 'h100-fa3-bf16-only',
          name: 'H100 FA3 BF16 Only',
          type: 'vllm',
          endpoint: 'http://127.0.0.1:8101',
          priority: 20,
          models: ['*'],
          attentionKernel: {
            enabled: true,
            backend: 'fa3-wgmma-tma',
            smArch: 'sm_90a',
            pingPongSchedule: false
          }
        }
      ]
    });

    const deniedRes = await fp8StrictRouter.routeChatCompletion({
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      messages: [{ role: 'user', content: 'Require FP8 ping-pong' }]
    });
    expect(deniedRes.status).toBe(503);
    expect(deniedRes.headers.get('x-eluvix-attention-guard')).toBe('DENIED_SYNCHRONOUS_KERNEL');

    // 2. prefer-fa3-warp-specialized prefers SM90a FA3 over SM100 Blackwell when priorities are equal
    const dualRouter = new Eluvix({
      egressPolicy: 'local-only',
      upstreams: [
        {
          id: 'b200-tmem',
          name: 'B200 TMEM',
          type: 'sglang',
          endpoint: 'http://127.0.0.1:30001',
          priority: 20,
          models: ['*'],
          attentionKernel: {
            enabled: true,
            backend: 'blackwell-tcgen05-tmem',
            smArch: 'sm_100a'
          }
        },
        {
          id: 'h100-fa3',
          name: 'H100 FA3',
          type: 'vllm',
          endpoint: 'http://127.0.0.1:8001',
          priority: 20,
          models: ['*'],
          attentionKernel: {
            enabled: true,
            backend: 'fa3-fp8-hadamard',
            smArch: 'sm_90a',
            pingPongSchedule: true
          }
        }
      ]
    });

    const fa3PrefRes = await dualRouter.routeChatCompletion({
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      attentionPolicy: 'prefer-fa3-warp-specialized',
      messages: [{ role: 'user', content: 'Route with prefer-fa3-warp-specialized' }]
    });
    expect(fa3PrefRes.status).toBe(200);
    expect(fa3PrefRes.headers.get('x-eluvix-attention-kernel')).toBe('fa3-fp8-hadamard');

    const b200PrefRes = await dualRouter.routeChatCompletion({
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      attentionPolicy: 'prefer-blackwell-tmem',
      messages: [{ role: 'user', content: 'Route with prefer-blackwell-tmem' }]
    });
    expect(b200PrefRes.status).toBe(200);
    expect(b200PrefRes.headers.get('x-eluvix-attention-kernel')).toBe('blackwell-tcgen05-tmem');
  });
});
