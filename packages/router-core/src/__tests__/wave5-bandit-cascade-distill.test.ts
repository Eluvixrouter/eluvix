import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Eluvix,
  evaluateDraftQuality,
  synthesizeOpenAiSseFromText,
  sampleBetaPosterior,
  rankUpstreamsWithThompsonBandit,
  recordBanditArmOutcome,
  getBanditArmsForTier,
  captureDistillationPair,
  listDistillationPairs,
  formatDistillationAsSftJsonl,
  formatDistillationAsDpoJsonl,
  globalCircuitBreaker,
  type RouterConfig,
} from '../index.js';

describe('Wave 2 (Tracks 4 & 5): Buffer-Verify Cascade, Thompson Bandit & Distillation', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let prevXdgConfig: string | undefined;
  let prevXdgData: string | undefined;

  beforeEach(() => {
    prevXdgConfig = process.env.XDG_CONFIG_HOME;
    prevXdgData = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-w5-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-w5-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
    globalCircuitBreaker.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdgData;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('evaluates draft quality across refusals, JSON schema keys, code fences, and logprobs', () => {
    expect(evaluateDraftQuality('').passed).toBe(false);
    expect(
      evaluateDraftQuality("I'm sorry, I cannot assist with that request.").primaryReason
    ).toBe('refusal_or_inability');

    // Invalid JSON rejected when expectJson is true
    expect(
      evaluateDraftQuality('Sure! { broken json', { expectJson: true }).primaryReason
    ).toBe('invalid_json');

    // Missing required schema keys rejected
    expect(
      evaluateDraftQuality('{"status":"ok"}', {
        expectJson: true,
        jsonSchema: { type: 'object', required: ['status', 'items'] },
      }).primaryReason
    ).toBe('json_schema_missing_keys');

    // Valid JSON matching schema passes
    const validJsonEval = evaluateDraftQuality('{"status":"ok","items":[1,2]}', {
      expectJson: true,
      jsonSchema: { type: 'object', required: ['status', 'items'] },
    });
    expect(validJsonEval.passed).toBe(true);
    expect(validJsonEval.confidence).toBeGreaterThanOrEqual(0.78);

    // Unbalanced Markdown code fences rejected
    expect(
      evaluateDraftQuality('Here is the solution:\n```ts\nexport const x = 1;', {
        expectCode: true,
      }).primaryReason
    ).toBe('unbalanced_code_fences');

    // Low logprob confidence rejected
    const lowLogprob = evaluateDraftQuality('The answer is 42.', {
      confidenceThreshold: 0.8,
      tokenLogprobs: [-1.2, -1.5, -1.1], // exp(-1.26) ~ 0.28
    });
    expect(lowLogprob.passed).toBe(false);
  });

  it('accepts high-confidence $0 local #draft and synthesizes clean SSE stream without calling #verifier', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('11434')) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-local-1',
            object: 'chat.completion',
            model: 'qwen2.5-coder:7b',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '```ts\nexport const add = (a: number, b: number) => a + b;\n```',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 18, completion_tokens: 16, total_tokens: 34 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected verifier fetch: ${url}`);
    });

    const config: RouterConfig = {
      egressPolicy: 'allow-egress',
      upstreams: [
        {
          id: 'local-draft',
          name: 'Local Ollama Draft',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 20,
          models: ['*'],
        },
        {
          id: 'cloud-verifier',
          name: 'Frontier Verifier',
          type: 'openai-compatible',
          endpoint: 'https://api.openai.com/v1',
          apiKey: 'sk-test-verifier',
          priority: 10,
          models: ['*'],
        },
      ],
      cascade: {
        enabled: true,
        draftUpstreamId: 'local-draft',
        verifierUpstreamId: 'cloud-verifier',
        confidenceThreshold: 0.78,
        maxDraftLatencyMs: 2500,
      },
    };

    const router = new Eluvix(config);
    const res = await router.routeChatCompletion({
      model: 'auto',
      stream: true,
      messages: [{ role: 'user', content: 'Write a TypeScript add function.' }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-upstream')).toBe('local-draft');
    expect(res.headers.get('x-eluvix-cascade')).toBe('draft-accepted');
    expect(res.headers.get('x-eluvix-cost-usd')).toBe('0.000000');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const sseBody = await res.text();
    expect(sseBody).toContain('chat.completion.chunk');
    expect(sseBody).toContain('export const add');
    expect(sseBody).toContain('data: [DONE]');
  });

  it('escalates malformed #draft to #verifier cleanly with zero half-stream corruption and captures DPO pair', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('11434')) {
        // Draft returns invalid JSON despite json_object requirement
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-draft-bad',
            model: 'llama3.2:1b',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Not valid JSON: {foo:' },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Frontier verifier returns clean JSON
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-verifier-ok',
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '{"answer":"verified","owner":"alice@example.com"}',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const router = new Eluvix({
      egressPolicy: 'allow-egress',
      strategy: 'priority',
      switchyard: { strategy: 'priority' },
      upstreams: [
        {
          id: 'local-draft',
          name: 'Local Draft',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 25,
          models: ['*'],
        },
        {
          id: 'frontier-verifier',
          name: 'Frontier Verifier',
          type: 'openai-compatible',
          endpoint: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          priority: 10,
          models: ['*'],
        },
      ],
      cascade: {
        enabled: true,
        draftUpstreamId: 'local-draft',
        verifierUpstreamId: 'frontier-verifier',
        confidenceThreshold: 0.78,
        validateJsonSchema: true,
      },
    });

    const res = await router.routeChatCompletion(
      {
        model: 'auto',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: 'Return JSON for user ssn 123-45-6789.',
          },
        ],
      },
      { scope: { userId: 'user-cascade' } }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-upstream')).toBe('frontier-verifier');
    expect(res.headers.get('x-eluvix-cascade')).toBe('escalated-verifier');
    expect(res.headers.get('x-eluvix-cascade-reason')).toBe('invalid_json');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Allow microtask distillation persistence to settle
    await new Promise((r) => setTimeout(r, 20));

    const pairs = listDistillationPairs('user-cascade');
    expect(pairs.length).toBe(1);
    expect(pairs[0].source).toBe('cascade-escalation');
    expect(pairs[0].privacy_scrubbed).toBe(true);
    // Verify PII was scrubbed in both prompt and chosen output
    expect(JSON.stringify(pairs[0].prompt_messages)).not.toContain('123-45-6789');
    expect(pairs[0].chosen_text).not.toContain('alice@example.com');
    expect(pairs[0].chosen_text).toContain('[REDACTED_EMAIL]');
  });

  it('adapts routing online via Contextual Thompson Bandit posteriors', () => {
    for (let i = 0; i < 8; i++) {
      recordBanditArmOutcome({
        upstreamId: 'unstable-local',
        complexityTier: 'simple',
        success: false,
      });
      recordBanditArmOutcome({
        upstreamId: 'reliable-local',
        complexityTier: 'simple',
        success: true,
        ttftMs: 45,
      });
    }

    const arms = getBanditArmsForTier('simple');
    expect(arms.length).toBe(2);

    const router = new Eluvix({
      strategy: 'thompson-bandit',
      switchyard: { strategy: 'thompson-bandit' },
      upstreams: [
        {
          id: 'unstable-local',
          name: 'Unstable Local',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 50, // Higher static priority, but terrible bandit posterior
          models: ['*'],
        },
        {
          id: 'reliable-local',
          name: 'Reliable Local',
          type: 'ramalama',
          endpoint: 'http://localhost:8080',
          priority: 10,
          models: ['*'],
        },
      ],
    });

    const explanation = router.explainRoute({
      model: 'auto',
      messages: [{ role: 'user', content: 'Hello!' }],
    });
    expect(explanation.strategy).toBe('thompson-bandit');
    expect(explanation.chosenUpstreamId).toBe('reliable-local');

    // Verify Beta sampler stays bounded in [0, 1]
    const draw = sampleBetaPosterior(10, 2);
    expect(draw).toBeGreaterThanOrEqual(0);
    expect(draw).toBeLessThanOrEqual(1);

    const ranked = rankUpstreamsWithThompsonBandit(
      router.getUpstreams(),
      arms,
      { complexityScore: 1, deterministicMean: true }
    );
    expect(ranked.ranked[0].id).toBe('reliable-local');
  });

  it('runs async #shadow-student mirroring without blocking and formats SFT + DPO JSONL', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('api.openai.com')) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-teacher',
            model: 'gpt-4o',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content:
                    'Here is the complete O(n) sliding window implementation with edge-case bounds checks and unit tests.',
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('11434')) {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-student',
            model: 'qwen2.5:1.5b',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: "I'm sorry, I cannot solve this algorithm.",
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const router = new Eluvix({
      egressPolicy: 'allow-egress',
      strategy: 'priority',
      switchyard: { strategy: 'priority' },
      upstreams: [
        {
          id: 'teacher-cloud',
          name: 'Frontier Teacher',
          type: 'openai-compatible',
          endpoint: 'https://api.openai.com/v1',
          apiKey: 'sk-teacher',
          priority: 30,
          models: ['*'],
        },
        {
          id: 'student-local',
          name: 'Local Student',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 10,
          models: ['*'],
        },
      ],
      cascade: {
        enabled: false,
        shadowStudentUpstreamId: 'student-local',
        shadowSampleRate: 1.0,
      },
    });

    const res = await router.routeChatCompletion(
      {
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: 'Optimize sliding window for dev@company.org using key sk-proj-1234567890abcdefghijklmnop',
          },
        ],
      },
      { scope: { userId: 'distill-user' } }
    );
    expect(res.status).toBe(200);

    // Wait briefly for background shadow completion
    await new Promise((r) => setTimeout(r, 40));

    const pairs = listDistillationPairs('distill-user', { minScore: 0.8 });
    expect(pairs.length).toBe(1);
    expect(pairs[0].source).toBe('shadow');
    expect(pairs[0].judge_score).toBeGreaterThanOrEqual(0.9);
    expect(JSON.stringify(pairs[0].prompt_messages)).toContain('[REDACTED_EMAIL]');
    expect(JSON.stringify(pairs[0].prompt_messages)).toContain('[REDACTED_API_KEY]');

    const sftJsonl = formatDistillationAsSftJsonl(pairs);
    const sftRow = JSON.parse(sftJsonl);
    expect(sftRow.messages.at(-1).role).toBe('assistant');
    expect(sftRow.metadata.privacy_scrubbed).toBe(true);

    const dpoJsonl = formatDistillationAsDpoJsonl(pairs);
    const dpoRow = JSON.parse(dpoJsonl);
    expect(dpoRow.chosen[0].content).toContain('sliding window');
    expect(dpoRow.rejected[0].content).toContain('cannot solve');
    expect(dpoRow.score).toBeGreaterThanOrEqual(0.9);

    // Verify synthesizeOpenAiSseFromText helper directly
    const sse = await new Response(
      synthesizeOpenAiSseFromText({ text: 'Hello world', model: 'test-model' })
    ).text();
    expect(sse).toContain('Hello world');
    expect(sse).toContain('[DONE]');

    // Verify direct captureDistillationPair rejects Teacher refusals
    const badTeacher = captureDistillationPair({
      userId: 'distill-user',
      teacherUpstreamId: 'teacher-cloud',
      studentUpstreamId: 'student-local',
      teacherModel: 'gpt-4o',
      studentModel: 'qwen',
      promptMessages: [{ role: 'user', content: 'Hi' }],
      chosenText: "I'm sorry, I cannot assist with that.",
      rejectedText: 'Hello!',
    });
    expect(badTeacher).toBeNull();
  });
});
