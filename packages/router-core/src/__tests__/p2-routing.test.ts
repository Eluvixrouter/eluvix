import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Eluvix, RouterConfig, UpstreamConfig, isVisionCapableUpstream } from '../index.js';

// Mock DB interactions (same as switchyard.test.ts)
vi.mock('../db.js', () => ({
  logRequest: vi.fn(),
  getRequestLogs: vi.fn().mockReturnValue([])
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function okFetch() {
  return vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const IMAGE_MESSAGE = {
  role: 'user' as const,
  content: [
    { type: 'text' as const, text: 'What is in this picture?' },
    { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }
  ]
};

const OLLAMA_TEXT: UpstreamConfig = {
  id: 'local-ollama',
  name: 'Local Ollama',
  type: 'ollama',
  endpoint: 'http://localhost:11434',
  priority: 20,
  models: ['llama3', '*']
};

describe('Vision capability inference (P2)', () => {
  it('classifies upstreams by explicit capability, provider type, and model names', () => {
    expect(isVisionCapableUpstream({ ...OLLAMA_TEXT, capabilities: ['vision'] })).toBe(true);
    expect(isVisionCapableUpstream({ ...OLLAMA_TEXT, type: 'openai-compatible', endpoint: 'https://api.openai.com' })).toBe(true);
    expect(isVisionCapableUpstream({ ...OLLAMA_TEXT, models: ['llava', '*'] })).toBe(true);
    expect(isVisionCapableUpstream({ ...OLLAMA_TEXT, models: ['some-vl-model'] })).toBe(true);
    expect(isVisionCapableUpstream(OLLAMA_TEXT)).toBe(false);
  });

  it('routes an image request to a multimodal provider that declares no capabilities', async () => {
    globalThis.fetch = okFetch();
    const router = new Eluvix({
      strategy: 'cost-complexity',
      upstreams: [
        OLLAMA_TEXT,
        {
          id: 'openai-direct',
          name: 'OpenAI Direct',
          type: 'openai-compatible',
          endpoint: 'https://api.openai.com',
          priority: 10,
          models: ['gpt-4o', '*']
        }
      ]
    });
    const res = await router.routeChatCompletion({ model: 'auto', messages: [IMAGE_MESSAGE] });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-upstream')).toBe('openai-direct');
  });

  it('routes an image request to a local vision model under local-only egress', async () => {
    globalThis.fetch = okFetch();
    const router = new Eluvix({
      strategy: 'cost-complexity',
      egressPolicy: 'local-only',
      upstreams: [{ ...OLLAMA_TEXT, models: ['llava', '*'] }]
    });
    const res = await router.routeChatCompletion({ model: 'auto', messages: [IMAGE_MESSAGE] });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-upstream')).toBe('local-ollama');
  });

  it('still dead-ends when no upstream can serve images at all', async () => {
    globalThis.fetch = okFetch();
    const router = new Eluvix({ strategy: 'cost-complexity', upstreams: [OLLAMA_TEXT] });
    await expect(router.routeChatCompletion({ model: 'auto', messages: [IMAGE_MESSAGE] }))
      .rejects.toThrow('with vision capability');
  });
});

describe('Failover budget (P2)', () => {
  it('stops starting new attempts once the budget is exhausted instead of burning N x timeout', async () => {
    let fetchCalls = 0;
    globalThis.fetch = vi.fn().mockImplementation((_url: any, opts: any) => {
      fetchCalls++;
      // A dead upstream: never answers, dies only when the router aborts it.
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    const upstreams: UpstreamConfig[] = [1, 2, 3, 4, 5, 6].map(i => ({
      id: `dead-${i}`,
      name: `Dead ${i}`,
      type: 'ollama',
      endpoint: `http://localhost:1143${i}`,
      priority: 100 - i,
      models: ['test-model']
    }));
    const router = new Eluvix({
      strategy: 'cost-complexity',
      switchyard: { timeoutMs: 100, failoverBudgetMs: 250 },
      upstreams
    });

    const start = Date.now();
    await expect(router.routeChatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }]
    })).rejects.toThrow('Failover timed out');
    const elapsed = Date.now() - start;

    // Each attempt lasts at least the 100ms router timeout (the fetch only
    // dies when the router aborts it), so at most 3 attempts can start
    // inside the 250ms budget — 2 when the sandbox runs attempts long —
    // and the remaining candidates are never tried. Without the budget,
    // all 6 would burn 100ms+ each (>= 600ms, 6 fetches).
    expect(fetchCalls).toBeGreaterThanOrEqual(2);
    expect(fetchCalls).toBeLessThanOrEqual(3);
    expect(elapsed).toBeLessThan(550);
  });

  it('without a budget stop, the aggregate error keeps its exact legacy message', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      new Response('nope', { status: 500 })
    );
    const router = new Eluvix({
      strategy: 'cost-complexity',
      switchyard: { timeoutMs: 1000 },
      upstreams: [{
        id: 'only',
        name: 'Only',
        type: 'ollama',
        endpoint: 'http://localhost:11434',
        priority: 1,
        models: ['test-model']
      }]
    });
    await expect(router.routeChatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }]
    })).rejects.toThrow(/^All upstreams failed to process the request\.$/);
  });
});

