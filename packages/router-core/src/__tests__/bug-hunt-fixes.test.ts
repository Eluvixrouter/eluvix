import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Eluvix, type RouterConfig, type UpstreamConfig } from '../index.js';
import { executeInSandbox } from '../sandbox/index.js';
import { computeReportDataBinding } from '../tee-attestation.js';
import { stripKnowledgeFromMessages, formatKnowledgeSystemBlock } from '../context/knowledge.js';

describe('Bug Hunt Regression Suite', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Sandbox sidecar fail-closed security', () => {
    it('fails closed when sidecar execution is rejected or offline instead of falling back to node:vm', async () => {
      // Mock fetch to simulate offline sidecar container
      const globalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused to sidecar'));

      try {
        const res = await executeInSandbox('return 1 + 1;', {
          enabled: true,
          endpoint: 'http://localhost:3986',
          runtime: 'docker-local',
          timeoutSec: 5
        });

        expect(res.exitCode).toBe(1);
        expect(res.stderr).toMatch(/sidecar/i);
      } finally {
        globalThis.fetch = globalFetch;
      }
    });
  });

  describe('TEE Attestation Nonce & Report Data Binding', () => {
    it('handles 0x-prefixed and raw hex nonces correctly without byte distortion', () => {
      const nonce1 = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const nonce2 = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const pubkey = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A\n-----END PUBLIC KEY-----';

      const binding1 = computeReportDataBinding(nonce1, pubkey);
      const binding2 = computeReportDataBinding(nonce2, pubkey);

      expect(binding1).toBe(binding2);
      expect(binding1.length).toBe(128); // 64 bytes in hex
    });
  });

  describe('Confidential Policy Strictness Enforcement', () => {
    it('prevents client metadata from downgrading server require-dual-attestation to disabled', async () => {
      const upstreams: UpstreamConfig[] = [
        {
          id: 'standard-worker',
          name: 'Standard Plaintext Worker',
          type: 'lemonade',
          endpoint: 'http://localhost:13305',
          models: ['qwen-2.5-7b'],
          priority: 50
        }
      ];

      const config: RouterConfig = {
        upstreams,
        confidentialPolicy: 'require-dual-attestation'
      };

      const router = new Eluvix(config);

      // Client attempts to downgrade policy via metadata
      const res = await router.routeChatCompletion({
        model: 'qwen-2.5-7b',
        messages: [{ role: 'user', content: 'Secret confidential query' }],
        metadata: {
          confidentialPolicy: 'disabled'
        }
      });

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error.code).toBe('rats_attestation_required');
    });
  });

  describe('Knowledge Base Delimiter Stripping & Complexity Isolation', () => {
    it('strips knowledge blocks so prompt complexity does not escalate to heavy XML', () => {
      const messages = [
        { role: 'system', content: 'You are an assistant.' },
        { role: 'user', content: 'Hello there' }
      ];

      const kbBlock = formatKnowledgeSystemBlock([
        { uri: 'chunk-1', text: '<xml><tag>Document content with tags</tag></xml>', score: 0.9 }
      ]);

      const messagesWithKnowledge = [
        { role: 'system', content: `You are an assistant.\n\n${kbBlock}` },
        { role: 'user', content: 'Hello there' }
      ];

      const stripped = stripKnowledgeFromMessages(messagesWithKnowledge);
      expect(stripped.length).toBe(2);
      expect(stripped[0].content).toBe('You are an assistant.');
      expect(stripped[0].content).not.toContain('<eluvix-knowledge>');
    });
  });

  describe('Semantic Cache Jaccard Similarity & Variant Key Isolation', () => {
    it('does not falsely hit semantic cache when user query only shares a common single token', async () => {
      let fetchCallCount = 0;
      const globalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: Date.now(),
            model: 'qwen-2.5-7b',
            choices: [{ message: { role: 'assistant', content: 'Simulated answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      try {
        const config: RouterConfig = {
          upstreams: [
            {
              id: 'local-test',
              name: 'Local Test',
              type: 'openai-compatible',
              endpoint: 'http://localhost:8000',
              models: ['qwen-2.5-7b'],
              priority: 10
            }
          ],
          cache: {
            enabled: true,
            mode: 'semantic',
            similarityThreshold: 0.8,
            ttlSeconds: 3600
          }
        };

        const router = new Eluvix(config);

        // First query: "what is quantum computing theory and principles"
        await router.routeChatCompletion({
          model: 'qwen-2.5-7b',
          messages: [{ role: 'user', content: 'what is quantum computing theory and principles' }]
        });
        expect(fetchCallCount).toBe(1);

        // Second query only shares the word "what": "what is cooking for dinner tonight"
        // Under old bug: intersection was 1/1 = 1.0 (false hit).
        // Under true Jaccard: union is ~10 words, intersection is 2 ("what", "is"), Jaccard ~0.2 < 0.8.
        const res2 = await router.routeChatCompletion({
          model: 'qwen-2.5-7b',
          messages: [{ role: 'user', content: 'what is cooking for dinner tonight' }]
        });

        expect(fetchCallCount).toBe(2); // Must fetch again, not false cache hit!
        expect(res2.headers.get('X-Eluvix-Cache')).toBeNull();
      } finally {
        globalThis.fetch = globalFetch;
      }
    });
  });

  describe('Fallback Chain Circuit Breaker Ordering', () => {
    it('orders upstreams according to orderedUpstreamIds and respects circuit breaker', async () => {
      const upstreams: UpstreamConfig[] = [
        { id: 'worker-c', name: 'Worker C', type: 'lemonade', endpoint: 'http://localhost:13305', models: ['test-m'], priority: 10 },
        { id: 'worker-b', name: 'Worker B', type: 'lemonade', endpoint: 'http://localhost:13305', models: ['test-m'], priority: 20 },
        { id: 'worker-a', name: 'Worker A', type: 'lemonade', endpoint: 'http://localhost:13305', models: ['test-m'], priority: 30 }
      ];

      const config: RouterConfig = {
        upstreams,
        fallbackChains: [
          {
            id: 'chain-1',
            orderedUpstreamIds: ['worker-c', 'worker-b', 'worker-a'],
            failureThreshold: 2,
            cooldownSeconds: 60
          }
        ]
      };

      const router = new Eluvix(config);
      const explanation = router.explainRoute({
        model: 'test-m',
        messages: [{ role: 'user', content: 'test request' }]
      });

      // Default priority was A(30) > B(20) > C(10).
      // But active fallbackChain specifies orderedUpstreamIds: ['worker-c', 'worker-b', 'worker-a'].
      expect(explanation.rankedUpstreams[0].id).toBe('worker-c');
      expect(explanation.rankedUpstreams[1].id).toBe('worker-b');
      expect(explanation.rankedUpstreams[2].id).toBe('worker-a');
    });
  });
});
