import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Eluvix,
  type RouterConfig,
  extractAnthropicCacheBreakpoints,
  anthropicToOpenAiChatRequest,
  openAiToAnthropicMessageResponse,
  transformOpenAiSseToAnthropicSse,
  estimateUpstreamRequestCostUsd,
  translateStructuredOutputFormat,
  validateAgainstJsonSchema,
  supportsStructuredOutputs,
  applyOutputGuardToText,
  createStreamingOutputDlpTransform,
  buildOtlpTracePayload,
  OtlpTraceExporter,
  getRequestLogs,
} from '../index.js';

describe('v1.2 Phase 1 — Prompt Caching, Structured Outputs, Output Guard DLP & Real OTLP Exporter', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let origConfigHome: string | undefined;
  let origDataHome: string | undefined;

  beforeEach(() => {
    origConfigHome = process.env.XDG_CONFIG_HOME;
    origDataHome = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-p1-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-p1-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origConfigHome;
    if (origDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origDataHome;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('1.1 preserves Anthropic cache_control breakpoints, routes via KV prefix affinity, and discounts cached token cost', async () => {
    const anthropicReq = {
      model: 'claude-3-7-sonnet-20250219',
      system: [
        {
          type: 'text',
          text: 'You are a sovereign kernel security auditor with a 10,000-line codebase reference.',
          cache_control: { type: 'ephemeral' as const, ttl: '5m' },
        },
      ],
      tools: [
        {
          name: 'audit_file',
          description: 'Audit source file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'text',
              text: 'Audit src/index.ts',
              cache_control: { type: 'ephemeral' as const },
            },
          ],
        },
      ],
    };

    const breakpoints = extractAnthropicCacheBreakpoints(anthropicReq);
    expect(breakpoints).toHaveLength(3);
    expect(breakpoints.map((b) => b.scope)).toEqual(['system', 'tools', 'messages']);

    const chatReq = anthropicToOpenAiChatRequest(anthropicReq);
    expect(chatReq.metadata?._anthropicCacheBreakpoints).toHaveLength(3);
    expect(chatReq.metadata?._cachePrefixText).toContain('system:0:');

    // Verify cost calculation with 90% discount on cache_read_input_tokens (0.1x) and 1.25x on cache_creation_input_tokens
    const paidUpstream = {
      id: 'claude-cloud',
      name: 'Claude Cloud',
      type: 'anthropic' as const,
      endpoint: 'https://api.anthropic.com/v1',
      models: ['*'],
      priority: 10,
      costPer1kTokens: 0.01, // $0.01 per 1k tokens
    };
    // 1000 total prompt tokens: 800 read from cache (0.1x = 80 effective), 100 written (1.25x = 125 effective), 100 uncached (100 effective) + 200 completion = 505 effective tokens = $0.00505
    const discountedCost = estimateUpstreamRequestCostUsd(paidUpstream, 1000, 200, {
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
    });
    const fullCost = estimateUpstreamRequestCostUsd(paidUpstream, 1000, 200);
    expect(discountedCost).toBeCloseTo(0.00505, 6);
    expect(fullCost).toBeCloseTo(0.012, 6);
    expect(discountedCost).toBeLessThan(fullCost);

    // Verify openAiToAnthropicMessageResponse maps cached tokens
    const mappedMsg = openAiToAnthropicMessageResponse(
      {
        id: 'chatcmpl_cache_1',
        model: 'claude-3-7-sonnet',
        choices: [{ message: { role: 'assistant', content: 'Audit complete.' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 100,
        },
      },
      'claude-3-7-sonnet'
    );
    expect(mappedMsg.usage.cache_read_input_tokens).toBe(800);
    expect(mappedMsg.usage.cache_creation_input_tokens).toBe(100);

    // Verify routeChatCompletion emits x-eluvix-cache-read-tokens, x-eluvix-cache-write-tokens, and logs to SQLite
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 'chatcmpl_cache_live',
          choices: [{ message: { role: 'assistant', content: 'Cached response!' }, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 200,
            prompt_tokens_details: { cached_tokens: 800, cache_creation_tokens: 100 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const router = new Eluvix({
      strategy: 'cost-complexity',
      upstreams: [paidUpstream],
    });
    const res = await router.routeChatCompletion(chatReq as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-cache-read-tokens')).toBe('800');
    expect(res.headers.get('x-eluvix-cache-write-tokens')).toBe('100');
    expect(res.headers.get('x-eluvix-cost-usd')).toBe('0.005050');

    const logs = getRequestLogs(5);
    expect(logs[0]?.cache_read_tokens).toBe(800);
    expect(logs[0]?.cache_write_tokens).toBe(100);
  });

  it('1.2 translates Structured Outputs per engine, filters incapable upstreams on strict=true, repairs fences, and escalates on schema violation', async () => {
    const schema = {
      type: 'object',
      properties: {
        verdict: { type: 'string', enum: ['safe', 'vulnerable'] },
        severity: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: ['verdict', 'severity'],
      additionalProperties: false,
    };

    const reqPayload = {
      model: 'auto',
      messages: [{ role: 'user', content: 'Return JSON verdict' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'security_verdict',
          strict: true,
          schema,
        },
      },
    };

    // Per-engine translation checks
    const ollamaTrans = translateStructuredOutputFormat(reqPayload, { type: 'ollama' });
    expect(ollamaTrans.mode).toBe('ollama-format');
    expect(ollamaTrans.payload.format).toEqual(schema);

    const vllmTrans = translateStructuredOutputFormat(reqPayload, { type: 'vllm' });
    expect(vllmTrans.mode).toBe('vllm-guided-json');
    expect(vllmTrans.payload.guided_json).toEqual(schema);

    const ramalamaTrans = translateStructuredOutputFormat(reqPayload, { type: 'ramalama' });
    expect(ramalamaTrans.mode).toBe('llamacpp-json-schema');
    expect(ramalamaTrans.payload.json_schema).toEqual(schema);

    const anthropicTrans = translateStructuredOutputFormat(reqPayload, { type: 'anthropic' });
    expect(anthropicTrans.mode).toBe('anthropic-tool');
    expect(anthropicTrans.payload.tool_choice).toEqual({
      type: 'function',
      function: { name: 'security_verdict' },
    });

    // Fence repair + schema validation
    const fenced = '```json\n{"verdict":"safe","severity":2}\n```';
    const validRes = validateAgainstJsonSchema(fenced, schema, true);
    expect(validRes.valid).toBe(true);
    expect(validRes.wasFenceRepaired).toBe(true);
    expect(validRes.repairedJsonText).toBe('{"verdict":"safe","severity":2}');

    const invalidRes = validateAgainstJsonSchema('{"verdict":"unknown","severity":9}', schema, true);
    expect(invalidRes.valid).toBe(false);
    expect(invalidRes.errors.length).toBeGreaterThan(0);

    // Router candidate filtering + escalation on invalid JSON from first upstream to valid JSON on second upstream
    const config: RouterConfig = {
      strategy: 'priority',
      upstreams: [
        {
          id: 'incapable-cli',
          name: 'Incapable CLI',
          type: 'openai-compatible',
          endpoint: 'http://127.0.0.1:18001',
          models: ['*'],
          priority: 100,
          supportsStructuredOutputs: false,
        },
        {
          id: 'flaky-local',
          name: 'Flaky Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          models: ['*'],
          priority: 50,
        },
        {
          id: 'strict-vllm',
          name: 'Strict vLLM Verifier',
          type: 'vllm',
          endpoint: 'http://127.0.0.1:8000',
          models: ['*'],
          priority: 10,
        },
      ],
    };

    const router = new Eluvix(config);
    const explanation = router.explainRoute(reqPayload as any);
    const structStep = explanation.steps.find((s) => s.stage === 'structured-outputs-filter');
    expect(structStep).toBeDefined();
    expect(structStep?.removed).toContain('incapable-cli');
    expect(explanation.chosenUpstreamId).toBe('flaky-local');

    // First candidate returns invalid schema JSON; second candidate returns fenced valid JSON
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'bad_1',
            choices: [{ message: { role: 'assistant', content: '{"verdict":"wrong"}' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'good_2',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '```json\n{"verdict":"safe","severity":1}\n```',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

    const res = await router.routeChatCompletion(reqPayload as any);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-upstream')).toBe('strict-vllm');
    expect(res.headers.get('x-eluvix-schema-validation')).toBe('repaired');
    const body = await res.json();
    expect(JSON.parse(body.choices[0].message.content)).toEqual({
      verdict: 'safe',
      severity: 1,
    });
  });

  it('1.3 redacts secrets and PII in both sync JSON and split-token SSE streams via Output Guardrails', async () => {
    const syncCheck = applyOutputGuardToText(
      'Here is your key: elx_secretToken987654321 and OpenAI sk-proj-abcdef0123456789abcdef',
      {
        enabled: true,
        action: 'redact',
        detectSecrets: true,
      }
    );
    expect(syncCheck.status).toBe('redacted');
    expect(syncCheck.redactionCount).toBeGreaterThanOrEqual(2);
    expect(syncCheck.text).not.toContain('elx_secretToken987654321');
    expect(syncCheck.text).not.toContain('sk-proj-abcdef0123456789abcdef');

    // Streaming SSE DLP test where `elx_splitSecretKey123456` is split across two adjacent SSE chunks!
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const rawSseChunks = [
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"Prefix text with elx_split"},"finish_reason":null}]}\n\n',
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"SecretKey123456 and safe suffix."},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const inputStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of rawSseChunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });

    let finalGuardOutcome: any = null;
    const guardedStream = createStreamingOutputDlpTransform(
      inputStream,
      {
        enabled: true,
        action: 'redact',
        detectSecrets: true,
        holdbackChars: 48,
      },
      (res) => {
        finalGuardOutcome = res;
      }
    );

    const reader = guardedStream.getReader();
    let combinedSse = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      combinedSse += decoder.decode(value, { stream: true });
    }
    expect(combinedSse).not.toContain('elx_splitSecretKey123456');
    expect(combinedSse).toContain('[REDACTED');
    expect(finalGuardOutcome?.status).toBe('redacted');
    expect(finalGuardOutcome?.redactionCount).toBeGreaterThanOrEqual(1);
  });

  it('1.4 exports OpenTelemetry gen_ai.* & eluvix.* root + child spans over OTLP/HTTP JSON with PII scrubbing and SSRF protection', async () => {
    const exportedPayloads: any[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('/v1/traces')) {
        exportedPayloads.push(JSON.parse(String(init?.body || '{}')));
        return new Response(JSON.stringify({ partialSuccess: {} }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_otel_1',
          model: 'qwen3-coder',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Contact admin@corp.example for details.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const router = new Eluvix({
      strategy: 'cost-complexity',
      upstreams: [
        {
          id: 'local-vllm',
          name: 'Local vLLM',
          type: 'vllm',
          endpoint: 'http://127.0.0.1:8000',
          models: ['*'],
          priority: 10,
        },
      ],
      observability: {
        enabled: true,
        projectName: 'eluvix-otel-test',
        exporter: 'otlp',
        otlpEndpoint: 'http://127.0.0.1:4318/v1/traces',
        samplingRate: 100,
        captureInputs: true,
        scrubPii: true,
      },
    });

    const res = await router.routeChatCompletion({
      model: 'auto',
      messages: [{ role: 'user', content: 'My email is user@secret.org' }],
    });
    expect(res.status).toBe(200);
    const traceId = res.headers.get('x-eluvix-trace-id');
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);

    await router.flushTraces();
    expect(exportedPayloads.length).toBeGreaterThanOrEqual(1);
    const spans = exportedPayloads[0]?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans || [];
    const spanNames = spans.map((s: any) => s.name);
    expect(spanNames).toEqual(
      expect.arrayContaining(['eluvix.chat', 'eluvix.guard', 'eluvix.routing', 'eluvix.upstream'])
    );

    const rootSpan = spans.find((s: any) => s.name === 'eluvix.chat');
    const promptAttr = rootSpan.attributes.find((a: any) => a.key === 'gen_ai.prompt');
    expect(promptAttr?.value?.stringValue).not.toContain('user@secret.org');

    // Verify SSRF protection blocks cloud metadata OTLP endpoint
    const badExporter = new OtlpTraceExporter({
      enabled: true,
      exporter: 'otlp',
      otlpEndpoint: 'http://169.254.169.254/v1/traces',
    });
    badExporter.enqueueTrace({
      name: 'eluvix.chat',
      startTimeMs: 1000,
      endTimeMs: 1010,
    });
    const badFlush = await badExporter.flush(fetchSpy as any);
    expect(badFlush.ok).toBe(false);
    expect(badFlush.error).toMatch(/metadata|blocked|ssrf|unsafe/i);
  });
});
