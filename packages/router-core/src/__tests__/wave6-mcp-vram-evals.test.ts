import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Eluvix,
  handleEluvixMcpPayload,
  ELUVIX_MCP_PROTOCOL_VERSION,
  globalVramArbiter,
  getVramArbiterStats,
  resetVramArbiterStats,
  runEvalSuite,
  STARTER_GOLDEN_EVAL_SUITES,
  type RouterConfig,
  type EvalSuite,
} from '../index.js';
import { runEluvixEvalCli } from '../eval-cli.js';

describe('Wave 3 (Tracks 6 & 7): Native MCP Server, Cooperative GPU VRAM Arbiter & Golden Evals', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let prevXdgConfig: string | undefined;
  let prevXdgData: string | undefined;

  beforeEach(() => {
    prevXdgConfig = process.env.XDG_CONFIG_HOME;
    prevXdgData = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-w6-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-w6-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
    resetVramArbiterStats();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetVramArbiterStats();
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgData;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('handles MCP 2025-06-18 initialize, tools/call, user-scoped memory, apiKey redaction, and x-eluvix-hops loop guard', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-mcp-1',
          object: 'chat.completion',
          model: 'qwen2.5-coder:7b',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Routed via Sovereign MCP!' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const config: RouterConfig = {
      egressPolicy: 'allow-egress',
      privacyGuard: { enabled: true, action: 'anonymize', redactionStyle: 'token' },
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 30,
          models: ['qwen2.5-coder:7b', '*'],
        },
        {
          id: 'cloud-openai',
          name: 'Cloud OpenAI',
          type: 'openai-compatible',
          endpoint: 'https://api.openai.com/v1',
          apiKey: 'sk-super-secret-cloud-key',
          priority: 10,
          models: ['gpt-4o'],
        },
      ],
    };
    const router = new Eluvix(config);

    // 1. initialize + notification batch
    const initRes = (await handleEluvixMcpPayload(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ],
      { router, config, scope: { userId: 'alice' }, hops: 0 }
    )) as any[];
    expect(initRes).toHaveLength(1);
    expect(initRes[0].result.protocolVersion).toBe(ELUVIX_MCP_PROTOCOL_VERSION);

    // 2. tools/list
    const toolsRes = (await handleEluvixMcpPayload(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { router, config }
    )) as any;
    expect(toolsRes.result.tools.map((t: any) => t.name)).toContain('eluvix_route_chat');
    expect(toolsRes.result.tools.map((t: any) => t.name)).toContain('eluvix_cluster_telemetry');

    // 3. tools/call -> eluvix_route_chat
    const chatRes = (await handleEluvixMcpPayload(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'eluvix_route_chat', arguments: { prompt: 'Ping router' } },
      },
      { router, config, scope: { userId: 'alice' }, hops: 0 }
    )) as any;
    const chatPayload = JSON.parse(chatRes.result.content[0].text);
    expect(chatPayload.content).toBe('Routed via Sovereign MCP!');
    expect(chatPayload.upstream).toBe('local-ollama');

    // 4. tools/call -> eluvix_memory_store & eluvix_memory_query scoped to userId with PII scrubbing
    await handleEluvixMcpPayload(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'eluvix_memory_store',
          arguments: { content: 'Preferred stack: Rust + WebGPU for alice@secret.io' },
        },
      },
      { router, config, scope: { userId: 'alice' }, hops: 0 }
    );

    const aliceMemRes = (await handleEluvixMcpPayload(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'eluvix_memory_query', arguments: { query: 'WebGPU' } },
      },
      { router, config, scope: { userId: 'alice' }, hops: 0 }
    )) as any;
    const aliceMemories = JSON.parse(aliceMemRes.result.content[0].text);
    expect(aliceMemories.count).toBe(1);
    expect(aliceMemories.memories[0].content).toContain('[REDACTED_EMAIL]');

    const bobMemRes = (await handleEluvixMcpPayload(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'eluvix_memory_query', arguments: { query: 'WebGPU' } },
      },
      { router, config, scope: { userId: 'bob' }, hops: 0 }
    )) as any;
    expect(JSON.parse(bobMemRes.result.content[0].text).count).toBe(0);

    // 5. resources/read redacts cloud apiKey
    const topoRes = (await handleEluvixMcpPayload(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'resources/read',
        params: { uri: 'eluvix://topology/upstreams' },
      },
      { router, config }
    )) as any;
    const topoText = topoRes.result.contents[0].text;
    expect(topoText).not.toContain('sk-super-secret-cloud-key');
    expect(topoText).toContain('"hasApiKey": true');

    // 6. x-eluvix-hops >= 2 blocks recursive MCP tool calls
    const loopRes = (await handleEluvixMcpPayload(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'eluvix_route_chat', arguments: { prompt: 'Recursive loop' } },
      },
      { router, config, hops: 2 }
    )) as any;
    expect(loopRes.result.isError).toBe(true);
    expect(loopRes.result.content[0].text).toContain('max_hops_exceeded');
  });

  it('cooperatively evicts idle Ollama weights before ComfyUI and idle ComfyUI checkpoints before LLM while protecting in-flight streams and blocking IMDS SSRF', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = init?.method || 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      calls.push({ url, method, body });

      if (url.endsWith('/api/ps')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/api/generate') || url.endsWith('/free')) {
        return new Response(JSON.stringify({ done: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const config: RouterConfig = {
      vramArbiter: { enabled: true },
      upstreams: [
        {
          id: 'ollama-local',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 20,
          models: ['qwen2.5:14b'],
        },
        {
          id: 'ollama-imds-evil',
          name: 'Evil Metadata Spoof',
          type: 'ollama',
          endpoint: 'http://169.254.169.254',
          priority: 1,
          models: ['*'],
        },
        {
          id: 'comfy-local',
          name: 'Local ComfyUI',
          type: 'comfyui',
          endpoint: 'http://127.0.0.1:8188',
          priority: 20,
          models: ['*'],
        },
      ],
    };

    // 1. Hold an active LLM stream lease -> ComfyUI must NOT evict Ollama mid-stream!
    const releaseActiveLlm = await globalVramArbiter.acquireLease(config.upstreams[0], config);
    const releaseMediaWhileBusy = await globalVramArbiter.acquireLease(config.upstreams[2], config);
    expect(calls.some((c) => c.url.includes('/api/generate'))).toBe(false);
    expect(getVramArbiterStats().skippedActiveInFlight).toBe(1);
    releaseMediaWhileBusy();
    releaseActiveLlm();

    // 2. Now Ollama is idle (0 active streams) -> ComfyUI lease evicts qwen2.5:14b via keep_alive: 0, and SSRF guard skips 169.254.169.254!
    const releaseMediaIdle = await globalVramArbiter.acquireLease(config.upstreams[2], config);
    expect(calls.some((c) => c.url.includes('169.254.169.254'))).toBe(false);
    const unloadCall = calls.find((c) => c.url === 'http://127.0.0.1:11434/api/generate');
    expect(unloadCall).toBeDefined();
    expect(JSON.parse(unloadCall!.body!)).toEqual({ model: 'qwen2.5:14b', keep_alive: 0 });
    expect(getVramArbiterStats().ollamaEvictions).toBe(1);
    releaseMediaIdle();

    // 3. Subsequent local LLM lease after ComfyUI synthesis unloads idle ComfyUI checkpoints via POST /free
    const releaseNextLlm = await globalVramArbiter.acquireLease(config.upstreams[0], config);
    const freeCall = calls.find((c) => c.url === 'http://127.0.0.1:8188/free');
    expect(freeCall).toBeDefined();
    expect(JSON.parse(freeCall!.body!)).toEqual({ unload_models: true, free_memory: true });
    expect(getVramArbiterStats().comfyUiEvictions).toBe(1);
    releaseNextLlm();
  });

  it('executes $0.00 dry-run and live Golden Eval suites and enforces exit codes 0 / 1 in eluvix-eval CLI', async () => {
    const config: RouterConfig = {
      egressPolicy: 'allow-egress',
      promptGuard: { enabled: true, action: 'block' },
      privacyGuard: { enabled: true, action: 'anonymize', redactionStyle: 'token' },
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://127.0.0.1:11434',
          priority: 25,
          models: ['qwen2.5:7b', '*'],
        },
        {
          id: 'frontier-agy',
          name: 'Gemini 4 Carbon',
          type: 'antigravity',
          endpoint: 'cli://agy',
          priority: 30,
          models: ['gemini-4-carbon', '*'],
          maxComplexityScore: 4,
        },
      ],
    };

    // 1. Starter Golden Eval suite in $0.00 dry-run mode passes with zero network calls
    const dryReport = await runEvalSuite(STARTER_GOLDEN_EVAL_SUITES[0], config, { mode: 'dry-run' });
    expect(dryReport.passed).toBe(true);
    expect(dryReport.failedCases).toBe(0);

    // 2. Live mode validates JSON schema, regexMatch, and rubric assertions
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-eval-live',
          object: 'chat.completion',
          model: 'qwen2.5:7b',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '{"status":"healthy","engine":"eluvix"}',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const liveSuite: EvalSuite = {
      name: 'Live JSON Contract Suite',
      mode: 'live',
      cases: [
        {
          id: 'json-contract',
          name: 'Returns structured health JSON',
          prompt: 'Return health status JSON.',
          assertions: {
            expectedUpstream: 'local-ollama',
            regexMatch: '"engine":"eluvix"',
            jsonSchema: { required: ['status', 'engine'] },
            llmJudgeRubric: { mustIncludeAny: ['healthy'], minConfidence: 0.7 },
          },
        },
      ],
    };
    const liveReport = await runEvalSuite(liveSuite, {
      upstreams: [config.upstreams[0]],
    });
    expect(liveReport.passed).toBe(true);

    // 3. CLI returns exit code 0 on pass and exit code 1 on failing assertion
    const cfgPath = path.join(tmpConfigDir, 'eval-config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(config));
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const passExitCode = await runEluvixEvalCli([
      '--suite',
      'sovereign-safety-and-tiering',
      '--config',
      cfgPath,
      '--mode',
      'dry-run',
      '--json',
    ]);
    expect(passExitCode).toBe(0);

    const failingSuitePath = path.join(tmpConfigDir, 'failing-suite.json');
    fs.writeFileSync(
      failingSuitePath,
      JSON.stringify({
        name: 'Intentional Regression',
        cases: [
          {
            id: 'wrong-upstream',
            name: 'Expects nonexistent upstream',
            prompt: 'Hello',
            assertions: { expectedUpstream: 'nonexistent-node-999' },
          },
        ],
      })
    );
    const failExitCode = await runEluvixEvalCli([
      '--suite',
      failingSuitePath,
      '--config',
      cfgPath,
      '--mode',
      'dry-run',
    ]);
    expect(failExitCode).toBe(1);
    stdoutSpy.mockRestore();
  });
});
