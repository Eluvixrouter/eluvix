import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Eluvix, globalCircuitBreaker } from '../index.js';

describe('v1.2 Phase 4 — Chaos & Fault-Injection Resilience Suite', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let prevXdgConfig: string | undefined;
  let prevXdgData: string | undefined;
  let chaosServer: http.Server | null = null;
  let healthyServer: http.Server | null = null;

  beforeEach(() => {
    prevXdgConfig = process.env.XDG_CONFIG_HOME;
    prevXdgData = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-v12-p4-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-v12-p4-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
    globalCircuitBreaker.reset();
  });

  afterEach(async () => {
    globalCircuitBreaker.reset();
    if (chaosServer) {
      await new Promise<void>((r) => chaosServer!.close(() => r()));
      chaosServer = null;
    }
    if (healthyServer) {
      await new Promise<void>((r) => healthyServer!.close(() => r()));
      healthyServer = null;
    }
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgData;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('survives slow-header stalls, 503 bursts, and malformed JSON via Switchyard failover within budget', async () => {
    let chaosMode: 'stall-headers' | '503-burst' | 'truncated-json' = 'stall-headers';

    chaosServer = http.createServer((_req, res) => {
      if (chaosMode === 'stall-headers') {
        // Never send headers within the 120ms upstream timeout
        setTimeout(() => {
          if (!res.writableEnded) res.destroy();
        }, 500);
        return;
      }
      if (chaosMode === '503-burst') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'CUDA OOM simulated fault' } }));
        return;
      }
      if (chaosMode === 'truncated-json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl_chaos_trunc',
            object: 'chat.completion',
            created: 1700000000,
            model: 'qwen3-8b',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"status": "broken' },
                finish_reason: 'length',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          })
        );
      }
    });

    healthyServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_healthy_backup',
          object: 'chat.completion',
          created: 1700000000,
          model: 'qwen3-8b',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({ status: 'recovered', ok: true }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
        })
      );
    });

    await new Promise<void>((r) => chaosServer!.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => healthyServer!.listen(0, '127.0.0.1', () => r()));
    const chaosPort = (chaosServer.address() as any).port;
    const healthyPort = (healthyServer.address() as any).port;

    const router = new Eluvix({
      strategy: 'priority',
      switchyard: {
        timeoutMs: 120,
        failoverBudgetMs: 2000,
        retryCount: 1,
      },
      upstreams: [
        {
          id: 'chaos-primary',
          name: 'Chaos Primary Node',
          type: 'vllm',
          endpoint: `http://127.0.0.1:${chaosPort}`,
          models: ['*'],
          priority: 10,
        },
        {
          id: 'healthy-secondary',
          name: 'Healthy Secondary Node',
          type: 'vllm',
          endpoint: `http://127.0.0.1:${healthyPort}`,
          models: ['*'],
          priority: 5,
        },
      ],
    });

    // 1. Slow-headers timeout -> automatic failover to healthy-secondary
    chaosMode = 'stall-headers';
    const res1 = await router.routeChatCompletion({
      model: 'qwen3-8b',
      messages: [{ role: 'user', content: 'Test slow headers failover' }],
    });
    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-eluvix-upstream')).toBe('healthy-secondary');

    // 2. 503 burst -> automatic failover
    globalCircuitBreaker.reset();
    chaosMode = '503-burst';
    const res2 = await router.routeChatCompletion({
      model: 'qwen3-8b',
      messages: [{ role: 'user', content: 'Test 503 failover' }],
    });
    expect(res2.status).toBe(200);
    expect(res2.headers.get('x-eluvix-upstream')).toBe('healthy-secondary');

    // 3. Truncated JSON under response_format json_schema -> escalates to healthy-secondary
    globalCircuitBreaker.reset();
    chaosMode = 'truncated-json';
    const res3 = await router.routeChatCompletion({
      model: 'qwen3-8b',
      messages: [{ role: 'user', content: 'Return JSON status' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'health_status',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              ok: { type: 'boolean' },
            },
            required: ['status', 'ok'],
          },
        },
      },
    });
    expect(res3.status).toBe(200);
    expect(res3.headers.get('x-eluvix-upstream')).toBe('healthy-secondary');
    expect(res3.headers.get('x-eluvix-schema-validation')).toBe('escalated');
  });
});