describe('explainRoute (P2)', () => {
  it('explains ranking and picks the same first candidate routing would try', () => {
    const router = new Eluvix({
      strategy: 'cost-complexity',
      upstreams: [
        { ...OLLAMA_TEXT, id: 'a-local', models: ['test-model'], priority: 10, costPer1kTokens: 0, maxComplexityScore: 4 },
        {
          id: 'b-cloud',
          name: 'Cloud',
          type: 'openai-compatible',
          endpoint: 'https://api.openai.com',
          priority: 5,
          models: ['test-model'],
          costPer1kTokens: 0.005,
          maxComplexityScore: 4
        }
      ]
    });
    const explanation = router.explainRoute({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }]
    });
    expect(explanation.error).toBeUndefined();
    expect(explanation.chosenUpstreamId).toBe('a-local');
    expect(explanation.rankedUpstreams.map(u => u.id)).toEqual(['a-local', 'b-cloud']);
    expect(explanation.steps.map(s => s.stage)).toEqual(['model-match', 'ranking']);
    expect(explanation.complexity.score).toBeGreaterThan(0);
  });

  it('shows the egress exclusion step under local-only', () => {
    const router = new Eluvix({
      strategy: 'cost-complexity',
      egressPolicy: 'local-only',
      upstreams: [
        { ...OLLAMA_TEXT, models: ['test-model'] },
        {
          id: 'b-cloud',
          name: 'Cloud',
          type: 'openai-compatible',
          endpoint: 'https://api.openai.com',
          priority: 5,
          models: ['test-model']
        }
      ]
    });
    const explanation = router.explainRoute({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }]
    });
    const egressStep = explanation.steps.find(s => s.stage === 'egress-policy');
    expect(egressStep?.removed).toEqual(['b-cloud']);
    expect(explanation.chosenUpstreamId).toBe('local-ollama');
  });

  it('captures a vision dead-end as an explanation error instead of throwing', () => {
    const router = new Eluvix({ strategy: 'cost-complexity', upstreams: [OLLAMA_TEXT] });
    const explanation = router.explainRoute({ model: 'auto', messages: [IMAGE_MESSAGE] });
    expect(explanation.chosenUpstreamId).toBeNull();
    expect(explanation.error).toContain('with vision capability');
    expect(explanation.steps.some(s => s.stage === 'vision-filter')).toBe(true);
  });

  it('captures an unmatched model as an explanation error', () => {
    // 'gemini-*' is a model local wildcard upstreams refuse to capture, and
    // no other upstream exists — so nothing can match.
    const router = new Eluvix({ strategy: 'cost-complexity', upstreams: [OLLAMA_TEXT] });
    const explanation = router.explainRoute({
      model: 'gemini-9-ultra',
      messages: [{ role: 'user', content: 'hello' }]
    });
    expect(explanation.chosenUpstreamId).toBeNull();
    expect(explanation.error).toContain('No upstream available for model: gemini-9-ultra');
  });
});

describe('Antigravity routing through a fake agy CLI (P2)', () => {
  let fakeDir: string;
  let fakeAgyPath: string;

  beforeAll(() => {
    // NOT os.tmpdir(): the CLI resolver denies executables under
    // world-writable dirs (sec T1), so the fake stands in a package-local dir.
    fakeDir = fs.mkdtempSync(path.join(process.cwd(), '.fake-agy-'));
    fakeAgyPath = path.join(fakeDir, 'agy');
    // A stand-in for the real agy binary: echoes the --model it was invoked
    // with back as stream-json agent_response deltas.
    const script = [
      '#!/bin/sh',
      'model=""',
      'prev=""',
      'for a in "$@"; do',
      '  if [ "$prev" = "--model" ]; then model="$a"; fi',
      '  prev="$a"',
      'done',
      'printf \'{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"model="}}\\n\'',
      'printf \'{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"%s"}}\\n\' "$model"',
      'exit 0',
      ''
    ].join('\n');
    fs.writeFileSync(fakeAgyPath, script, { mode: 0o755 });
  });

  afterAll(() => {
    try { fs.rmSync(fakeDir, { recursive: true, force: true }); } catch {}
  });

  function agyConfig(extra: Partial<RouterConfig> = {}): RouterConfig {
    return {
      strategy: 'cost-complexity',
      upstreams: [{
        id: 'antigravity-agent',
        name: 'Antigravity Agent',
        type: 'antigravity',
        endpoint: 'cli://agy',
        priority: 28,
        models: ['gpt-4o', 'gemini-4-argon', 'gemini-3.8-flash'],
        antigravity: { cliPath: fakeAgyPath, cwd: fakeDir, cleanHeadless: false }
      }],
      ...extra
    };
  }

  it('routes to an explicitly configured antigravity upstream and assembles its streamed reply', async () => {
    const router = new Eluvix(agyConfig());
    const res = await router.routeChatCompletion({
      model: 'gemini-3.8-flash',
      messages: [{ role: 'user', content: 'hello' }]
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-upstream')).toBe('antigravity-agent');
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('model=gemini-3.8-flash');
  });

  it('falls back to gemini-4-argon when a wildcard-only agy upstream serves an auto request', async () => {
    // The shipped-default shape from the original AGY investigation: the
    // upstream declares only '*', the request asks for 'auto', and no
    // antigravity.model is configured — the CLI must be invoked with the
    // hard fallback model, gemini-4-argon.
    const router = new Eluvix({
      strategy: 'cost-complexity',
      upstreams: [{
        id: 'antigravity-agent',
        name: 'Antigravity Agent',
        type: 'antigravity',
        endpoint: 'cli://agy',
        priority: 28,
        models: ['*'],
        antigravity: { cliPath: fakeAgyPath, cwd: fakeDir, cleanHeadless: false }
      }]
    });
    const res = await router.routeChatCompletion({
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }]
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('model=gemini-4-argon');
  });

  it('never routes to antigravity under local-only egress, even when it is the only upstream', async () => {
    const router = new Eluvix(agyConfig({ egressPolicy: 'local-only' }));
    await expect(router.routeChatCompletion({
      model: 'gemini-4-argon',
      messages: [{ role: 'user', content: 'hello' }]
    })).rejects.toThrow('No local upstream available');
  });
});
