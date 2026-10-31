import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Eluvix,
  computeBackwardProgramSlice,
  computeAsanShadowMapping,
  decodeHexspeakOrPoisonConstant,
  verifyBitVectorOverflow,
  evaluateStallEscalation,
  analyzePromptForCrsTriage,
  generateCrsVerificationScript
} from '../index.js';

const SAMPLE_MULTI_FUNCTION_C_SOURCE = `
// Unrelated logging utility (should be pruned by backward program slicer)
void log_telemetry_banner(const char *tag, int level) {
    int banner_len = 128;
    for (int i = 0; i < banner_len; i++) {
        // unrelated loop body
    }
}

int compute_unused_metrics(int a, int b) {
    int acc = a * 42 + b;
    return acc ^ 0x1234;
}

int parse_samhain_frame(struct session_ctx *ctx, const uint8_t *data, size_t len) {
    if (len < sizeof(struct frame_hdr)) return -1;
    const struct frame_hdr *hdr = (const struct frame_hdr *)data;

    // Gate 1: 32-bit Hexspeak Magic Check (Solved in 1 step by LibAFL CmpLog)
    if (hdr->magic != 0xFEE1DEAD) return -EINVAL;

    // Gate 2: Coupled arithmetic invariant across 3 header fields (Stalls CmpLog!)
    if ((uint32_t)hdr->chunk_count * (uint32_t)hdr->chunk_stride + 0x31 != hdr->total_len) {
        return -EINVAL;
    }

    // Gate 3: Multi-turn state requirement + uint16_t integer wrap -> Heap OOB!
    if (ctx->state != S_AUTH_READY) return -EPERM;

    uint16_t alloc_sz = hdr->payload_len + hdr->footer_pad;
    uint8_t *buf = malloc(alloc_sz);
    memcpy(buf, data + sizeof(*hdr), hdr->payload_len);
    return 0;
}
`;

