import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Eluvix,
  parsePrometheusEngineMetrics,
  parseOllamaPsResponse,
  parseComfyQueueResponse,
  probeEngineLoadSignal,
  setEngineSignalForTesting,
  clearEngineSignalCache,
  createBatchFile,
  getBatchFileContent,
  createBatchJob,
  executeBatchJob,
  cancelBatchJob,
  registerPromptVersion,
  promotePromptAlias,
  resolvePromptTemplate,
  registerAlertWebhook,
  listAlertWebhooks,
  dispatchAlertWebhooks,
  computeWebhookHmacSignature,
  verifyAuditChain,
} from '../index.js';

describe('v1.2 Phase 3 — Operator Features & Live Engine Load Signals', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let prevXdgConfig: string | undefined;
  let prevXdgData: string | undefined;

  beforeEach(() => {
    prevXdgConfig = process.env.XDG_CONFIG_HOME;
    prevXdgData = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-v12-p3-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-v12-p3-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
    clearEngineSignalCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearEngineSignalCache();
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgData;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('3.1 scrapes vLLM/SGLang Prometheus /metrics, Ollama /api/ps, and ComfyUI /queue and routes away from congested engines toward warm VRAM models', async () => {
    const vllmMetricsText = `
# HELP vllm:num_requests_waiting Number of requests waiting to be processed.
# TYPE vllm:num_requests_waiting gauge
vllm:num_requests_waiting{model_name="qwen3-32b"} 4
vllm:num_requests_running{model_name="qwen3-32b"} 8
vllm:gpu_cache_usage_perc{model_name="qwen3-32b"} 0.94
`;
    const parsedProm = parsePrometheusEngineMetrics(vllmMetricsText);
    expect(parsedProm.queueWaiting).toBe(4);
    expect(parsedProm.queueRunning).toBe(8);
    expect(parsedProm.kvCacheUsageRatio).toBeCloseTo(0.94, 2);

    const parsedOllama = parseOllamaPsResponse({
      models: [{ name: 'qwen3:8b', size_vram: 6_400_000_000 }],
    });
    expect(parsedOllama.warmModels).toContain('qwen3:8b');
    expect(parsedOllama.warmModels).toContain('qwen3');
    expect(parsedOllama.vramUsedBytes).toBe(6_400_000_000);

    const parsedComfy = parseComfyQueueResponse({
      queue_running: [['job1']],
      queue_pending: [['job2'], ['job3']],
    });
    expect(parsedComfy.queueRunning).toBe(1);
    expect(parsedComfy.queueWaiting).toBe(2);

    // Probe live engine signal with mock fetch
    const probed = await probeEngineLoadSignal(
      { id: 'vllm-node-1', type: 'vllm', endpoint: 'http://127.0.0.1:8000' },
      {
        fetchImpl: (async () =>
          new Response(vllmMetricsText, { status: 200 })) as unknown as typeof fetch,
      }
    );
    expect(probed?.queueWaiting).toBe(4);
    expect(probed?.kvCacheUsageRatio).toBeCloseTo(0.94, 2);

    // Seed two candidate upstreams: congested primary vs warm secondary
    setEngineSignalForTesting('vllm-congested', {
      upstreamId: 'vllm-congested',
      engineType: 'vllm',
      reachable: true,
      scrapedAtMs: Date.now(),
      queueWaiting: 5,
      queueRunning: 8,
      kvCacheUsageRatio: 0.95,
    });
    setEngineSignalForTesting('ollama-warm', {
      upstreamId: 'ollama-warm',
      engineType: 'ollama',
      reachable: true,
      scrapedAtMs: Date.now(),
      queueWaiting: 0,
      queueRunning: 1,
      warmModels: ['qwen3:8b'],
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_load_1',
          object: 'chat.completion',
          created: 1700000000,
          model: 'qwen3:8b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `Served by ${url}` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const router = new Eluvix({
      strategy: 'priority',
      upstreams: [
        {
          id: 'vllm-congested',
          name: 'Congested vLLM',
          type: 'vllm',
          endpoint: 'http://127.0.0.1:8001',
          models: ['qwen3:8b'],
          priority: 10, // Higher static priority, but congested
        },
        {
          id: 'ollama-warm',
          name: 'Warm Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          models: ['qwen3:8b'],
          priority: 5, // Lower static priority, but warm in VRAM with 0 waiting queue
        },
      ],
    });

    const res = await router.routeChatCompletion({
      model: 'qwen3:8b',
      messages: [{ role: 'user', content: 'Hello warm model' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-upstream')).toBe('ollama-warm');
    expect(res.headers.get('x-eluvix-engine-load')).toContain('engine=ollama');
    expect(res.headers.get('x-eluvix-engine-load')).toContain('warm=true');
  });

  it('3.2 ingests JSONL batch files, executes OpenAI-compatible /v1/batches jobs, and writes output JSONL files', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      const userMsg = body.messages?.[0]?.content || '';
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_batch_item',
          object: 'chat.completion',
          created: 1700000000,
          model: 'qwen3-8b',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `BatchProcessed:${userMsg}` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const router = new Eluvix({
      strategy: 'priority',
      upstreams: [
        {
          id: 'local-batch-vllm',
          name: 'Local Batch vLLM',
          type: 'vllm',
          endpoint: 'http://127.0.0.1:8000',
          models: ['*'],
          priority: 1,
        },
      ],
    });

    const jsonlContent = [
      JSON.stringify({
        custom_id: 'req-1',
        method: 'POST',
        url: '/v1/chat/completions',
        body: { model: 'qwen3-8b', messages: [{ role: 'user', content: 'Item One' }] },
      }),
      JSON.stringify({
        custom_id: 'req-2',
        method: 'POST',
        url: '/v1/chat/completions',
        body: { model: 'qwen3-8b', messages: [{ role: 'user', content: 'Item Two' }] },
      }),
    ].join('\n');

    const batchFile = createBatchFile({
      filename: 'nightly_eval.jsonl',
      purpose: 'batch',
      contentJsonl: jsonlContent,
      userId: 'alice',
    });
    expect(batchFile.id).toMatch(/^file_/);

    const job = createBatchJob({
      input_file_id: batchFile.id,
      endpoint: '/v1/chat/completions',
      userId: 'alice',
    });
    expect(job.status).toBe('in_progress');
    expect(job.request_counts.total).toBe(2);

    const completedJob = await executeBatchJob(job.id, router, { userId: 'alice' });
    expect(completedJob?.status).toBe('completed');
    expect(completedJob?.request_counts.completed).toBe(2);
    expect(completedJob?.output_file_id).toMatch(/^file_/);

    const outJsonl = getBatchFileContent(completedJob!.output_file_id!, 'alice') || '';
    const outLines = outJsonl
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(outLines).toHaveLength(2);
    expect(outLines[0].custom_id).toBe('req-1');
    expect(outLines[0].response.body.choices[0].message.content).toBe('BatchProcessed:Item One');
    expect(outLines[1].custom_id).toBe('req-2');
    expect(outLines[1].response.body.choices[0].message.content).toBe('BatchProcessed:Item Two');

    // Also verify cancellation on a newly created job
    const jobToCancel = createBatchJob({
      input_file_id: batchFile.id,
      userId: 'alice',
    });
    const cancelled = cancelBatchJob(jobToCancel.id, 'alice');
    expect(cancelled?.status).toBe('cancelled');
  });

  it('3.3 executes /v1/rerank with PrivacyGuard PII scrubbing and sovereign BM25/overlap scoring', async () => {
    const router = new Eluvix({
      strategy: 'priority',
      privacyGuard: {
        enabled: true,
        action: 'anonymize',
        redactionStyle: 'token',
        detectPii: { email: true, ssn: true },
      },
      upstreams: [],
    });

    const res = await router.routeRerank({
      model: 'auto',
      query: 'FlashAttention-3 warp specialization on Hopper H100 GPUs for user@example.com',
      top_n: 2,
      documents: [
        'Cooking pasta with olive oil and garlic in 10 minutes.',
        'FlashAttention-3 uses warp-specialized ping-pong scheduling and WGMMA on Hopper H100 GPUs.',
        'Hopper H100 GPUs support asynchronous TMA tensor memory transfers.',
      ],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-rerank-model')).toBe('eluvix-sovereign-rerank-v1');
    const body = await res.json();
    expect(body.results).toHaveLength(2);
    // Document index 1 ("FlashAttention-3 uses warp-specialized...") must rank #1
    expect(body.results[0].index).toBe(1);
    expect(body.results[0].relevance_score).toBeGreaterThan(body.results[1].relevance_score);
  });

  it('3.4 manages versioned prompts in Prompt Registry, enforces eval-score gates on @production promotion, and resolves x-eluvix-prompt in chat completions', async () => {
    const v1 = registerPromptVersion({
      id: 'sec-triage',
      systemTemplate: 'You are Security Triage v1 for {{org}}.',
      evalScore: 0.82,
      userId: 'sec-lead',
    });
    expect(v1.version).toBe(1);

    const v2 = registerPromptVersion({
      id: 'sec-triage',
      systemTemplate: 'You are Security Triage v2 for {{org}} focusing on {{focus}}.',
      evalScore: 0.74,
      userId: 'sec-lead',
    });
    expect(v2.version).toBe(2);

    // Promoting v2 (evalScore 0.74) with minEvalScore: 0.85 must fail
    expect(() =>
      promotePromptAlias({
        promptId: 'sec-triage',
        alias: 'production',
        version: 2,
        minEvalScore: 0.85,
        actorId: 'sec-lead',
      })
    ).toThrow(/Eval gate rejected promotion/);

    // Register v3 with evalScore 0.93 and promote to @production
    const v3 = registerPromptVersion({
      id: 'sec-triage',
      systemTemplate: 'You are Security Triage v3 for {{org}} focusing on {{focus}}.',
      evalScore: 0.93,
      modelHint: 'qwen3-coder',
      userId: 'sec-lead',
    });
    const promoted = promotePromptAlias({
      promptId: 'sec-triage',
      alias: 'production',
      version: v3.version,
      minEvalScore: 0.85,
      actorId: 'sec-lead',
    });
    expect(promoted.version).toBe(3);

    const resolvedProd = resolvePromptTemplate('sec-triage@production', {
      org: 'Eluvix Labs',
      focus: 'SSRF',
    });
    expect(resolvedProd?.version).toBe(3);
    expect(resolvedProd?.renderedSystemPrompt).toBe(
      'You are Security Triage v3 for Eluvix Labs focusing on SSRF.'
    );

    // Verify audit chain recorded the prompt registrations and promotion intact
    expect(verifyAuditChain().valid).toBe(true);

    // Verify Eluvix.routeChatCompletion injects the resolved prompt and sets x-eluvix-prompt
    let upstreamMessages: any[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      upstreamMessages = body.messages || [];
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_prompt_reg',
          object: 'chat.completion',
          created: 1700000000,
          model: body.model || 'qwen3-coder',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Triaged.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const router = new Eluvix({
      strategy: 'priority',
      upstreams: [
        {
          id: 'coder-node',
          name: 'Coder Node',
          type: 'vllm',
          endpoint: 'http://127.0.0.1:8000',
          models: ['qwen3-coder'],
          priority: 1,
        },
      ],
    });

    const chatRes = await router.routeChatCompletion({
      model: 'auto',
      messages: [{ role: 'user', content: 'Check URL parser' }],
      metadata: {
        promptRef: 'sec-triage@production',
        promptVariables: { org: 'Eluvix Core', focus: 'IMDSv2' },
      },
    });
    expect(chatRes.status).toBe(200);
    expect(chatRes.headers.get('x-eluvix-prompt')).toBe('sec-triage@v3');
    expect(upstreamMessages[0].role).toBe('system');
    expect(upstreamMessages[0].content).toContain(
      'You are Security Triage v3 for Eluvix Core focusing on IMDSv2.'
    );
  });

  it('3.5 dispatches HMAC-signed Alerting Webhooks (JSON & Slack) with SSRF protection and 5xx retry', async () => {
    // SSRF guard blocks AWS IMDS webhook registration
    expect(() =>
      registerAlertWebhook({
        name: 'Evil IMDS Webhook',
        url: 'http://169.254.169.254/latest/meta-data',
      })
    ).toThrow();

    const wh = registerAlertWebhook({
      name: 'SecOps JSON Webhook',
      url: 'http://127.0.0.1:9099/hooks/eluvix',
      provider: 'json',
      secret: 'whsec_test_signing_key',
      events: ['budget.threshold', 'audit.tamper_detected'],
    });
    expect(wh.hasSecret).toBe(true);
    expect(listAlertWebhooks()).toHaveLength(1);

    let attempts = 0;
    let receivedSig = '';
    let receivedBody = '';

    const mockFetch = vi.fn(async (_url: any, init: any) => {
      attempts += 1;
      receivedSig = init.headers['X-Eluvix-Signature'] || '';
      receivedBody = String(init.body || '');
      if (attempts === 1) {
        // Simulate transient 503 on first attempt to verify retry
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const dispatchRes = await dispatchAlertWebhooks(
      {
        event: 'budget.threshold',
        severity: 'warning',
        summary: '24h rolling cloud spend reached 90% ($18.00 / $20.00)',
        data: { spendUsd: 18.0, capUsd: 20.0 },
      },
      { fetchImpl: mockFetch }
    );

    expect(dispatchRes.delivered).toBe(1);
    expect(dispatchRes.failed).toBe(0);
    expect(attempts).toBe(2);
    expect(receivedSig).toBe(computeWebhookHmacSignature(receivedBody, 'whsec_test_signing_key'));
  });
});
