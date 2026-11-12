import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import * as routerCore from '../index.js';
import {
  Eluvix,
  type RouterConfig,
  type ChatRequest,
  anthropicToOpenAiChatRequest,
  openAiToAnthropicMessageResponse,
  transformOpenAiSseToAnthropicSse,
  responsesInputToChatRequest,
  openAiChatToResponsesObject,
  transformOpenAiSseToResponsesSse,
  saveStoredResponse,
  getStoredResponse,
  deleteStoredResponse,
} from '../index.js';

describe('Phase 0 — Modular Decomposition, RouterDeps Seam & Official SDK Wire Contracts', () => {
  let tmpConfigDir: string;
  let tmpDataDir: string;
  let origConfigHome: string | undefined;
  let origDataHome: string | undefined;
  let upstreamServer: http.Server | null = null;
  let gatewayServer: http.Server | null = null;

  beforeEach(() => {
    origConfigHome = process.env.XDG_CONFIG_HOME;
    origDataHome = process.env.XDG_DATA_HOME;
    tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-sdk-cfg-'));
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-sdk-data-'));
    process.env.XDG_CONFIG_HOME = tmpConfigDir;
    process.env.XDG_DATA_HOME = tmpDataDir;
  });

  afterEach(async () => {
    if (gatewayServer) {
      await new Promise<void>((resolve) => gatewayServer!.close(() => resolve()));
      gatewayServer = null;
    }
    if (upstreamServer) {
      await new Promise<void>((resolve) => upstreamServer!.close(() => resolve()));
      upstreamServer = null;
    }
    if (origConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origConfigHome;
    if (origDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origDataHome;
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('preserves the full public export surface of @eluvix/router-core and supports RouterDeps injection', () => {
    const exportedKeys = Object.keys(routerCore);
    expect(exportedKeys).toEqual(
      expect.arrayContaining([
        'Eluvix',
        'estimateUpstreamRequestCostUsd',
        'getEffectiveCostPer1kTokens',
        'isLocalUpstream',
        'isVisionCapableUpstream',
        'isConfidentialEnclaveUpstream',
        'isLosslessSub4BitUpstream',
        'isCollisionFreeRailFabricUpstream',
        'computeKvPrefixHash',
        'estimatePromptComplexity',
        'detectUpstreamModels',
        'detectUpstreamModelDetails',
        'anthropicToOpenAiChatRequest',
        'openAiToAnthropicMessageResponse',
        'responsesInputToChatRequest',
        'openAiChatToResponsesObject',
        'normalizeEmbeddingVector',
      ])
    );

    let customFetchCalled = false;
    const config: RouterConfig = {
      strategy: 'priority',
      upstreams: [
        {
          id: 'custom-deps-upstream',
          name: 'Custom Deps Upstream',
          type: 'vllm',
          endpoint: 'http://127.0.0.1:19999',
          models: ['qwen3-8b'],
          priority: 1,
        },
      ],
    };

    const router = new Eluvix(config, {
      now: () => 1700000000000,
      fetch: async () => {
        customFetchCalled = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(router.getUpstreams()).toHaveLength(1);
    expect(customFetchCalled).toBe(false);
  });

  it('passes official OpenAI and Anthropic TypeScript SDK wire-contract journeys end-to-end', async () => {
    // 1. Start a local fake OpenAI/vLLM upstream on 127.0.0.1:0
    upstreamServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const url = req.url || '/';

      if (url.endsWith('/v1/chat/completions')) {
        const body = JSON.parse(rawBody || '{}');
        if (body.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          const sseChunks = [
            {
              id: 'chatcmpl_stream_1',
              object: 'chat.completion.chunk',
              created: 1700000000,
              model: body.model || 'qwen3-coder',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', reasoning_content: 'Analyzing request step by step...' },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'chatcmpl_stream_1',
              object: 'chat.completion.chunk',
              created: 1700000000,
              model: body.model || 'qwen3-coder',
              choices: [
                {
                  index: 0,
                  delta: { content: 'Hello from sovereign stream!' },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'chatcmpl_stream_1',
              object: 'chat.completion.chunk',
              created: 1700000000,
              model: body.model || 'qwen3-coder',
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 18, completion_tokens: 9, total_tokens: 27 },
            },
          ];
          for (const chunk of sseChunks) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
        if (hasTools) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl_tool_1',
              object: 'chat.completion',
              created: 1700000000,
              model: body.model || 'qwen3-coder',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: 'Checking weather tool.',
                    reasoning_content: 'Need to call get_weather.',
                    tool_calls: [
                      {
                        id: 'call_weather_1',
                        type: 'function',
                        function: {
                          name: body.tools[0].function.name,
                          arguments: JSON.stringify({ city: 'Austin' }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 },
            })
          );
          return;
        }

        const lastMsg = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
        const userText = typeof lastMsg?.content === 'string' ? lastMsg.content : 'world';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl_sync_1',
            object: 'chat.completion',
            created: 1700000000,
            model: body.model || 'qwen3-coder',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: `Echo(${body.messages?.length || 1}): ${userText}`,
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
          })
        );
        return;
      }

      if (url.endsWith('/v1/embeddings')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            model: 'nomic-embed-text',
            data: [{ object: 'embedding', index: 0, embedding: [3, 4, 0, 0, 12, 0, 0, 0] }],
            usage: { prompt_tokens: 5, total_tokens: 5 },
          })
        );
        return;
      }

      if (url.endsWith('/v1/audio/transcriptions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Sovereign whisper transcription verified.' }));
        return;
      }

      if (url.endsWith('/v1/audio/speech')) {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found on fake upstream' } }));
    });

    await new Promise<void>((resolve) => upstreamServer!.listen(0, '127.0.0.1', () => resolve()));
    const upstreamPort = (upstreamServer.address() as any).port;
    const upstreamEndpoint = `http://127.0.0.1:${upstreamPort}`;

    const config: RouterConfig = {
      strategy: 'cost-complexity',
      upstreams: [
        {
          id: 'local-vllm',
          name: 'Local vLLM Sovereign',
          type: 'vllm',
          endpoint: upstreamEndpoint,
          models: ['*'],
          priority: 1,
          audio: { mode: 'both' },
        },
      ],
    };
    const router = new Eluvix(config);

    // 2. Start local gateway HTTP server exposing /v1/chat/completions, /v1/messages, /v1/responses, /v1/embeddings, /v1/audio/*
    gatewayServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const rawBuf = Buffer.concat(chunks);

      const copyEluvixHeaders = (upstreamRes: Response): Record<string, string> => {
        const headers: Record<string, string> = {};
        upstreamRes.headers.forEach((v, k) => {
          if (k.toLowerCase().startsWith('x-eluvix-')) headers[k] = v;
        });
        return headers;
      };

      const pipeStream = async (stream: ReadableStream<Uint8Array>, status: number, headers: Record<string, string>) => {
        res.writeHead(status, headers);
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } finally {
          reader.releaseLock();
          res.end();
        }
      };

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        const body = JSON.parse(rawBuf.toString('utf8') || '{}');
        const upstreamRes = await router.routeChatCompletion(body, {
          scope: { userId: 'sdk-user', origin: 'client' },
        });
        const headers = copyEluvixHeaders(upstreamRes);
        const ct = upstreamRes.headers.get('content-type') || 'application/json';
        if (body.stream && upstreamRes.body && ct.includes('text/event-stream')) {
          await pipeStream(upstreamRes.body, upstreamRes.status, {
            ...headers,
            'Content-Type': 'text/event-stream; charset=utf-8',
          });
          return;
        }
        const json = await upstreamRes.json();
        res.writeHead(upstreamRes.status, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
        return;
      }

      if (pathname === '/v1/messages' && req.method === 'POST') {
        const body = JSON.parse(rawBuf.toString('utf8') || '{}');
        const requestedModel = body.model || 'claude-3-7-sonnet';
        const chatReq = anthropicToOpenAiChatRequest({ ...body, model: requestedModel }) as unknown as ChatRequest;
        const upstreamRes = await router.routeChatCompletion(chatReq, {
          scope: { userId: 'sdk-user', origin: 'client' },
        });
        const headers = copyEluvixHeaders(upstreamRes);
        const ct = upstreamRes.headers.get('content-type') || '';
        if (chatReq.stream && upstreamRes.body && ct.includes('text/event-stream')) {
          const anthropicStream = transformOpenAiSseToAnthropicSse(upstreamRes.body, requestedModel);
          await pipeStream(anthropicStream, upstreamRes.status, {
            ...headers,
            'Content-Type': 'text/event-stream; charset=utf-8',
          });
          return;
        }
        const openAiJson = await upstreamRes.json();
        const anthropicMsg = openAiToAnthropicMessageResponse(openAiJson, requestedModel);
        res.writeHead(upstreamRes.status, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(anthropicMsg));
        return;
      }

      if (pathname === '/v1/responses' && req.method === 'POST') {
        const body = JSON.parse(rawBuf.toString('utf8') || '{}');
        const previousResponseId =
          typeof body.previous_response_id === 'string' && body.previous_response_id.trim()
            ? body.previous_response_id.trim()
            : null;
        let priorMessages: Array<Record<string, any>> = [];
        if (previousResponseId) {
          const prior = getStoredResponse(previousResponseId, 'sdk-user');
          if (prior) priorMessages = prior.messages;
        }
        const { chatRequest } = responsesInputToChatRequest(body, priorMessages);
        const chatReq = chatRequest as unknown as ChatRequest;
        const shouldStore = body.store !== false;
        const upstreamRes = await router.routeChatCompletion(chatReq, {
          scope: { userId: 'sdk-user', origin: 'client' },
        });
        const headers = copyEluvixHeaders(upstreamRes);
        const servedModel = upstreamRes.headers.get('x-eluvix-model') || chatReq.model || 'qwen3-coder';
        const ct = upstreamRes.headers.get('content-type') || '';
        if (chatReq.stream && upstreamRes.body && ct.includes('text/event-stream')) {
          const stream = transformOpenAiSseToResponsesSse({
            openAiStream: upstreamRes.body,
            requestedModel: servedModel,
            previousResponseId,
            store: shouldStore,
            onCompleted: ({ responseObject, assistantMessage }) => {
              if (!shouldStore) return;
              saveStoredResponse({
                id: responseObject.id,
                userId: 'sdk-user',
                previousResponseId,
                model: servedModel,
                messages: [...chatRequest.messages, assistantMessage],
                response: responseObject,
              });
            },
          });
          await pipeStream(stream, upstreamRes.status, {
            ...headers,
            'Content-Type': 'text/event-stream; charset=utf-8',
          });
          return;
        }
        const openAiJson = await upstreamRes.json();
        const { responseObject, assistantMessage } = openAiChatToResponsesObject({
          chatJson: openAiJson,
          requestedModel: servedModel,
          previousResponseId,
          store: shouldStore,
        });
        if (shouldStore) {
          saveStoredResponse({
            id: responseObject.id,
            userId: 'sdk-user',
            previousResponseId,
            model: servedModel,
            messages: [...chatRequest.messages, assistantMessage],
            response: responseObject,
          });
        }
        res.writeHead(upstreamRes.status, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(responseObject));
        return;
      }

      if (pathname.startsWith('/v1/responses/') && (req.method === 'GET' || req.method === 'DELETE')) {
        const respId = decodeURIComponent(pathname.replace('/v1/responses/', '')).trim();
        if (req.method === 'GET') {
          const stored = getStoredResponse(respId, 'sdk-user');
          if (!stored) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Not found' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(stored.response));
          return;
        }
        const deleted = deleteStoredResponse(respId, 'sdk-user');
        res.writeHead(deleted ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: respId, object: 'response.deleted', deleted }));
        return;
      }

      if (pathname === '/v1/embeddings' && req.method === 'POST') {
        const body = JSON.parse(rawBuf.toString('utf8') || '{}');
        const embRes = await router.routeEmbeddings(body, {
          scope: { userId: 'sdk-user', origin: 'client' },
        });
        const headers = copyEluvixHeaders(embRes);
        const payload = await embRes.json();
        res.writeHead(embRes.status, { ...headers, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      if (pathname === '/v1/audio/transcriptions' && req.method === 'POST') {
        const syntheticReq = new Request('http://127.0.0.1/upload', {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] || '' },
          body: new Uint8Array(rawBuf),
        });
        const formData = await syntheticReq.formData();
        const fileField = formData.get('file') as File;
        const sttRes = await router.routeAudioTranscription({
          file: fileField,
          filename: fileField?.name || 'sample.wav',
          mimeType: fileField?.type || 'audio/wav',
          model: (formData.get('model') as string) || 'whisper-large-v3',
        });
        const headers = copyEluvixHeaders(sttRes);
        const outBytes = Buffer.from(await sttRes.arrayBuffer());
        res.writeHead(sttRes.status, {
          ...headers,
          'Content-Type': sttRes.headers.get('content-type') || 'application/json',
        });
        res.end(outBytes);
        return;
      }

      if (pathname === '/v1/audio/speech' && req.method === 'POST') {
        const body = JSON.parse(rawBuf.toString('utf8') || '{}');
        const ttsRes = await router.routeAudioSpeech(body);
        const headers = copyEluvixHeaders(ttsRes);
        const outBytes = Buffer.from(await ttsRes.arrayBuffer());
        res.writeHead(ttsRes.status, {
          ...headers,
          'Content-Type': ttsRes.headers.get('content-type') || 'audio/mpeg',
        });
        res.end(outBytes);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => gatewayServer!.listen(0, '127.0.0.1', () => resolve()));
    const gatewayPort = (gatewayServer.address() as any).port;
    const baseURL = `http://127.0.0.1:${gatewayPort}`;

    // 3. Test Official OpenAI SDK
    const openai = new OpenAI({
      baseURL: `${baseURL}/v1`,
      apiKey: 'elx_test_contract_key',
    });

    // 3a. OpenAI Chat Completions (sync + streaming)
    const chatRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'ping from openai sdk' }],
    });
    expect(chatRes.choices[0]?.message?.content).toContain('ping from openai sdk');

    const chatStream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'stream test' }],
      stream: true,
    });
    let streamedText = '';
    for await (const part of chatStream) {
      streamedText += part.choices[0]?.delta?.content || '';
    }
    expect(streamedText).toBe('Hello from sovereign stream!');

    // 3b. OpenAI Stateful Responses API (multi-turn with previous_response_id)
    const respTurn1 = await openai.responses.create({
      model: 'gpt-4o',
      input: 'First stateful turn',
    });
    expect(respTurn1.id).toMatch(/^resp_/);
    expect(respTurn1.output_text).toContain('Echo(1): First stateful turn');

    const respTurn2 = await openai.responses.create({
      model: 'gpt-4o',
      previous_response_id: respTurn1.id,
      input: 'Second stateful turn',
    });
    expect(respTurn2.output_text).toContain('Echo(3): Second stateful turn');

    // 3c. OpenAI Embeddings API with MRL dimensions truncation + L2 normalization
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: 'Sovereign MRL test',
      dimensions: 4,
    });
    expect(embRes.data[0]?.embedding).toHaveLength(4);
    expect(embRes.data[0]?.embedding[0]).toBeCloseTo(0.6, 5);
    expect(embRes.data[0]?.embedding[1]).toBeCloseTo(0.8, 5);

    // 3d. OpenAI Audio STT & TTS
    const wavFile = new File([new Uint8Array([82, 73, 70, 70])], 'test.wav', { type: 'audio/wav' });
    const transcription = await openai.audio.transcriptions.create({
      file: wavFile,
      model: 'whisper-1',
    });
    expect(transcription.text).toBe('Sovereign whisper transcription verified.');

    const speechRes = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: 'Speak sovereignly',
    });
    const speechBytes = new Uint8Array(await speechRes.arrayBuffer());
    expect(speechBytes.byteLength).toBeGreaterThan(0);

    // 4. Test Official Anthropic SDK
    const anthropic = new Anthropic({
      baseURL,
      apiKey: 'elx_test_anthropic_key',
    });

    // 4a. Anthropic messages.create with tools & thinking
    const msgRes = await anthropic.messages.create({
      model: 'claude-3-7-sonnet-20250219',
      max_tokens: 512,
      messages: [{ role: 'user', content: 'What is the weather in Austin?' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    });
    expect(msgRes.role).toBe('assistant');
    expect(msgRes.stop_reason).toBe('tool_use');
    const toolUseBlock = msgRes.content.find((b) => b.type === 'tool_use');
    expect(toolUseBlock).toBeDefined();
    expect((toolUseBlock as any).name).toBe('get_weather');
    expect((toolUseBlock as any).input).toEqual({ city: 'Austin' });

    // 4b. Anthropic messages.create (stream: true)
    const msgStream = await anthropic.messages.create({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Stream via Anthropic SDK' }],
      stream: true,
    });
    const eventTypes: string[] = [];
    let anthropicStreamedText = '';
    for await (const event of msgStream) {
      eventTypes.push(event.type);
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        anthropicStreamedText += event.delta.text;
      }
    }
    expect(eventTypes).toContain('message_start');
    expect(eventTypes).toContain('content_block_start');
    expect(eventTypes).toContain('content_block_delta');
    expect(eventTypes).toContain('message_delta');
    expect(eventTypes).toContain('message_stop');
    expect(anthropicStreamedText).toBe('Hello from sovereign stream!');
  });
});