describe('Neuro-Symbolic CRS, Backward Program Slicing & ASan Shadow Memory Math', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Backward Program Slicing (def-use & control-flow gates)', () => {
    it('prunes unrelated functions and extracts the exact def-use cone and 3 control-flow gates for memcpy', () => {
      const slice = computeBackwardProgramSlice(SAMPLE_MULTI_FUNCTION_C_SOURCE, {
        targetSink: 'memcpy'
      });

      expect(slice.derivationMethod).toBe('analytical-exact');
      expect(slice.targetSink).toBe('memcpy');
      expect(slice.slicedLineCount).toBeLessThan(slice.originalLineCount);
      expect(slice.compressionRatioPct).toBeGreaterThan(35);
      expect(slice.estimatedTokensSaved).toBeGreaterThan(40);

      // Unrelated functions must be excluded from the slice
      expect(slice.slicedCode).not.toContain('log_telemetry_banner');
      expect(slice.slicedCode).not.toContain('compute_unused_metrics');

      // Core def-use chain and gates must be preserved
      expect(slice.slicedCode).toContain('0xFEE1DEAD');
      expect(slice.slicedCode).toContain('hdr->chunk_count');
      expect(slice.slicedCode).toContain('S_AUTH_READY');
      expect(slice.slicedCode).toContain('uint16_t alloc_sz = hdr->payload_len + hdr->footer_pad;');
      expect(slice.slicedCode).toContain('memcpy(buf, data + sizeof(*hdr), hdr->payload_len);');

      // Verify gate classification
      const gateKinds = slice.controlFlowGates.map(g => g.gateKind);
      expect(gateKinds).toContain('magic-constant');
      expect(gateKinds).toContain('coupled-arithmetic');
      expect(gateKinds).toContain('state-guard');
    });
  });

  describe('ASan Shadow Memory Mapping & Hexspeak Tombstone Decoding', () => {
    it('computes exact BigInt shadow memory address (addr >> 3) + 0x7fff8000 on x86_64', () => {
      // 0x602000000014 >> 3 = 0x0c0400000002; + 0x7fff8000 = 0x0c047fff8002
      const mapping = computeAsanShadowMapping('0x602000000014', 'asan-x86_64', 0xfa);
      expect(mapping.derivationMethod).toBe('analytical-exact');
      expect(mapping.applicationAddressHex).toBe('0x602000000014');
      expect(mapping.shadowAddressHex).toBe('0xc047fff8002');
      expect(mapping.byteOffsetInQword).toBe(4);
      expect(mapping.shadowByteHex).toBe('0xfa');
      expect(mapping.isAddressable).toBe(false);
      expect(mapping.bugClass).toBe('heap-buffer-overflow-redzone');
    });

    it('distinguishes valid partial words (0x01..0x07) from partial-word OOB and 0xfd Quarantine UAF', () => {
      // Address ending in 0x02 (byteOffsetInQword = 2) with shadow byte 0x04 -> valid
      const validPartial = computeAsanShadowMapping('0x602000000012', 'asan-x86_64', 0x04);
      expect(validPartial.isAddressable).toBe(true);
      expect(validPartial.bugClass).toBe('partial-word-valid');

      // Address ending in 0x05 (byteOffsetInQword = 5) with shadow byte 0x04 -> OOB!
      const oobPartial = computeAsanShadowMapping('0x602000000015', 'asan-x86_64', 0x04);
      expect(oobPartial.isAddressable).toBe(false);
      expect(oobPartial.bugClass).toBe('partial-word-oob');

      // Freed quarantine UAF (0xfd)
      const uaf = computeAsanShadowMapping('0x602000000010', 'asan-x86_64', 0xfd);
      expect(uaf.isAddressable).toBe(false);
      expect(uaf.bugClass).toBe('heap-use-after-free-quarantine');
    });

    it('decodes Hexspeak and Linux kernel SLUB poison constants accurately', () => {
      expect(decodeHexspeakOrPoisonConstant('0xDEADBEEF')?.category).toBe('poison-tombstone');
      expect(decodeHexspeakOrPoisonConstant('0xFEE1DEAD')?.category).toBe('magic-guard');
      expect(decodeHexspeakOrPoisonConstant('0x6b6b6b6b6b6b6b6b')?.name).toContain('POISON_FREE');
      expect(decodeHexspeakOrPoisonConstant('0x5a5a5a5a')?.name).toContain('POISON_INUSE');
      expect(decodeHexspeakOrPoisonConstant('0xDEAD10CC')?.name).toContain('DEAD10CC');
    });
  });

  describe('Fixed-Width Bit-Vector Overflow Verifier & Bounds-Check Synthesizer', () => {
    it('detects uint16_t wrap-around (0xfff0 + 0x0020 -> 0x0010) and synthesizes C/Rust bounds guards', () => {
      const check = verifyBitVectorOverflow({
        bitWidth: 16,
        operation: 'add',
        operandA: 0xfff0,
        operandB: 0x0020,
        varNameA: 'hdr->payload_len',
        varNameB: 'hdr->footer_pad'
      });

      expect(check.derivationMethod).toBe('analytical-exact');
      expect(check.overflowed).toBe(true);
      expect(check.wrappedHex).toBe('0x0010');
      expect(check.defensiveBoundsCheckC).toBe(
        'if (hdr->payload_len > UINT16_MAX - hdr->footer_pad) return -EINVAL;'
      );
      expect(check.defensiveBoundsCheckRust).toContain('checked_add');
    });
  });

  describe('Switchyard Neuro-Symbolic CRS & Stall-Escalation Routing', () => {
    it('fails closed with 503 when crsPolicy=strict-zero-false-positive and no CRS upstream exists', async () => {
      const router = new Eluvix({
        crsPolicy: 'strict-zero-false-positive',
        upstreams: [
          {
            id: 'plain-ollama',
            name: 'Plain Local Ollama',
            type: 'ollama',
            endpoint: 'http://127.0.0.1:11434',
            priority: 10,
            models: ['*']
          }
        ]
      });

      const res = await router.routeChatCompletion({
        model: 'llama3',
        messages: [{ role: 'user', content: 'Audit this C function for heap overflow.' }]
      });

      expect(res.status).toBe(503);
      expect(res.headers.get('x-eluvix-crs-guard')).toBe('DENIED_CRS_VERIFIER_REQUIRED');
    });

    it('escalates stalled/coupled-invariant code prompts to CRS upstream and injects <eluvix-crs-triage> + telemetry headers', async () => {
      let capturedBody: any = null;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if (init?.body) {
          capturedBody = JSON.parse(String(init.body));
        }
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-crs-1',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Verified patch: check `if (hdr->payload_len > UINT16_MAX - hdr->footer_pad) return -EINVAL;`'
                },
                finish_reason: 'stop'
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const router = new Eluvix({
        strategy: 'stall-escalation',
        crsPolicy: 'slice-and-verify',
        upstreams: [
          {
            id: 'fast-local',
            name: 'Fast Local Engine',
            type: 'vllm',
            endpoint: 'http://127.0.0.1:8000',
            priority: 20,
            models: ['*']
          },
          {
            id: 'crs-verifier-node',
            name: 'Neuro-Symbolic CRS Verifier',
            type: 'vllm',
            endpoint: 'http://127.0.0.1:8010',
            priority: 5,
            models: ['*'],
            crs: {
              enabled: true,
              policy: 'strict-zero-false-positive',
              slicerMode: 'llvm-def-use',
              sanitizerArch: 'asan-x86_64',
              stallThresholdSeconds: 120,
              defaultBitWidth: 16,
              targetSink: 'memcpy'
            }
          }
        ]
      });

      const res = await router.routeChatCompletion({
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: `AddressSanitizer reported 0xfa on address 0x602000000014 in:\n\`\`\`c\n${SAMPLE_MULTI_FUNCTION_C_SOURCE}\n\`\`\``
          }
        ]
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('x-eluvix-upstream')).toBe('crs-verifier-node');
      expect(res.headers.get('x-eluvix-crs-policy')).toBe('slice-and-verify');
      expect(res.headers.get('x-eluvix-crs-verified')).toBe('true');
      expect(res.headers.get('x-eluvix-crs-stall-escalated')).toBe('true');
      expect(res.headers.get('x-eluvix-crs-shadow-poison')).toBe('0xfa');
      expect(res.headers.get('x-eluvix-crs-bug-class')).toBe('heap-buffer-overflow-redzone');
      expect(res.headers.get('x-eluvix-crs-bv-overflow')).toBe('uint16:0x0010');
      expect(Number(res.headers.get('x-eluvix-crs-slice-compression-pct'))).toBeGreaterThan(35);

      // Verify <eluvix-crs-triage> was injected into system message
      const sysMsg = capturedBody?.messages?.find((m: any) => m.role === 'system');
      expect(sysMsg?.content).toContain('<eluvix-crs-triage>');
      expect(sysMsg?.content).toContain('if (hdr->payload_len > UINT16_MAX - hdr->footer_pad) return -EINVAL;');
    });

    it('generates a shell-safe CRS verification script', () => {
      const script = generateCrsVerificationScript('crs-main', {
        enabled: true,
        policy: 'strict-zero-false-positive',
        slicerMode: 'llvm-def-use',
        sanitizerArch: 'asan-x86_64',
        stallThresholdSeconds: 120,
        defaultBitWidth: 16,
        targetSink: 'memcpy'
      });

      expect(script).toContain('#!/usr/bin/env bash');
      expect(script).toContain('-fsanitize=address,undefined');
      expect(script).toContain('0xc047fff8002');
      expect(script).toContain('UINT16_MAX');
    });
  });
});
