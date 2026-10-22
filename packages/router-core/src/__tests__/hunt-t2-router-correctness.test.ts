import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Eluvix,
  RouterConfig,
  UpstreamConfig,
  buildCliPrompt,
  MAX_RESPONSE_CACHE_ENTRIES
} from '../index.js';

// Mock DB interactions (same as switchyard.test.ts / p2-routing.test.ts)
vi.mock('../db.js', () => ({
  logRequest: vi.fn(),
  getRequestLogs: vi.fn().mockReturnValue([])
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const UPSTREAM: UpstreamConfig = {
  id: 'only-upstream',
  name: 'Only Upstream',
  type: 'openai-compatible',
  endpoint: 'http://localhost:9999',
  priority: 10,
  models: ['test-model']
};

function cachingConfig(extra: Partial<RouterConfig> = {}): RouterConfig {
  return {
    strategy: 'cost-complexity',
    modelGateway: { caching: { enabled: true, ttlSeconds: 3600 } },
    upstreams: [UPSTREAM],
    ...extra
  };
}

function okJsonFetch(counter: { count: number }) {
  return vi.fn().mockImplementation(async () => {
    counter.count++;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
}

describe('Response cache key captures response-shaping fields (finding 7)', () => {
  it('does not serve a cached non-streaming body to a streaming request', async () => {
    const counter = { count: 0 };
    globalThis.fetch = okJsonFetch(counter);
    const router = new Eluvix(cachingConfig());
    const messages = [{ role: 'user', content: 'cache me' }];

    const plain = await router.routeChatCompletion({ model: 'test-model', messages });
    expect(plain.status).toBe(200);
    expect(counter.count).toBe(1);

    // Identical repeat: still a hit.
    const repeat = await router.routeChatCompletion({ model: 'test-model', messages });
    expect(repeat.headers.get('X-Eluvix-Cache')).toBe('HIT');
    expect(counter.count).toBe(1);

    // Same messages with stream: true must MISS — a streaming request
    // must never be handed the buffered JSON body as application/json.
    const streamed = await router.routeChatCompletion({ model: 'test-model', messages, stream: true });
    expect(streamed.headers.get('X-Eluvix-Cache')).not.toBe('HIT');
    expect(counter.count).toBe(2);
  });

  it('does not serve a tool-less cached answer to a tools variant', async () => {
    const counter = { count: 0 };
    globalThis.fetch = okJsonFetch(counter);
    const router = new Eluvix(cachingConfig());
    const messages = [{ role: 'user', content: 'with tools?' }];
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];

    await router.routeChatCompletion({ model: 'test-model', messages });
    expect(counter.count).toBe(1);

    const withTools = await router.routeChatCompletion({ model: 'test-model', messages, tools });
    expect(withTools.headers.get('X-Eluvix-Cache')).not.toBe('HIT');
    expect(counter.count).toBe(2);

    // The tools variant is cached under its own key.
    const withToolsRepeat = await router.routeChatCompletion({ model: 'test-model', messages, tools });
    expect(withToolsRepeat.headers.get('X-Eluvix-Cache')).toBe('HIT');
    expect(counter.count).toBe(2);
  });

  it('keys sampling params: a temperature variant misses, its repeat hits', async () => {
    const counter = { count: 0 };
    globalThis.fetch = okJsonFetch(counter);
    const router = new Eluvix(cachingConfig());
    const messages = [{ role: 'user', content: 'sampled' }];

    await router.routeChatCompletion({ model: 'test-model', messages });
    expect(counter.count).toBe(1);

    const variant = await router.routeChatCompletion({ model: 'test-model', messages, temperature: 0.7 });
    expect(variant.headers.get('X-Eluvix-Cache')).not.toBe('HIT');
    expect(counter.count).toBe(2);

    const variantRepeat = await router.routeChatCompletion({ model: 'test-model', messages, temperature: 0.7 });
    expect(variantRepeat.headers.get('X-Eluvix-Cache')).toBe('HIT');
    expect(counter.count).toBe(2);
  });
});

describe('Stalled upstream body is bounded by the attempt deadline (finding 8)', () => {
  function stalledResponse(signal?: AbortSignal) {
    // Sends headers + a partial JSON body, then never ends — like a real
    // fetch, the body errors when the router aborts the attempt.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"par'));
        signal?.addEventListener('abort', () => {
          try { controller.error(new Error('aborted')); } catch {}
        });
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  it('fails over to a healthy upstream instead of hanging on the stalled body', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: any, opts: any) => {
      if (String(url).includes('9998')) {
        return stalledResponse(opts?.signal);
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'healthy' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const router = new Eluvix({
      strategy: 'cost-complexity',
      switchyard: { timeoutMs: 200, failoverBudgetMs: 30000 },
      upstreams: [
        { ...UPSTREAM, id: 'stalling', name: 'Stalling', endpoint: 'http://localhost:9998', priority: 30 },
        { ...UPSTREAM, id: 'healthy', name: 'Healthy', endpoint: 'http://localhost:9997', priority: 20 }
      ]
    });

    const start = Date.now();
    const res = await router.routeChatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }]
    });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-upstream')).toBe('healthy');
    expect(elapsed).toBeLessThan(2000);
  }, 10000);

  it('errors in bounded time when the only upstream stalls its body', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_url: any, opts: any) =>
      stalledResponse(opts?.signal)
    );
    const router = new Eluvix({
      strategy: 'cost-complexity',
      switchyard: { timeoutMs: 200, failoverBudgetMs: 30000 },
      upstreams: [UPSTREAM]
    });

    const start = Date.now();
    await expect(router.routeChatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }]
    })).rejects.toThrow('All upstreams failed');
    expect(Date.now() - start).toBeLessThan(2000);
  }, 10000);
});

