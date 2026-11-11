import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { createNamedApiKey } from '@eluvix/router-core';
import { middleware } from '@/middleware';
import { resolveCallerIdentity } from '@/lib/caller-identity';
import { saveConfig } from '@/lib/router';
import { POST as postMessages } from '@/app/api/v1/messages/route';
import { POST as postResponses } from '@/app/api/v1/responses/route';
import { GET as getResponseById, DELETE as deleteResponseById } from '@/app/api/v1/responses/[id]/route';
import { POST as postEmbeddings } from '@/app/api/v1/embeddings/route';
import { POST as postTranscriptions } from '@/app/api/v1/audio/transcriptions/route';
import { POST as postSpeech } from '@/app/api/v1/audio/speech/route';
import { compileGraph } from '@/lib/orchestration/compiler';
import { decompileConfigToGraph } from '@/lib/orchestration/decompiler';
import { analyzeGraphDiagnostics } from '@/lib/orchestration/diagnostics';
import { diffRouterConfigs } from '@/lib/config-diff';

describe('Wave 1 Next.js: x-api-key Auth, /v1/messages, /v1/responses, /v1/embeddings, /v1/audio/* & AudioVoiceNode', () => {
  let tmpDir: string;
  let origConfigHome: string | undefined;
  let origDataHome: string | undefined;
  let origConfigPath: string | undefined;

  beforeEach(() => {
    origConfigHome = process.env.XDG_CONFIG_HOME;
    origDataHome = process.env.XDG_DATA_HOME;
    origConfigPath = process.env.ELUVIX_CONFIG_PATH;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eluvix-wave4-nextjs-'));
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'config');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'data');
    process.env.ELUVIX_CONFIG_PATH = path.join(tmpDir, 'config', 'config.json');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origConfigHome;
    if (origDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origDataHome;
    if (origConfigPath === undefined) delete process.env.ELUVIX_CONFIG_PATH;
    else process.env.ELUVIX_CONFIG_PATH = origConfigPath;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('authenticates x-api-key identically to Authorization: Bearer in middleware and resolveCallerIdentity while blocking /api/secrets/*', async () => {
    const aliceKey = createNamedApiKey({ label: 'Claude Code Alice', userId: 'alice', role: 'operator' });

    for (const pathUrl of [
      'http://localhost:3588/api/v1/messages',
      'http://localhost:3588/v1/messages',
      'http://localhost:3588/api/v1/responses',
      'http://localhost:3588/api/v1/embeddings',
      'http://localhost:3588/api/v1/audio/speech',
    ]) {
      const mwRes = await middleware(
        new NextRequest(pathUrl, {
          method: 'POST',
          headers: { 'x-api-key': aliceKey.key },
        })
      );
      expect(mwRes.headers.get('x-middleware-next')).toBe('1');
    }

    // Named elx_ keys over x-api-key must still be blocked from /api/secrets/*
    const blockedSecrets = await middleware(
      new NextRequest('http://localhost:3588/api/secrets/keys', {
        method: 'GET',
        headers: { 'x-api-key': aliceKey.key },
      })
    );
    expect(blockedSecrets.status).toBe(401);

    const resolved = await resolveCallerIdentity(
      new Request('http://localhost:3588/api/v1/messages', {
        headers: { 'x-api-key': aliceKey.key },
      })
    );
    expect(resolved).toEqual({
      ok: true,
      userId: 'alice',
      role: 'operator',
      via: 'api-key',
    });
  });

  it('serves POST /api/v1/messages with vendor tier aliasing and Anthropic Message output', async () => {
    const key = createNamedApiKey({ label: 'Anthropic SDK', userId: 'dev1' });
    saveConfig({
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Qwen',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 20,
          models: ['qwen2.5-coder:14b'],
          maxComplexityScore: 4,
        },
      ],
      switchyard: { strategy: 'cost-complexity' },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-local-1',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: '<think>Quick check</think>Sovereign local response!',
              },
            },
          ],
          usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await postMessages(
      new Request('http://localhost:3588/api/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key.key,
        },
        body: JSON.stringify({
          model: 'claude-3-7-sonnet-20250219',
          max_tokens: 512,
          messages: [{ role: 'user', content: 'Hello from Claude Code!' }],
        }),
      })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('x-eluvix-model-alias')).toContain('claude-3-7-sonnet-20250219->');
    expect(res.headers.get('x-eluvix-model-alias')).toContain('tier:heavy');
    const body = await res.json();
    expect(body.type).toBe('message');
    expect(body.content[0]).toEqual({ type: 'thinking', thinking: 'Quick check' });
    expect(body.content[1]).toEqual({ type: 'text', text: 'Sovereign local response!' });
  });

  it('serves stateful POST/GET/DELETE /api/v1/responses with userId isolation and store:false support', async () => {
    const aliceKey = createNamedApiKey({ label: 'Alice', userId: 'alice' });
    const bobKey = createNamedApiKey({ label: 'Bob', userId: 'bob' });

    saveConfig({
      upstreams: [
        {
          id: 'local-ollama',
          name: 'Local Ollama',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 20,
          models: ['llama3.2'],
        },
      ],
    });

    const seenMessageCounts: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const parsed = JSON.parse(String(init?.body || '{}'));
      seenMessageCounts.push(parsed.messages.length);
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `Ack turn ${seenMessageCounts.length}` } }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // Turn 1 (stored for alice)
    const r1 = await postResponses(
      new Request('http://localhost:3588/api/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceKey.key}` },
        body: JSON.stringify({ model: 'llama3.2', input: 'Remember code 42' }),
      })
    );
    expect(r1.status).toBe(200);
    const r1Json = await r1.json();
    expect(r1Json.id).toMatch(/^resp_/);

    // Turn 2 chaining previous_response_id -> should send 3 messages (prior user + prior assistant + new user)
    const r2 = await postResponses(
      new Request('http://localhost:3588/api/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceKey.key}` },
        body: JSON.stringify({
          model: 'llama3.2',
          previous_response_id: r1Json.id,
          input: 'What code did I say?',
        }),
      })
    );
    expect(r2.status).toBe(200);
    expect(seenMessageCounts).toEqual([1, 3]);

    // Bob cannot read Alice's stored response
    const bobGet = await getResponseById(
      new Request(`http://localhost:3588/api/v1/responses/${r1Json.id}`, {
        headers: { Authorization: `Bearer ${bobKey.key}` },
      }),
      { params: { id: r1Json.id } }
    );
    expect(bobGet.status).toBe(404);

    // Zero-retention store:false is NOT persisted
    const ephemeral = await postResponses(
      new Request('http://localhost:3588/api/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceKey.key}` },
        body: JSON.stringify({ model: 'llama3.2', input: 'Zero retention', store: false }),
      })
    );
    const ephJson = await ephemeral.json();
    const getEph = await getResponseById(
      new Request(`http://localhost:3588/api/v1/responses/${ephJson.id}`, {
        headers: { Authorization: `Bearer ${aliceKey.key}` },
      }),
      { params: { id: ephJson.id } }
    );
    expect(getEph.status).toBe(404);

    // Alice can delete her own stored response
    const delRes = await deleteResponseById(
      new Request(`http://localhost:3588/api/v1/responses/${r1Json.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${aliceKey.key}` },
      }),
      { params: { id: r1Json.id } }
    );
    expect(delRes.status).toBe(200);
  });

  it('serves POST /api/v1/embeddings and headless /api/v1/audio/transcriptions + /api/v1/audio/speech', async () => {
    const key = createNamedApiKey({ label: 'Multimodal Client', userId: 'mm1' });
    saveConfig({
      upstreams: [
        {
          id: 'ollama-emb',
          name: 'Ollama Embed',
          type: 'ollama',
          endpoint: 'http://localhost:11434',
          priority: 20,
          models: ['nomic-embed-text'],
        },
        {
          id: 'audio-local',
          name: 'Local Audio Stack',
          type: 'audio',
          endpoint: 'http://localhost:8005',
          priority: 20,
          models: ['whisper-1', 'tts-1'],
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
      ],
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/v1/embeddings')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.endsWith('/api/embed')) {
        return new Response(JSON.stringify({ embeddings: [[0.6, 0.8, 0.0]] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes(':8005/v1/audio/transcriptions')) {
        return new Response(JSON.stringify({ text: 'Transcribed cleanly.' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes(':8880/v1/audio/speech')) {
        return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x64]), {
          status: 200,
          headers: { 'Content-Type': 'audio/mpeg' },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const embRes = await postEmbeddings(
      new Request('http://localhost:3588/api/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key.key },
        body: JSON.stringify({ model: 'nomic-embed-text', input: 'sovereign rag', dimensions: 2 }),
      })
    );
    expect(embRes.status).toBe(200);
    const embJson = await embRes.json();
    expect(embJson.data[0].embedding).toHaveLength(2);

    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'clip.wav');
    const sttRes = await postTranscriptions(
      new Request('http://localhost:3588/api/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'x-api-key': key.key },
        body: fd,
      })
    );
    expect(sttRes.status).toBe(200);
    expect((await sttRes.json()).text).toBe('Transcribed cleanly.');

    const ttsRes = await postSpeech(
      new Request('http://localhost:3588/api/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key.key },
        body: JSON.stringify({ input: 'Hello sovereign world' }),
      })
    );
    expect(ttsRes.status).toBe(200);
    expect(ttsRes.headers.get('content-type')).toContain('audio/mpeg');
  });

  it('compiles, decompiles, diffs, and estimates VRAM for AudioVoiceNode without mutating existing snapshots', () => {
    const compiled = compileGraph(
      [
        { id: 'input-1', type: 'inputNode', position: { x: 0, y: 0 }, data: {} },
        { id: 'sw-1', type: 'switchyardNode', position: { x: 300, y: 0 }, data: { strategy: 'cost-complexity' } },
        {
          id: 'audio-voice-1',
          type: 'audioVoiceNode',
          position: { x: 600, y: 0 },
          data: {
            label: 'Sovereign Audio Engine',
            endpoint: 'http://localhost:8005',
            priority: 20,
            audio: {
              mode: 'both',
              sttPreset: 'speaches',
              ttsPreset: 'kokoro',
              ttsEndpoint: 'http://localhost:8880',
              defaultVoice: 'af_heart',
              responseFormat: 'mp3',
              scrubTranscriptPii: true,
            },
          },
        },
      ],
      [
        { id: 'e1', source: 'input-1', target: 'sw-1' },
        { id: 'e2', source: 'sw-1', target: 'audio-voice-1', sourceHandle: 'tier-1' },
      ]
    );

    const audioUpstream = compiled.rawRouterConfig.upstreams.find((u: any) => u.id === 'audio-voice-1');
    expect(audioUpstream).toBeDefined();
    expect(audioUpstream.type).toBe('audio');
    expect(audioUpstream.audio?.sttBackend).toBe('speaches');
    expect(audioUpstream.audio?.ttsBackend).toBe('kokoro');
    expect(compiled.audioSetup).toContain('speaches');
    expect(compiled.audioSetup).toContain('kokoro-fastapi');

    const diag = analyzeGraphDiagnostics([
      {
        id: 'audio-voice-1',
        type: 'audioVoiceNode',
        position: { x: 0, y: 0 },
        data: { audio: { mode: 'both', sttPreset: 'speaches', ttsPreset: 'kokoro' } },
      },
    ], []);
    expect(diag.perNodeVramGb['audio-voice-1']).toBeGreaterThan(1);

    const decompiled = decompileConfigToGraph(compiled.rawRouterConfig);
    const restoredNode = decompiled.nodes.find((n) => n.id === 'audio-voice-1');
    expect(restoredNode?.type).toBe('audioVoiceNode');
    expect((restoredNode?.data as any)?.audio?.defaultVoice).toBe('af_heart');

    const modifiedConfig = structuredClone(compiled.rawRouterConfig);
    modifiedConfig.upstreams[0].audio.defaultVoice = 'am_adam';
    const diff = diffRouterConfigs(compiled.rawRouterConfig, modifiedConfig);
    expect(diff.changed[0]?.fields).toContain('audio');
  });
});
