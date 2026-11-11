import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  Eluvix,
  isBlockedSsrfHost,
  validateUpstreamHttpEndpoint,
  isBlockedMetadataOrInvalidHost,
  executeComfyWorkflow,
  fetchComfyMediaAsBase64,
  probeComfyUISystemStatus,
  logRequest,
  getRollingSpendUsd,
  getEffectiveCostPer1kTokens,
  estimateUpstreamRequestCostUsd,
  type UpstreamConfig,
} from '../index.js';

describe('Wave 3 — Track 6: Unified Browser-Safe SSRF & Cloud Metadata Guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks loopback, RFC1918 LAN, CGNAT, and IMDS in strict public egress mode (allowLoopbackAndLan: false)', () => {
    // Blocked in strict public mode
    expect(isBlockedSsrfHost('localhost')).toBe(true);
    expect(isBlockedSsrfHost('127.0.0.1')).toBe(true);
    expect(isBlockedSsrfHost('::1')).toBe(true);
    expect(isBlockedSsrfHost('10.0.0.12')).toBe(true);
    expect(isBlockedSsrfHost('172.20.4.9')).toBe(true);
    expect(isBlockedSsrfHost('192.168.1.50')).toBe(true);
    expect(isBlockedSsrfHost('100.88.1.4')).toBe(true); // Tailscale CGNAT
    expect(isBlockedSsrfHost('gpu-box.local')).toBe(true);

    // Cloud IMDS & obfuscated encodings
    expect(isBlockedSsrfHost('169.254.169.254')).toBe(true);
    expect(isBlockedSsrfHost('100.100.100.200')).toBe(true); // Alibaba IMDS
    expect(isBlockedSsrfHost('fd00:ec2::254')).toBe(true); // AWS IPv6 IMDS
    expect(isBlockedSsrfHost('::ffff:a9fe:a9fe')).toBe(true);
    expect(isBlockedSsrfHost('2852039166')).toBe(true); // decimal 169.254.169.254
    expect(isBlockedSsrfHost('0xa9fea9fe')).toBe(true); // hex 169.254.169.254
    expect(isBlockedSsrfHost('0251.0376.0251.0376')).toBe(true); // octal
    expect(isBlockedSsrfHost('64:ff9b::a9fe:a9fe')).toBe(true); // NAT64
    expect(isBlockedSsrfHost('metadata.google.internal')).toBe(true);
    expect(isBlockedSsrfHost('metadata.google.internal.')).toBe(true);
    expect(isBlockedSsrfHost('0.0.0.0')).toBe(true);

    // Public endpoints permitted
    expect(isBlockedSsrfHost('api.openai.com')).toBe(false);
    expect(isBlockedSsrfHost('8.8.8.8')).toBe(false);
  });

  it('permits loopback & LAN AI servers in allowLoopbackAndLan: true mode while strictly blocking IMDS, 0.0.0.0, credentials, and bad schemes', () => {
    const localOpts = { allowLoopbackAndLan: true };

    expect(validateUpstreamHttpEndpoint('http://localhost:8188', localOpts).ok).toBe(true);
    expect(validateUpstreamHttpEndpoint('http://127.0.0.1:8080', localOpts).ok).toBe(true);
    expect(validateUpstreamHttpEndpoint('http://[::1]:11434', localOpts).ok).toBe(true);
    expect(validateUpstreamHttpEndpoint('http://192.168.1.50:8188', localOpts).ok).toBe(true);
    expect(validateUpstreamHttpEndpoint('http://10.0.1.25:8000', localOpts).ok).toBe(true);
    expect(validateUpstreamHttpEndpoint('http://100.90.12.4:8188', localOpts).ok).toBe(true); // Tailscale LAN
    expect(validateUpstreamHttpEndpoint('http://workstation.local:8188', localOpts).ok).toBe(true);

    // Cloud IMDS & dangerous endpoints remain strictly blocked even with allowLoopbackAndLan: true
    expect(validateUpstreamHttpEndpoint('http://169.254.169.254/latest/meta-data', localOpts).ok).toBe(false);
    expect(validateUpstreamHttpEndpoint('http://[::ffff:169.254.169.254]/latest', localOpts).ok).toBe(false);
    expect(validateUpstreamHttpEndpoint('http://2852039166/latest', localOpts).ok).toBe(false);
    expect(validateUpstreamHttpEndpoint('http://100.100.100.200/latest/meta-data', localOpts).ok).toBe(false);
    expect(validateUpstreamHttpEndpoint('http://[fd00:ec2::254]/latest/api/token', localOpts).ok).toBe(false);
    expect(validateUpstreamHttpEndpoint('http://metadata.google.internal/computeMetadata/v1/', localOpts).ok).toBe(false);
    expect(validateUpstreamHttpEndpoint('http://0.0.0.0:8188', localOpts).ok).toBe(false);

    // Non-HTTP(S) schemes & embedded credentials blocked
    expect(validateUpstreamHttpEndpoint('file:///etc/passwd', localOpts).ok).toBe(false);
    expect(validateUpstreamHttpEndpoint('gopher://localhost:8188', localOpts).ok).toBe(false);
    expect(validateUpstreamHttpEndpoint('http://admin:secret@localhost:8188', localOpts).ok).toBe(false);
    expect(isBlockedMetadataOrInvalidHost('http://169.254.169.254')).toBe(true);
    expect(isBlockedMetadataOrInvalidHost('http://127.0.0.1:8188')).toBe(false);
  });

  it('prevents ComfyUI workflow, media fetch, and status probe helpers from contacting cloud metadata endpoints', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      executeComfyWorkflow('http://169.254.169.254', {
        '1': { class_type: 'KSampler', inputs: {} },
      })
    ).rejects.toThrow(/Blocked unsafe ComfyUI endpoint/i);

    await expect(
      fetchComfyMediaAsBase64('http://metadata.google.internal/view?filename=test.png')
    ).rejects.toThrow(/Blocked unsafe ComfyUI media URL/i);

    const status = await probeComfyUISystemStatus('http://[fd00:ec2::254]');
    expect(status.online).toBe(false);
    expect(status.error).toMatch(/Blocked/i);

    // Zero network requests were dispatched to the metadata targets
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Wave 3 — Track 7: Rolling 24h Cloud Spend Guardrails & Cost Persistence', () => {
  let testDataDir: string;
  const origXdgData = process.env.XDG_DATA_HOME;
  const origXdgConfig = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-wave3-budget-'));
    process.env.XDG_DATA_HOME = path.join(testDataDir, 'data');
    process.env.XDG_CONFIG_HOME = path.join(testDataDir, 'config');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origXdgData !== undefined) {
      process.env.XDG_DATA_HOME = origXdgData;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    if (origXdgConfig !== undefined) {
      process.env.XDG_CONFIG_HOME = origXdgConfig;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    try {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch {}
  });

  it('distinguishes $0.00 local upstreams from paid cloud upstreams and aggregates rolling 24h spend in SQLite', () => {
    const localRama: UpstreamConfig = {
      id: 'rama-local',
      name: 'Local RamaLama',
      type: 'ramalama',
      endpoint: 'http://localhost:8080',
      priority: 20,
      models: ['qwen2.5-coder:7b'],
    };
    const localOpenAiCompat: UpstreamConfig = {
      id: 'llama-cpp-local',
      name: 'Local llama.cpp',
      type: 'openai-compatible',
      endpoint: 'http://127.0.0.1:8081',
      priority: 18,
      models: ['*'],
    };
    const remoteCloudDefault: UpstreamConfig = {
      id: 'openai-cloud',
      name: 'OpenAI Cloud',
      type: 'openai-compatible',
      endpoint: 'https://api.openai.com',
      priority: 10,
      models: ['gpt-4o'],
    };
    const remoteCloudCustom: UpstreamConfig = {
      id: 'frontier-cloud',
      name: 'Frontier Cloud',
      type: 'openai-compatible',
      endpoint: 'https://api.example.com',
      priority: 10,
      costPer1kTokens: 0.02,
      models: ['*'],
    };

    expect(getEffectiveCostPer1kTokens(localRama)).toBe(0);
    expect(getEffectiveCostPer1kTokens(localOpenAiCompat)).toBe(0);
    expect(getEffectiveCostPer1kTokens(remoteCloudDefault)).toBe(0.005);
    expect(getEffectiveCostPer1kTokens(remoteCloudCustom)).toBe(0.02);
    expect(estimateUpstreamRequestCostUsd(remoteCloudCustom, 500, 500)).toBe(0.02);

    expect(getRollingSpendUsd(24)).toBe(0);

    logRequest({
      model: 'gpt-4o',
      upstream_id: 'openai-cloud',
      status: 200,
      duration_ms: 420,
      prompt_tokens: 1000,
      completion_tokens: 500,
      cost_usd: 1.75,
    });
    logRequest({
      model: 'gpt-4o',
      upstream_id: 'openai-cloud',
      status: 200,
      duration_ms: 380,
      prompt_tokens: 800,
      completion_tokens: 400,
      cost_usd: 0.5,
    });

    expect(getRollingSpendUsd(24)).toBe(2.25);
  });

  it('soft-fails over from paid cloud to $0.00 local sovereign upstream on prefer-local when 24h spend >= maxDailySpendUsd', async () => {
    // Seed $2.50 in rolling 24h cloud spend (exceeding maxDailySpendUsd: $2.00)
    logRequest({
      model: 'gpt-4o',
      upstream_id: 'paid-cloud',
      status: 200,
      duration_ms: 500,
      cost_usd: 2.5,
    });

    const router = new Eluvix({
      strategy: 'priority',
      switchyard: {
        strategy: 'priority',
        maxDailySpendUsd: 2.0,
        budgetExhaustedAction: 'prefer-local',
      },
      upstreams: [
        {
          id: 'paid-cloud',
          name: 'Paid Cloud Frontier',
          type: 'openai-compatible',
          endpoint: 'https://api.paid-cloud.example',
          apiKey: 'sk-test',
          priority: 100,
          costPer1kTokens: 0.02,
          models: ['*'],
        },
        {
          id: 'local-ramalama',
          name: 'Local RamaLama Sovereign',
          type: 'ramalama',
          endpoint: 'http://127.0.0.1:8080',
          priority: 10,
          costPer1kTokens: 0,
          models: ['*'],
        },
      ],
    });

    // Verify explainRoute reports the budget-guardrail step and selects local-ramalama
    const explanation = router.explainRoute({
      model: 'auto',
      messages: [{ role: 'user', content: 'Summarize local container isolation.' }],
    });
    expect(explanation.chosenUpstreamId).toBe('local-ramalama');
    expect(explanation.steps.some((s) => s.stage === 'budget-guardrail')).toBe(true);

    // Verify live completion routes to local-ramalama and emits budget fallback headers
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      expect(url).toContain('127.0.0.1:8080');
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-local-1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Served locally for $0.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const res = await router.routeChatCompletion({
      model: 'auto',
      messages: [{ role: 'user', content: 'Summarize local container isolation.' }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-upstream')).toBe('local-ramalama');
    expect(res.headers.get('x-eluvix-budget-fallback')).toBe('local-sovereign');
    expect(Number(res.headers.get('x-eluvix-rolling-24h-spend-usd'))).toBeCloseTo(2.5, 4);
    expect(Number(res.headers.get('x-eluvix-cost-usd'))).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('enforces strict-local (429 when only paid upstreams exist) and reject (429 even when local exists) once 24h cap is reached', async () => {
    logRequest({
      model: 'gpt-4o',
      upstream_id: 'paid-cloud',
      status: 200,
      duration_ms: 400,
      cost_usd: 5.25,
    });

    const strictRouter = new Eluvix({
      switchyard: {
        maxDailySpendUsd: 5.0,
        budgetExhaustedAction: 'strict-local',
      },
      upstreams: [
        {
          id: 'paid-cloud',
          name: 'Paid Cloud Only',
          type: 'openai-compatible',
          endpoint: 'https://api.paid-cloud.example',
          priority: 20,
          costPer1kTokens: 0.015,
          models: ['*'],
        },
      ],
    });

    const strictRes = await strictRouter.routeChatCompletion({
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello world' }],
    });
    expect(strictRes.status).toBe(429);
    expect(strictRes.headers.get('x-eluvix-budget-guard')).toBe('DENIED_DAILY_SPEND_CAP');
    const strictBody = await strictRes.json();
    expect(strictBody.error.type).toBe('budget_exceeded');

    const rejectRouter = new Eluvix({
      switchyard: {
        maxDailySpendUsd: 5.0,
        budgetExhaustedAction: 'reject',
      },
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 20,
          costPer1kTokens: 0,
          models: ['*'],
        },
      ],
    });

    const rejectRes = await rejectRouter.routeChatCompletion({
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello world' }],
    });
    expect(rejectRes.status).toBe(429);
    expect(rejectRes.headers.get('x-eluvix-budget-guard')).toBe('DENIED_DAILY_SPEND_CAP');
  });

  it('persists estimated cloud cost_usd on completion so crossing maxDailySpendUsd automatically triggers fallback on the next request', async () => {
    const router = new Eluvix({
      strategy: 'priority',
      switchyard: {
        strategy: 'priority',
        maxDailySpendUsd: 0.05,
        budgetExhaustedAction: 'prefer-local',
      },
      upstreams: [
        {
          id: 'paid-cloud',
          name: 'Paid Cloud',
          type: 'openai-compatible',
          endpoint: 'https://api.paid-cloud.example',
          apiKey: 'sk-live',
          priority: 100,
          costPer1kTokens: 0.1, // $0.10 per 1K tokens -> 1,000 tokens = $0.10 (> $0.05 cap!)
          models: ['*'],
        },
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 10,
          costPer1kTokens: 0,
          models: ['*'],
        },
      ],
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.paid-cloud.example')) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-paid-1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Cloud answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 600, completion_tokens: 400, total_tokens: 1000 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-local-2',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Local sovereign fallback' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // Request 1: 24h spend is $0.00 (< $0.05), so paid-cloud wins and logs $0.10
    const first = await router.routeChatCompletion({
      model: 'auto',
      messages: [{ role: 'user', content: 'First query' }],
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('x-eluvix-upstream')).toBe('paid-cloud');
    expect(Number(first.headers.get('x-eluvix-cost-usd'))).toBeCloseTo(0.1, 4);
    expect(getRollingSpendUsd(24)).toBeCloseTo(0.1, 4);

    // Request 2: 24h spend is now $0.10 (>= $0.05), so Switchyard automatically fails over to local-ollama!
    const second = await router.routeChatCompletion({
      model: 'auto',
      messages: [{ role: 'user', content: 'Second query' }],
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-eluvix-upstream')).toBe('local-ollama');
    expect(second.headers.get('x-eluvix-budget-fallback')).toBe('local-sovereign');
  });
});
