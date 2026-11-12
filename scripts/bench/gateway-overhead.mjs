#!/usr/bin/env node
/**
 * Eluvix Gateway Overhead Benchmark (`scripts/bench/gateway-overhead.mjs`).
 *
 * Measures pure Eluvix routing + PromptGuard + PrivacyGuard + OutputGuard + telemetry
 * overhead against a zero-latency in-process mock upstream, asserting p50 < 10ms and p99 < 25ms.
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Eluvix } from '../../packages/router-core/dist/index.js';

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-bench-cfg-'));
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-bench-data-'));
process.env.XDG_CONFIG_HOME = tmpCfg;
process.env.XDG_DATA_HOME = tmpData;

const upstreamPayload = JSON.stringify({
  id: 'chatcmpl_bench',
  object: 'chat.completion',
  created: 1700000000,
  model: 'qwen3-8b',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Sovereign benchmark response.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
});

const router = new Eluvix(
  {
    strategy: 'cost-complexity',
    promptGuard: { enabled: true, mode: 'heuristic', enforcementAction: 'block' },
    privacyGuard: { enabled: true, action: 'anonymize', redactionStyle: 'token' },
    outputGuard: { enabled: true, action: 'redact', detectSecrets: true },
    upstreams: [
      {
        id: 'bench-vllm',
        name: 'Bench vLLM',
        type: 'vllm',
        endpoint: 'http://127.0.0.1:18000',
        models: ['qwen3-8b'],
        priority: 1,
      },
    ],
  },
  {
    fetch: async () =>
      new Response(upstreamPayload, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  }
);

// Warm up SQLite + JIT
for (let i = 0; i < 15; i++) {
  await router.routeChatCompletion({
    model: 'qwen3-8b',
    messages: [{ role: 'user', content: 'Warmup request' }],
  });
}

const totalRequests = 200;
const latenciesMs = [];

for (let i = 0; i < totalRequests; i++) {
  const t0 = performance.now();
  const res = await router.routeChatCompletion({
    model: 'auto',
    messages: [{ role: 'user', content: `Benchmark turn ${i}: check latency overhead.` }],
  });
  await res.text();
  latenciesMs.push(performance.now() - t0);
}

latenciesMs.sort((a, b) => a - b);
const p50 = latenciesMs[Math.floor(latenciesMs.length * 0.5)];
const p95 = latenciesMs[Math.floor(latenciesMs.length * 0.95)];
const p99 = latenciesMs[Math.floor(latenciesMs.length * 0.99)];

fs.rmSync(tmpCfg, { recursive: true, force: true });
fs.rmSync(tmpData, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      benchmark: 'eluvix-gateway-overhead',
      requests: totalRequests,
      p50_ms: Number(p50.toFixed(3)),
      p95_ms: Number(p95.toFixed(3)),
      p99_ms: Number(p99.toFixed(3)),
      budget_p50_ms: 10,
      budget_p99_ms: 25,
      passed: p50 < 10 && p99 < 25,
    },
    null,
    2
  )
);

if (p50 >= 10 || p99 >= 25) {
  console.error(`Gateway overhead exceeded budget: p50=${p50.toFixed(2)}ms, p99=${p99.toFixed(2)}ms`);
  process.exit(1);
}
