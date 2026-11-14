import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createServerAdapter,
  derivePaperclipContextHeaders,
  executeEluvixLocal,
  getConfigSchema,
  getEluvixQuotaWindows,
  listEluvixModels,
  mapEluvixErrorToPaperclipFamily,
  redactSecrets,
  resolveEluvixApiKey,
  sessionCodec,
  STATIC_ELUVIX_MODELS,
  testEluvixEnvironment,
  validateLoopbackEluvixUrl,
} from '../server/index.js';
import { buildOpenCodeConfigContent } from '../server/opencode-process.js';

const require = createRequire(import.meta.url);
const uiParser = require('../../ui-parser.cjs') as {
  parseStdoutLine: (line: string, ts: string) => unknown[];
};

describe('@eluvix/paperclip-adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes getConfigSchema without secret field types and serializes/deserializes sessionCodec', () => {
    const schema = getConfigSchema();
    expect(schema.fields.length).toBeGreaterThan(0);
    expect(schema.fields.every((f) => (f.type as string) !== 'secret')).toBe(true);

    const encoded = sessionCodec.serialize({ sessionId: 'ses-1' });
    expect(encoded).toEqual({ sessionId: 'ses-1' });
    expect(sessionCodec.deserialize(encoded)).toEqual({ sessionId: 'ses-1' });
    expect(sessionCodec.deserialize(null)).toBeNull();
  });

  it('validates loopback-only Eluvix URLs and resolves/redacts API keys', () => {
    expect(validateLoopbackEluvixUrl('http://127.0.0.1:3588').ok).toBe(true);
    expect(validateLoopbackEluvixUrl('http://localhost:3588').ok).toBe(true);
    expect(validateLoopbackEluvixUrl('https://evil.example.com:3588').ok).toBe(false);
    expect(validateLoopbackEluvixUrl('http://169.254.169.254').ok).toBe(false);

    expect(resolveEluvixApiKey({}, { ELUVIX_API_KEY: 'elx_secret_token_123' })).toBe('elx_secret_token_123');
    expect(redactSecrets('Bearer elx_secret_token_123 failed')).not.toContain('elx_secret_token_123');
  });

  it('derives Paperclip context headers from issue and agent endpoints', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/issues/')) {
        return new Response(JSON.stringify({ priority: 'critical', labels: [{ name: 'sensitivity:confidential' }] }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          budgetMonthlyCents: 10000,
          spentMonthlyCents: 9200,
        }),
        { status: 200 }
      );
    });
    const headers = await derivePaperclipContextHeaders({
      runId: 'run-1',
      agentId: 'agt-1',
      companyId: 'cmp-1',
      taskId: 'iss-1',
      paperclipApiUrl: 'http://127.0.0.1:3100',
      paperclipAuthToken: 'pc-tok',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(headers['x-paperclip-run-id']).toBe('run-1');
    expect(headers['x-paperclip-issue-id']).toBe('iss-1');
    expect(headers['x-paperclip-issue-priority']).toBe('critical');
    expect(headers['x-paperclip-sensitivity']).toBe('confidential');
    expect(headers['x-paperclip-budget-remaining-pct']).toBe('8');
  });

  it('maps Eluvix error families cleanly', () => {
    expect(mapEluvixErrorToPaperclipFamily(401, 'unauthorized', 'bad key').errorFamily).toBe('auth_required');
    expect(mapEluvixErrorToPaperclipFamily(429, 'rate_limit_exceeded', 'rate limit').errorFamily).toBe('provider_quota');
    expect(mapEluvixErrorToPaperclipFamily(403, 'dlp_blocked', 'prompt guard').errorFamily).toBe('auth_required');
    expect(mapEluvixErrorToPaperclipFamily(400, 'dlp_blocked', 'prompt guard').errorFamily).toBe('model_refusal');
  });

  it('builds OpenCode config content with Paperclip attribution headers', () => {
    const json = buildOpenCodeConfigContent({
      eluvixBaseUrl: 'http://127.0.0.1:3588',
      eluvixApiKey: 'elx_test_1',
      paperclipHeaders: { 'x-paperclip-run-id': 'run-9' },
      model: 'eluvix/auto',
    });
    const parsed = JSON.parse(json) as any;
    expect(parsed.provider.eluvix.options.baseURL).toBe('http://127.0.0.1:3588/v1');
    expect(parsed.provider.eluvix.options.headers['x-paperclip-run-id']).toBe('run-9');
  });

  it('lists models from /api/v1/paperclip/capabilities and falls back to STATIC_ELUVIX_MODELS on failure', async () => {
    const fetchOk = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          upstreams: [{ name: 'Local Ollama', isLocal: true, models: ['qwen2.5-coder:7b'] }],
        }),
        { status: 200 }
      )
    );
    const live = await listEluvixModels(
      { config: { eluvixBaseUrl: 'http://127.0.0.1:3588' } },
      { fetch: fetchOk as unknown as typeof fetch }
    );
    expect(live.map((m) => m.id)).toContain('eluvix/auto');
    expect(live.map((m) => m.id)).toContain('qwen2.5-coder:7b');

    const fetchErr = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const fallback = await listEluvixModels(
      { config: { eluvixBaseUrl: 'http://127.0.0.1:3588' } },
      { fetch: fetchErr as unknown as typeof fetch }
    );
    expect(fallback).toEqual(STATIC_ELUVIX_MODELS);

    const quota = await getEluvixQuotaWindows();
    expect(quota).toBeDefined();
    expect(typeof quota).toBe('object');
  });

  it('checks environment via testEluvixEnvironment', async () => {
    const fetchOk = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/paperclip/whoami')) {
        return new Response(JSON.stringify({ userId: 'u1', scopes: ['paperclip'] }), { status: 200 });
      }
      return new Response(JSON.stringify({ upstreams: [{ id: 'local-ollama' }] }), { status: 200 });
    });
    const res = await testEluvixEnvironment(
      {
        companyId: 'cmp-1',
        adapterType: 'eluvix_local',
        config: {
          eluvixBaseUrl: 'http://127.0.0.1:3588',
          env: { ELUVIX_API_KEY: 'elx_test_token' },
        },
      },
      { fetch: fetchOk as unknown as typeof fetch }
    );
    expect(['pass', 'warn']).toContain(res.status);
  });

  it('executes a full OpenCode session turn and aggregates usage from Eluvix correlation store', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/session') && init?.method === 'POST' && !url.includes('/message')) {
        return new Response(JSON.stringify({ id: 'ses-test-1' }), { status: 200 });
      }
      if (url.includes('/session/ses-test-1/message')) {
        return new Response(
          JSON.stringify({
            info: { id: 'msg-1', tokens: { input: 20, output: 10 }, cost: 0.001 },
            parts: [{ type: 'text', text: 'Done via Switchyard.' }],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/v1/paperclip/usage/run-e2e')) {
        return new Response(
          JSON.stringify({
            runId: 'run-e2e',
            inputTokens: 20,
            outputTokens: 10,
            cachedInputTokens: 2,
            costUsd: 0.001,
            dominantModel: 'qwen2.5-coder:7b',
            byModel: [
              {
                model: 'qwen2.5-coder:7b',
                upstreamId: 'local-ollama',
                inputTokens: 20,
                outputTokens: 10,
                cachedInputTokens: 2,
                cacheWriteTokens: 0,
                costUsd: 0.001,
                requests: 1,
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    });

    const onLog = vi.fn();
    const res = await executeEluvixLocal(
      {
        runId: 'run-e2e',
        agent: { id: 'agt-1', companyId: 'cmp-1', name: 'Coder', adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          eluvixBaseUrl: 'http://127.0.0.1:3588',
          model: 'eluvix/auto',
          cwd: '/tmp',
          env: { ELUVIX_API_KEY: 'elx_test_token' },
        },
        context: { taskId: 'iss-1', issuePriority: 'high' },
        onLog,
      },
      {
        fetch: fetchMock as unknown as typeof fetch,
        spawnServer: async () => ({
          url: 'http://127.0.0.1:49999',
          port: 49999,
          stop: async () => undefined,
        }),
      }
    );

    expect(res.exitCode).toBe(0);
    expect(res.sessionParams?.sessionId).toBe('ses-test-1');
    expect(res.costUsd).toBe(0.001);
    expect(res.billingType).toBe('api');
    expect(res.costStatus).toBe('reported');
    expect(res.usage?.inputTokens).toBe(20);
    expect(res.usage?.outputTokens).toBe(10);
    expect(res.summary).toContain('Done via Switchyard.');
  });

  it('parses stdout JSON lines via ui-parser.cjs', () => {
    const events = uiParser.parseStdoutLine(
      JSON.stringify({ type: 'tool_use', name: 'read_file', status: 'ok' }),
      '2026-11-12T00:00:00Z'
    );
    expect(events.length).toBe(1);
  });

  it('never executes git push anywhere in adapter source', () => {
    const serverDir = path.resolve(import.meta.dirname, '../server');
    const files = fs.readdirSync(serverDir).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const content = fs.readFileSync(path.join(serverDir, file), 'utf8');
      expect(content).not.toMatch(/\bgit\s+push\b/i);
    }
    expect(createServerAdapter().type).toBe('eluvix_local');
  });
});
