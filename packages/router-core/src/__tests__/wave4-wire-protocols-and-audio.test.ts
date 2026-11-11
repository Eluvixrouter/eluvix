import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Eluvix,
  anthropicToOpenAiChatRequest,
  openAiToAnthropicMessageResponse,
  transformOpenAiSseToAnthropicSse,
  resolveVirtualVendorModel,
  responsesInputToChatRequest,
  openAiChatToResponsesObject,
  transformOpenAiSseToResponsesSse,
  normalizeEmbeddingVector,
  saveStoredResponse,
  getStoredResponse,
  deleteStoredResponse,
  extractDesktopToken,
} from '../index.js';

describe('Wave 1: Universal Wire Protocols (/v1/messages, /v1/responses, /v1/embeddings) & Sovereign Audio', () => {
  let tmpDir: string;
  let origConfigHome: string | undefined;
  let origDataHome: string | undefined;

  beforeEach(() => {
    origConfigHome = process.env.XDG_CONFIG_HOME;
    origDataHome = process.env.XDG_DATA_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-wave4-core-'));
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origConfigHome;
    if (origDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origDataHome;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('maps unconfigured foreign Anthropic & OpenAI models by capability tier while preserving gemini-* strictness', () => {
    expect(resolveVirtualVendorModel('claude-4-opus-20260201').targetTier).toBe('frontier');
    expect(resolveVirtualVendorModel('o3-pro').targetTier).toBe('frontier');
    expect(resolveVirtualVendorModel('claude-3-7-sonnet-20250219').targetTier).toBe('heavy');
    expect(resolveVirtualVendorModel('gpt-4o').targetTier).toBe('heavy');
    expect(resolveVirtualVendorModel('claude-3-5-haiku-latest').targetTier).toBe('simple');
    expect(resolveVirtualVendorModel('gpt-4o-mini').targetTier).toBe('simple');
    expect(resolveVirtualVendorModel('gemini-9-ultra').aliasApplied).toBe(false);
    expect(resolveVirtualVendorModel('harness/opencode').aliasApplied).toBe(false);

    const router = new Eluvix({
      upstreams: [
        {
          id: 'local-fast',
          name: 'Local Fast Qwen',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 25,
          models: ['qwen2.5:3b'],
          costPer1kTokens: 0,
          maxComplexityScore: 2,
        },
        {
          id: 'local-heavy',
          name: 'Local Heavy DeepSeek',
          type: 'vllm',
          endpoint: 'http://localhost:8000',
          priority: 20,
          models: ['deepseek-r1:32b'],
          costPer1kTokens: 0,
          maxComplexityScore: 4,
        },
      ],
      switchyard: {
        strategy: 'cost-complexity',
      },
    });

    const haikuExplain = router.explainRoute({
      model: 'claude-3-5-haiku-latest',
      messages: [{ role: 'user', content: 'Say hi' }],
    });
    expect(haikuExplain.chosenUpstreamId).toBe('local-fast');

    const opusExplain = router.explainRoute({
      model: 'claude-4-opus',
      messages: [{ role: 'user', content: 'Say hi' }],
    });
    expect(opusExplain.chosenUpstreamId).toBe('local-heavy');

    // When strictModelMatch is enabled, foreign unconfigured models are NOT aliased
    const strictRouter = new Eluvix({
      upstreams: [
        {
          id: 'local-fast',
          name: 'Local Fast Qwen',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 25,
          models: ['qwen2.5:3b'],
        },
      ],
      switchyard: {
        strategy: 'cost-complexity',
        strictModelMatch: true,
      },
    });
    const strictExplain = strictRouter.explainRoute({
      model: 'claude-4-opus',
      messages: [{ role: 'user', content: 'Say hi' }],
    });
    expect(strictExplain.chosenUpstreamId).toBeNull();
  });

  it('translates Anthropic Messages tool_use, tool_result, thinking, and streaming SSE cleanly', async () => {
    const chatReq = anthropicToOpenAiChatRequest({
      model: 'claude-3-7-sonnet',
      system: [{ type: 'text', text: 'You are a sovereign coding assistant.' }],
      max_tokens: 2048,
      thinking: { type: 'enabled', budget_tokens: 12000 },
      tools: [
        {
          name: 'read_file',
          description: 'Read a workspace file',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
      tool_choice: { type: 'any' },
      messages: [
        { role: 'user', content: 'Check package.json' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Need to inspect package.json first.' },
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'package.json' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"name":"eluvix"}' },
          ],
        },
      ],
      stream: true,
    });

    expect(chatReq.messages[0]).toEqual({
      role: 'system',
      content: 'You are a sovereign coding assistant.',
    });
    expect(chatReq.tool_choice).toBe('required');
    expect(chatReq.metadata?.effort).toBe('medium');
    expect(chatReq.messages[2].tool_calls?.[0]?.function?.name).toBe('read_file');
    expect(chatReq.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: '{"name":"eluvix"}',
    });

    // Non-streaming OpenAI -> Anthropic Message with <think> extraction & tool_use
    const anthMsg = openAiToAnthropicMessageResponse(
      {
        id: 'chatcmpl-xyz',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '<think>Analyzing deps</think>Let me read src/index.ts.',
              tool_calls: [
                {
                  id: 'call_99',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 42, completion_tokens: 18 },
      },
      'claude-3-7-sonnet'
    );

    expect(anthMsg.stop_reason).toBe('tool_use');
    expect(anthMsg.content[0]).toEqual({ type: 'thinking', thinking: 'Analyzing deps' });
    expect(anthMsg.content[1]).toEqual({ type: 'text', text: 'Let me read src/index.ts.' });
    expect(anthMsg.content[2]).toEqual({
      type: 'tool_use',
      id: 'call_99',
      name: 'read_file',
      input: { path: 'src/index.ts' },
    });

    // Streaming SSE translation
    const enc = new TextEncoder();
    const openAiSse = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(
            'data: {"choices":[{"delta":{"reasoning_content":"Step 1"}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":"Hello Anthropic!"}}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
              'data: [DONE]\n\n'
          )
        );
        controller.close();
      },
    });

    const transformed = transformOpenAiSseToAnthropicSse(openAiSse, 'claude-3-7-sonnet');
    const sseText = await new Response(transformed).text();
    expect(sseText).toContain('event: message_start');
    expect(sseText).toContain('"type":"thinking_delta"');
    expect(sseText).toContain('"thinking":"Step 1"');
    expect(sseText).toContain('"type":"text_delta"');
    expect(sseText).toContain('"text":"Hello Anthropic!"');
    expect(sseText).toContain('event: message_stop');
  });

  it('persists OpenAI /v1/responses conversation chains per userId in SQLite and translates SSE', async () => {
    saveStoredResponse({
      id: 'resp_turn1',
      userId: 'alice',
      previousResponseId: null,
      model: 'qwen2.5:7b',
      messages: [
        { role: 'user', content: 'My secret code is 7749.' },
        { role: 'assistant', content: 'Noted.' },
      ],
      response: { id: 'resp_turn1', object: 'response', output_text: 'Noted.' },
    });

    // Strict per-user isolation: bob cannot read or delete alice's response chain
    expect(getStoredResponse('resp_turn1', 'bob')).toBeNull();
    expect(deleteStoredResponse('resp_turn1', 'bob')).toBe(false);

    const alicePrior = getStoredResponse('resp_turn1', 'alice');
    expect(alicePrior).not.toBeNull();

    const { chatRequest: turn2Chat } = responsesInputToChatRequest(
      {
        model: 'qwen2.5:7b',
        instructions: 'Answer concisely.',
        input: 'What was my secret code?',
      },
      alicePrior!.messages
    );
    expect(turn2Chat.messages).toHaveLength(4);
    expect(turn2Chat.messages[0]).toEqual({ role: 'system', content: 'Answer concisely.' });
    expect(turn2Chat.messages[3]).toEqual({ role: 'user', content: 'What was my secret code?' });

    const { responseObject: respObj } = openAiChatToResponsesObject({
      chatJson: {
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '7749' } }],
        usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 },
      },
      requestedModel: 'qwen2.5:7b',
      previousResponseId: 'resp_turn1',
      store: true,
    });
    expect(respObj.object).toBe('response');
    expect(respObj.output_text).toBe('7749');
    expect(respObj.previous_response_id).toBe('resp_turn1');

    // Responses SSE stream
    const enc = new TextEncoder();
    let completedText = '';
    const sse = transformOpenAiSseToResponsesSse({
      openAiStream: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"77"}}]}\n\n'));
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"49"},"finish_reason":"stop"}]}\n\n'));
          c.enqueue(enc.encode('data: [DONE]\n\n'));
          c.close();
        },
      }),
      requestedModel: 'qwen2.5:7b',
      onCompleted: ({ responseObject }) => {
        completedText = responseObject.output_text;
      },
    });
    const out = await new Response(sse).text();
    expect(out).toContain('event: response.created');
    expect(out).toContain('event: response.output_text.delta');
    expect(out).toContain('event: response.completed');
    expect(completedText).toBe('7749');

    expect(deleteStoredResponse('resp_turn1', 'alice')).toBe(true);
    expect(getStoredResponse('resp_turn1', 'alice')).toBeNull();
  });

  it('routes /v1/embeddings with PrivacyGuard scrubbing, Ollama /api/embed conversion, and Matryoshka L2 dimension pinning', async () => {
    let capturedBody: any = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/embeddings')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.endsWith('/api/embed')) {
        capturedBody = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({
            embeddings: [[3, 4, 12, 84]],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const router = new Eluvix({
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama Embed',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 20,
          models: ['nomic-embed-text'],
        },
      ],
      privacyGuard: {
        enabled: true,
        action: 'anonymize',
        redactionStyle: 'token',
        detectPii: { email: true, ssn: true, apiKey: true, creditCard: true, phone: true, ipAddress: false },
      },
    });

    const res = await router.routeEmbeddings({
      model: 'nomic-embed-text',
      input: 'Contact jane.doe@example.com for embeddings',
      dimensions: 2,
    });

    expect(res.status).toBe(200);
    expect(capturedBody.input[0]).not.toContain('jane.doe@example.com');
    expect(res.headers.get('x-eluvix-embedding-dims')).toBe('2');
    expect(res.headers.get('x-eluvix-matryoshka-sliced')).toBe('true');

    const json = await res.json();
    const vec: number[] = json.data[0].embedding;
    expect(vec).toHaveLength(2);
    // [3, 4] L2-normalized -> [0.6, 0.8]
    expect(vec[0]).toBeCloseTo(0.6, 5);
    expect(vec[1]).toBeCloseTo(0.8, 5);

    // Asking for wider dimensions than the model produces returns 422 rather than corrupting vector index
    const mismatchRes = await router.routeEmbeddings({
      model: 'nomic-embed-text',
      input: 'test',
      dimensions: 1536,
    });
    expect(mismatchRes.status).toBe(422);
    expect(() => normalizeEmbeddingVector([1, 0], 4)).toThrow(/smaller than pinned target/i);
  });

  it('routes headless /v1/audio/transcriptions (with transcript PII scrub) and /v1/audio/speech while isolating AudioVoiceNode from chat', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(':8005/v1/audio/transcriptions')) {
        return new Response(
          JSON.stringify({ text: 'My SSN is 123-45-6789 and email is voice@corp.io' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes(':8880/v1/audio/speech')) {
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const router = new Eluvix({
      upstreams: [
        {
          id: 'audio-1',
          name: 'Sovereign Audio Node',
          type: 'audio',
          endpoint: 'http://localhost:8005',
          priority: 30,
          models: ['*'],
          audio: {
            mode: 'both',
            sttBackend: 'speaches',
            ttsBackend: 'kokoro',
            ttsEndpoint: 'http://localhost:8880',
            defaultVoice: 'af_heart',
            responseFormat: 'mp3',
            scrubTranscriptPii: true,
          },
        },
        {
          id: 'ollama-chat',
          name: 'Local Ollama Chat',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 15,
          models: ['llama3.2'],
        },
      ],
      privacyGuard: {
        enabled: true,
        action: 'anonymize',
        redactionStyle: 'token',
        detectPii: { ssn: true, email: true, apiKey: false, creditCard: false, phone: false, ipAddress: false },
      },
    });

    // Audio node must NEVER hijack text chat completions even at higher priority with '*'
    const chatExplain = router.explainRoute({
      messages: [{ role: 'user', content: 'Write a poem about Linux' }],
    });
    expect(chatExplain.chosenUpstreamId).toBe('ollama-chat');

    // STT transcription with post-STT PrivacyGuard scrubbing
    const sttRes = await router.routeAudioTranscription({
      file: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }),
      filename: 'sample.wav',
    });
    expect(sttRes.status).toBe(200);
    expect(sttRes.headers.get('x-eluvix-upstream')).toBe('audio-1');
    const sttJson = await sttRes.json();
    expect(sttJson.text).not.toContain('123-45-6789');
    expect(sttJson.text).not.toContain('voice@corp.io');

    // TTS speech synthesis dispatched to dedicated :8880 Kokoro endpoint
    const ttsRes = await router.routeAudioSpeech({
      input: 'Sovereign local voice synthesis online.',
    });
    expect(ttsRes.status).toBe(200);
    expect(ttsRes.headers.get('content-type')).toContain('audio/mpeg');
    expect(ttsRes.headers.get('x-eluvix-audio-voice')).toBe('af_heart');
    const bytes = new Uint8Array(await ttsRes.arrayBuffer());
    expect(bytes.length).toBe(4);

    // Desktop token extractor accepts x-api-key for Claude Code / Anthropic SDKs
    expect(extractDesktopToken({ 'x-api-key': 'desk_tok_123' })).toBe('desk_tok_123');
  });
});