describe('Antigravity CLI failures fail the attempt (finding 11)', () => {
  let fakeDir: string;
  const agyPaths: Record<string, string> = {};

  function writeFakeAgy(name: string, lines: string[]): string {
    const dir = path.join(fakeDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'agy');
    fs.writeFileSync(p, lines.join('\n') + '\n', { mode: 0o755 });
    return p;
  }

  beforeAll(() => {
    fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-t2-agy-'));
    // Exits 0 while reporting an ERROR result whose text is an error
    // message, not a reply.
    agyPaths.error = writeFakeAgy('error', [
      '#!/bin/sh',
      `printf '%s\\n' '{"event":"result","result":{"response":"backend exploded","status":"ERROR"}}'`,
      'exit 0'
    ]);
    // Exits 0 producing no output at all.
    agyPaths.silent = writeFakeAgy('silent', ['#!/bin/sh', 'exit 0']);
    // Streams one delta, then reports an ERROR result.
    agyPaths.streamError = writeFakeAgy('stream-error', [
      '#!/bin/sh',
      `printf '%s\\n' '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"partial "}}'`,
      `printf '%s\\n' '{"event":"result","result":{"response":"backend exploded","status":"ERROR"}}'`,
      'exit 0'
    ]);
    // Streaming request whose only output is an ERROR result.
    agyPaths.streamErrorOnly = writeFakeAgy('stream-error-only', [
      '#!/bin/sh',
      `printf '%s\\n' '{"event":"result","result":{"response":"backend exploded","status":"ERROR"}}'`,
      'exit 0'
    ]);
  });

  afterAll(() => {
    try { fs.rmSync(fakeDir, { recursive: true, force: true }); } catch {}
  });

  function agyRouter(cliPath: string, extraUpstreams: UpstreamConfig[] = []): Eluvix {
    return new Eluvix({
      strategy: 'cost-complexity',
      upstreams: [
        {
          id: 'antigravity-agent',
          name: 'Antigravity Agent',
          type: 'antigravity',
          endpoint: 'cli://agy',
          priority: 28,
          models: ['gemini-4-argon'],
          antigravity: { cliPath, cwd: fakeDir, cleanHeadless: false }
        },
        ...extraUpstreams
      ]
    });
  }

  it('non-streaming: an ERROR result is not returned as a 200 reply; failover proceeds', async () => {
    const counter = { count: 0 };
    globalThis.fetch = okJsonFetch(counter);
    const router = agyRouter(agyPaths.error, [
      { ...UPSTREAM, id: 'fallback', name: 'Fallback', priority: 10, models: ['gemini-4-argon'] }
    ]);
    const res = await router.routeChatCompletion({
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: 'hello' }]
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-upstream')).toBe('fallback');
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('ok');
  });

  it('non-streaming: an ERROR result with no fallback rejects instead of returning the error text', async () => {
    const router = agyRouter(agyPaths.error);
    await expect(router.routeChatCompletion({
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: 'hello' }]
    })).rejects.toThrow('All upstreams failed');
  });

  it('non-streaming: agy exiting 0 with no output fails the attempt instead of an empty 200', async () => {
    const router = agyRouter(agyPaths.silent);
    await expect(router.routeChatCompletion({
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: 'hello' }]
    })).rejects.toThrow('All upstreams failed');
  });

  it('streaming: an ERROR result after deltas errors the stream instead of a clean stop', async () => {
    const router = agyRouter(agyPaths.streamError);
    const res = await router.routeChatCompletion({
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true
    });
    await expect(res.text()).rejects.toThrow(/agy CLI reported an error/);
  });

  it('streaming: an ERROR-only result fails the attempt instead of streaming a 200', async () => {
    const router = agyRouter(agyPaths.streamErrorOnly);
    await expect(router.routeChatCompletion({
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true
    })).rejects.toThrow('All upstreams failed');
  });
});

describe('Antigravity disk model cache honors the TTL (finding 19)', () => {
  const cacheDir = path.join(os.tmpdir(), 'eluvix-test-config');
  const cacheFile = path.join(cacheDir, 'agy-models-cache.json');
  const markerModels = [{
    baseId: 'gemini-9-marker',
    displayName: 'Marker Model',
    efforts: ['low'],
    defaultEffort: 'low',
    variants: [],
    tier: 'Standard',
    contextLimit: 1000,
    outputLimit: 1000
  }];

  function writeDiskCache(timestamp: number) {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ models: markerModels, timestamp }), 'utf-8');
  }

  function removeDiskCache() {
    try { fs.rmSync(cacheFile, { force: true }); } catch {}
  }

  afterEach(() => {
    removeDiskCache();
    vi.resetModules();
  });

  it('does not serve a disk cache written 7 days ago as current', async () => {
    writeDiskCache(Date.now() - 7 * 24 * 3600 * 1000);
    try {
      vi.resetModules();
      const mod = await import('../antigravity-models.js');
      const models = mod.getCachedAntigravityModels();
      expect(models.map(m => m.baseId)).not.toContain('gemini-9-marker');
      expect(models).toEqual(mod.DEFAULT_AGY_MODELS);
    } finally {
      removeDiskCache();
    }
  });

  it('still serves a fresh disk cache', async () => {
    writeDiskCache(Date.now());
    try {
      vi.resetModules();
      const mod = await import('../antigravity-models.js');
      const models = mod.getCachedAntigravityModels();
      expect(models.map(m => m.baseId)).toContain('gemini-9-marker');
    } finally {
      removeDiskCache();
    }
  });
});

describe('buildCliPrompt keeps the head of an oversized newest message (finding 20)', () => {
  it('truncates a single ~150KB message instead of dropping it entirely', () => {
    const big = 'x'.repeat(150000);
    const prompt = buildCliPrompt([{ role: 'user', content: big }], 100000);
    expect(prompt).toContain('x'.repeat(1000)); // head of the user's text survives
    expect(prompt).toContain('truncated');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(100000);
  });

  it('truncates the newest message while keeping the system prompt within budget', () => {
    const big = 'y'.repeat(150000);
    const prompt = buildCliPrompt([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'an older short message' },
      { role: 'user', content: big }
    ], 100000);
    expect(prompt).toContain('[SYSTEM]: You are helpful.');
    expect(prompt).toContain('y'.repeat(1000));
    expect(prompt).toContain('truncated');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(100000);
  });
});

describe('In-process caches stay bounded (finding 22)', () => {
  it('caps the response cache at MAX_RESPONSE_CACHE_ENTRIES, evicting oldest', async () => {
    const capEntries = MAX_RESPONSE_CACHE_ENTRIES ?? 500;
    const counter = { count: 0 };
    globalThis.fetch = okJsonFetch(counter);
    const router = new Eluvix(cachingConfig());
    const total = capEntries + 10;
    for (let i = 0; i < total; i++) {
      const res = await router.routeChatCompletion({
        model: 'test-model',
        messages: [{ role: 'user', content: `question ${i}` }]
      });
      expect(res.status).toBe(200);
    }
    const cache = (router as any).responseCache as Map<string, any>;
    expect(cache.size).toBeLessThanOrEqual(capEntries);
    // The most recent entry is retained; the oldest were evicted.
    const keys = [...cache.keys()];
    expect(keys.some(k => k.includes('question 0'))).toBe(false);
    expect(keys.some(k => k.includes(`question ${total - 1}`))).toBe(true);
  }, 30000);

  it('deletes an expired cache entry when it is read, instead of leaving it stored', async () => {
    const counter = { count: 0 };
    globalThis.fetch = okJsonFetch(counter);
    const router = new Eluvix(cachingConfig({
      modelGateway: { caching: { enabled: true, ttlSeconds: 60 } }
    }));
    const messages = [{ role: 'user', content: 'expire me' }];
    await router.routeChatCompletion({ model: 'test-model', messages });
    const cache = (router as any).responseCache as Map<string, { response: any; timestamp: number }>;
    expect(cache.size).toBe(1);

    // Age the stored entry well past its TTL.
    for (const entry of cache.values()) {
      entry.timestamp = Date.now() - 120000;
    }

    // The next read finds it expired and deletes it; the upstream now
    // fails, so nothing repopulates the cache.
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      counter.count++;
      return new Response(JSON.stringify({ error: 'down' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    await expect(router.routeChatCompletion({ model: 'test-model', messages }))
      .rejects.toThrow('All upstreams failed');
    expect(counter.count).toBe(2);
    expect(cache.size).toBe(0);
  });

  it('prunes expired rate-limit minute windows on write', async () => {
    const counter = { count: 0 };
    globalThis.fetch = okJsonFetch(counter);
    const router = new Eluvix({
      strategy: 'cost-complexity',
      modelGateway: { rateLimits: { maxRpm: 100 } },
      upstreams: [UPSTREAM]
    });
    const counts = (router as any).requestCounts as Map<string, any>;
    counts.set('12345', { count: 7, resetTime: 1 }); // long-expired window

    const res = await router.routeChatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }]
    });
    expect(res.status).toBe(200);
    expect(counts.has('12345')).toBe(false);
    expect(counts.size).toBe(1); // only the current window remains
  });
});
