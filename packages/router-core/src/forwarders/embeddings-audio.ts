import type { RouterConfig, UpstreamConfig } from '../index.js';
import type { RequestScope } from '../context/index.js';
import { applyPrivacyGuard } from '../guard.js';
import {
  isDedicatedAudioUpstreamType,
  inferAudioMimeType,
  STT_BACKEND_PRESETS,
  TTS_BACKEND_PRESETS,
  type AudioResponseFormat,
  type TranscriptionResponseFormat,
} from '../audio.js';
import {
  isLocalUpstream,
  getEffectiveCostPer1kTokens,
  estimateUpstreamRequestCostUsd,
} from '../cost.js';
import { validateUpstreamHttpEndpoint } from '../ssrf-guard.js';
import { resolveUpstreamSecret } from '../secrets.js';
import {
  normalizeEmbeddingVector,
  encodeFloat32VectorBase64,
} from '../protocol-adapters.js';
import * as dbModule from '../db.js';
import type { RouterDeps } from '../routing/strategies.js';

export async function executeEmbeddingsForward(
  config: RouterConfig,
  upstreams: UpstreamConfig[],
  request: {
    model?: string;
    input: string | string[];
    dimensions?: number;
    encoding_format?: 'float' | 'base64';
    user?: string;
  },
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    scope?: Partial<RequestScope>;
    hops?: number;
  },
  deps?: RouterDeps
): Promise<Response> {
  const fetchFn = deps?.fetch || globalThis.fetch;
  const logRequestFn = deps?.db?.logRequest || dbModule.logRequest;
  const getRollingSpendFn = deps?.db?.getRollingSpendUsd || dbModule.getRollingSpendUsd;

  const hops = options?.hops ?? 0;
  if (hops >= 2) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Routing loop detected (x-eluvix-hops=${hops} >= 2).`,
          type: 'loop_detected',
          code: 'max_hops_exceeded',
        },
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const rawInputs = Array.isArray(request.input)
    ? request.input
    : typeof request.input === 'string'
    ? [request.input]
    : [];

  if (rawInputs.length === 0 || rawInputs.some((item) => typeof item !== 'string')) {
    return new Response(
      JSON.stringify({
        error: {
          message: 'Missing or invalid "input": expected a non-empty string or array of strings.',
          type: 'invalid_request_error',
          code: 'invalid_embedding_input',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let inputs = [...rawInputs];
  if (config.privacyGuard?.enabled) {
    const scrubbed: string[] = [];
    for (const text of inputs) {
      const check = applyPrivacyGuard([{ role: 'user', content: text }], {
        enabled: true,
        action: config.privacyGuard.action || 'anonymize',
        detectPii: config.privacyGuard.detectPii,
        customPatterns: config.privacyGuard.customPatterns,
        redactionStyle: config.privacyGuard.redactionStyle,
        whitelist: config.privacyGuard.whitelist,
        auditLogging: config.privacyGuard.auditLogging,
      });
      if (!check.passed) {
        return new Response(
          JSON.stringify({
            error: {
              message: check.reason || 'Embedding input blocked by Privacy Guard',
              type: 'privacy_guard_violation',
              code: 'pii_leakage_detected',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const mod = check.modifiedMessages[0]?.content;
      scrubbed.push(typeof mod === 'string' ? mod : text);
    }
    inputs = scrubbed;
  }

  const requestedModel = (request.model || 'auto').trim();
  let candidates = upstreams.filter(
    (u) =>
      u.type !== 'comfyui' &&
      u.type !== 'antigravity' &&
      u.type !== 'harness' &&
      u.type !== 'anthropic' &&
      !isDedicatedAudioUpstreamType(u.type) &&
      !u.endpoint?.startsWith('cli://') &&
      !u.endpoint?.startsWith('acp://')
  );

  if (config.egressPolicy === 'local-only') {
    candidates = candidates.filter((u) => isLocalUpstream(u));
    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: `No local embedding upstream available for model: ${requestedModel} (egressPolicy: local-only).`,
            type: 'invalid_request_error',
            code: 'egress_policy_local_only',
          },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  const switchyardConfig = config.switchyard || {};
  if (
    typeof switchyardConfig.maxDailySpendUsd === 'number' &&
    Number.isFinite(switchyardConfig.maxDailySpendUsd) &&
    switchyardConfig.maxDailySpendUsd > 0
  ) {
    const rolling24h = getRollingSpendFn(24);
    if (rolling24h >= switchyardConfig.maxDailySpendUsd) {
      const action = switchyardConfig.budgetExhaustedAction || 'prefer-local';
      if (action === 'reject') {
        return new Response(
          JSON.stringify({
            error: {
              message: `Daily cloud spend cap exceeded ($${rolling24h.toFixed(4)} >= $${switchyardConfig.maxDailySpendUsd.toFixed(2)}).`,
              type: 'budget_exceeded',
              code: 'daily_spend_cap_exceeded',
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const zeroCost = candidates.filter((u) => getEffectiveCostPer1kTokens(u) <= 0);
      if (action === 'strict-local' && zeroCost.length === 0) {
        return new Response(
          JSON.stringify({
            error: {
              message: 'Daily spend cap exceeded and no $0.00 local embedding upstream is available.',
              type: 'budget_exceeded',
              code: 'daily_spend_cap_exceeded',
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (zeroCost.length > 0) {
        candidates = zeroCost;
      }
    }
  }

  if (candidates.length === 0) {
    return new Response(
      JSON.stringify({
        error: {
          message: `No embedding-capable upstream available for model: ${requestedModel}.`,
          type: 'invalid_request_error',
          code: 'no_embedding_upstream',
        },
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }

  candidates.sort((a, b) => {
    const exactA = requestedModel !== 'auto' && a.models?.includes(requestedModel) ? 1 : 0;
    const exactB = requestedModel !== 'auto' && b.models?.includes(requestedModel) ? 1 : 0;
    if (exactA !== exactB) return exactB - exactA;
    const costA = getEffectiveCostPer1kTokens(a);
    const costB = getEffectiveCostPer1kTokens(b);
    if (costA !== costB) return costA - costB;
    return b.priority - a.priority;
  });

  const timeoutMs = options?.timeoutMs ?? switchyardConfig.timeoutMs ?? 30000;
  const pinnedDimensions =
    typeof request.dimensions === 'number' && request.dimensions > 0
      ? Math.floor(request.dimensions)
      : undefined;
  const encodingFormat = request.encoding_format === 'base64' ? 'base64' : 'float';
  const estTokens = Math.max(
    1,
    Math.ceil(inputs.reduce((sum, s) => sum + s.length, 0) / 4)
  );

  let lastDimensionError: string | null = null;
  let lastError: string | null = null;

  for (const upstream of candidates) {
    const endpointCheck = validateUpstreamHttpEndpoint(upstream.endpoint, {
      allowLoopbackAndLan: true,
    });
    if (!endpointCheck.ok) {
      lastError = endpointCheck.reason || `Blocked unsafe upstream endpoint: ${upstream.endpoint}`;
      continue;
    }

    const effectiveModel =
      requestedModel !== 'auto' &&
      (upstream.models?.includes(requestedModel) ||
        upstream.models?.includes('*') ||
        !isLocalUpstream(upstream))
        ? requestedModel
        : upstream.models?.find((m) => /embed|bge|nomic|mxbai|e5|gte/i.test(m)) ||
          (upstream.type === 'ollama'
            ? 'nomic-embed-text'
            : requestedModel !== 'auto'
            ? requestedModel
            : 'text-embedding-3-small');

    const trimmed = upstream.endpoint.trim().replace(/\/+$/, '');
    const baseWithoutV1 = trimmed.replace(/\/v1$/, '');
    const startTime = Date.now();

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (upstream.apiKey) {
        const resolvedKey =
          (await resolveUpstreamSecret(upstream.apiKey, { fetchImpl: fetchFn })) || upstream.apiKey;
        headers['Authorization'] = `Bearer ${resolvedKey}`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (options?.signal) {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      let res = await fetchFn(
        trimmed.endsWith('/v1') ? `${trimmed}/embeddings` : `${trimmed}/v1/embeddings`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: effectiveModel,
            input: inputs,
            ...(pinnedDimensions ? { dimensions: pinnedDimensions } : {}),
          }),
          signal: controller.signal,
        }
      );

      if (!res.ok && res.status === 404 && upstream.type === 'ollama') {
        res = await fetchFn(`${baseWithoutV1}/api/embed`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: effectiveModel,
            input: inputs,
          }),
          signal: controller.signal,
        });
      }

      clearTimeout(timer);

      if (!res.ok) {
        lastError = `Upstream ${upstream.name} returned HTTP ${res.status}`;
        continue;
      }

      const payload = (await res.json()) as Record<string, any>;
      const rawVectors: number[][] = Array.isArray(payload.data)
        ? payload.data.map((d: any) => d.embedding)
        : Array.isArray(payload.embeddings)
        ? payload.embeddings
        : Array.isArray(payload.embedding)
        ? [payload.embedding]
        : [];

      if (rawVectors.length === 0) {
        lastError = `Upstream ${upstream.name} returned no embedding vectors`;
        continue;
      }

      let anySliced = false;
      let resolvedDims = 0;
      const formattedData = rawVectors.map((vec, index) => {
        const norm = normalizeEmbeddingVector(vec, pinnedDimensions);
        if (norm.sliced) anySliced = true;
        resolvedDims = norm.dimensions;
        return {
          object: 'embedding',
          index,
          embedding:
            encodingFormat === 'base64'
              ? encodeFloat32VectorBase64(norm.vector)
              : norm.vector,
        };
      });

      const duration_ms = Date.now() - startTime;
      const promptTokens = Number(payload?.usage?.prompt_tokens ?? estTokens);
      const costUsd = estimateUpstreamRequestCostUsd(upstream, promptTokens, 0);

      logRequestFn({
        model: effectiveModel,
        upstream_id: upstream.id,
        status: 200,
        duration_ms,
        prompt_tokens: promptTokens,
        completion_tokens: 0,
        ttft_ms: duration_ms,
        cost_usd: costUsd,
        user_id: options?.scope?.userId || 'default',
      });

      return new Response(
        JSON.stringify({
          object: 'list',
          data: formattedData,
          model: effectiveModel,
          usage: {
            prompt_tokens: promptTokens,
            total_tokens: promptTokens,
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'x-eluvix-upstream': upstream.id,
            'x-eluvix-model': effectiveModel,
            'x-eluvix-embedding-dims': String(resolvedDims),
            'x-eluvix-embedding-dimensions': String(resolvedDims),
            'x-eluvix-cost-usd': costUsd.toFixed(6),
            ...(anySliced ? { 'x-eluvix-matryoshka-sliced': 'true' } : {}),
          },
        }
      );
    } catch (err: any) {
      if (err?.dimensionMismatch) {
        lastDimensionError = err.message;
        continue;
      }
      lastError = err?.message || `Failed to reach embedding upstream ${upstream.name}`;
    }
  }

  if (lastDimensionError) {
    return new Response(
      JSON.stringify({
        error: {
          message: lastDimensionError,
          type: 'invalid_request_error',
          code: 'embedding_dimension_mismatch',
        },
      }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      error: {
        message: lastError || 'All embedding upstreams failed.',
        type: 'upstream_error',
        code: 'embedding_failed',
      },
    }),
    { status: 502, headers: { 'Content-Type': 'application/json' } }
  );
}

export async function executeAudioTranscriptionForward(
  config: RouterConfig,
  upstreams: UpstreamConfig[],
  request: {
    file: Blob | Uint8Array;
    filename?: string;
    mimeType?: string;
    model?: string;
    language?: string;
    prompt?: string;
    response_format?: TranscriptionResponseFormat;
    temperature?: number;
  },
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    scope?: Partial<RequestScope>;
    hops?: number;
  },
  deps?: RouterDeps
): Promise<Response> {
  const fetchFn = deps?.fetch || globalThis.fetch;
  const logRequestFn = deps?.db?.logRequest || dbModule.logRequest;

  const hops = options?.hops ?? 0;
  if (hops >= 2) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Routing loop detected (x-eluvix-hops=${hops} >= 2).`,
          type: 'loop_detected',
          code: 'max_hops_exceeded',
        },
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!request.file) {
    return new Response(
      JSON.stringify({
        error: {
          message: 'Missing required multipart field "file" for audio transcription.',
          type: 'invalid_request_error',
          code: 'missing_audio_file',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let candidates = upstreams.filter((u) => {
    if (u.type === 'kokoro-tts') return false;
    if (isDedicatedAudioUpstreamType(u.type)) {
      return u.audio?.mode !== 'tts';
    }
    if (u.audio && u.audio.mode !== 'tts') return true;
    if (u.type === 'lemonade' || u.type === 'openai-compatible') return true;
    return false;
  });

  if (config.egressPolicy === 'local-only') {
    candidates = candidates.filter((u) => {
      const effEndpoint = u.audio?.sttEndpoint || u.endpoint;
      return isLocalUpstream({ ...u, endpoint: effEndpoint });
    });
    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'No local STT audio upstream available (egressPolicy: local-only).',
            type: 'invalid_request_error',
            code: 'egress_policy_local_only',
          },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  if (candidates.length === 0) {
    candidates = [
      {
        id: 'default-speaches-stt',
        name: 'Local Speaches Faster-Whisper (:8005)',
        type: 'speaches',
        endpoint: 'http://127.0.0.1:8005',
        priority: 1,
        models: ['*'],
        audio: {
          mode: 'stt',
          sttBackend: 'speaches',
          defaultSttModel: STT_BACKEND_PRESETS.speaches.defaultModel,
        },
      },
    ];
  }

  candidates.sort((a, b) => {
    const dedA = isDedicatedAudioUpstreamType(a.type) || Boolean(a.audio) ? 1 : 0;
    const dedB = isDedicatedAudioUpstreamType(b.type) || Boolean(b.audio) ? 1 : 0;
    if (dedA !== dedB) return dedB - dedA;
    const costA = getEffectiveCostPer1kTokens(a);
    const costB = getEffectiveCostPer1kTokens(b);
    if (costA !== costB) return costA - costB;
    return b.priority - a.priority;
  });

  const fileBlob =
    request.file instanceof Blob
      ? request.file
      : new Blob([request.file as any], { type: request.mimeType || 'audio/wav' });
  const filename = request.filename || 'audio.wav';
  const responseFormat: TranscriptionResponseFormat = request.response_format || 'json';
  const timeoutMs = options?.timeoutMs ?? config.switchyard?.timeoutMs ?? 60000;
  let lastError = 'All STT audio upstreams failed.';

  for (const upstream of candidates) {
    const rawTargetEndpoint = upstream.audio?.sttEndpoint || upstream.endpoint;
    const endpointCheck = validateUpstreamHttpEndpoint(rawTargetEndpoint, {
      allowLoopbackAndLan: true,
    });
    if (!endpointCheck.ok) {
      lastError = endpointCheck.reason || `Blocked unsafe STT endpoint: ${rawTargetEndpoint}`;
      continue;
    }

    const sttPreset =
      upstream.audio?.sttBackend ||
      (upstream.type === 'lemonade'
        ? 'lemonade'
        : isLocalUpstream(upstream)
        ? 'speaches'
        : 'openai');
    const effectiveModel =
      request.model &&
      request.model !== 'auto' &&
      request.model !== '*' &&
      !(isLocalUpstream(upstream) && request.model === 'whisper-1' && upstream.audio?.defaultSttModel)
        ? request.model
        : upstream.audio?.defaultSttModel ||
          STT_BACKEND_PRESETS[sttPreset]?.defaultModel ||
          'whisper-1';

    const trimmed = rawTargetEndpoint.trim().replace(/\/+$/, '');
    const url = trimmed.endsWith('/v1')
      ? `${trimmed}/audio/transcriptions`
      : `${trimmed}/v1/audio/transcriptions`;

    const form = new FormData();
    form.append('file', fileBlob, filename);
    form.append('model', effectiveModel);
    if (request.language) form.append('language', request.language);
    if (request.prompt) form.append('prompt', request.prompt);
    if (request.response_format) form.append('response_format', request.response_format);
    if (typeof request.temperature === 'number') {
      form.append('temperature', String(request.temperature));
    }

    const headers: Record<string, string> = {};
    if (upstream.apiKey) {
      headers['Authorization'] = `Bearer ${upstream.apiKey}`;
    }

    const startTime = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (options?.signal) {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        lastError = `STT upstream ${upstream.name} returned HTTP ${res.status}`;
        continue;
      }

      const shouldScrub =
        Boolean(config.privacyGuard?.enabled) || Boolean(upstream.audio?.scrubTranscriptPii);

      const scrubString = (raw: string): string => {
        if (!shouldScrub || !raw) return raw;
        const check = applyPrivacyGuard([{ role: 'user', content: raw }], {
          enabled: true,
          action: 'anonymize',
          detectPii: config.privacyGuard?.detectPii,
          customPatterns: config.privacyGuard?.customPatterns,
          redactionStyle: config.privacyGuard?.redactionStyle || 'token',
          whitelist: config.privacyGuard?.whitelist,
          auditLogging: false,
        });
        const mod = check.modifiedMessages[0]?.content;
        return typeof mod === 'string' ? mod : raw;
      };

      const duration_ms = Date.now() - startTime;

      if (responseFormat === 'text' || responseFormat === 'srt' || responseFormat === 'vtt') {
        const rawText = await res.text();
        const finalText = scrubString(rawText);
        const completionTokens = Math.max(1, Math.ceil(finalText.length / 4));
        const costUsd = estimateUpstreamRequestCostUsd(upstream, 64, completionTokens);
        logRequestFn({
          model: effectiveModel,
          upstream_id: upstream.id,
          status: 200,
          duration_ms,
          prompt_tokens: 64,
          completion_tokens: completionTokens,
          ttft_ms: duration_ms,
          cost_usd: costUsd,
          user_id: options?.scope?.userId || 'default',
        });
        return new Response(finalText, {
          status: 200,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'x-eluvix-upstream': upstream.id,
            'x-eluvix-model': effectiveModel,
            'x-eluvix-cost-usd': costUsd.toFixed(6),
          },
        });
      }

      const jsonPayload = (await res.json()) as Record<string, any>;
      if (typeof jsonPayload.text === 'string') {
        jsonPayload.text = scrubString(jsonPayload.text);
      }
      const completionTokens = Math.max(
        1,
        Math.ceil(String(jsonPayload.text || '').length / 4)
      );
      const costUsd = estimateUpstreamRequestCostUsd(upstream, 64, completionTokens);

      logRequestFn({
        model: effectiveModel,
        upstream_id: upstream.id,
        status: 200,
        duration_ms,
        prompt_tokens: 64,
        completion_tokens: completionTokens,
        ttft_ms: duration_ms,
        cost_usd: costUsd,
        user_id: options?.scope?.userId || 'default',
      });

      return new Response(JSON.stringify(jsonPayload), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-eluvix-upstream': upstream.id,
          'x-eluvix-model': effectiveModel,
          'x-eluvix-cost-usd': costUsd.toFixed(6),
        },
      });
    } catch (err: any) {
      lastError = err?.message || `Failed to reach STT upstream ${upstream.name}`;
    }
  }

  return new Response(
    JSON.stringify({
      error: {
        message: lastError,
        type: 'upstream_error',
        code: 'audio_transcription_failed',
      },
    }),
    { status: 502, headers: { 'Content-Type': 'application/json' } }
  );
}

export async function executeAudioSpeechForward(
  config: RouterConfig,
  upstreams: UpstreamConfig[],
  request: {
    input: string;
    model?: string;
    voice?: string;
    response_format?: AudioResponseFormat;
    speed?: number;
  },
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    scope?: Partial<RequestScope>;
    hops?: number;
  },
  deps?: RouterDeps
): Promise<Response> {
  const fetchFn = deps?.fetch || globalThis.fetch;
  const logRequestFn = deps?.db?.logRequest || dbModule.logRequest;

  const hops = options?.hops ?? 0;
  if (hops >= 2) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Routing loop detected (x-eluvix-hops=${hops} >= 2).`,
          type: 'loop_detected',
          code: 'max_hops_exceeded',
        },
      }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (typeof request.input !== 'string' || !request.input.trim()) {
    return new Response(
      JSON.stringify({
        error: {
          message: 'Missing required non-empty "input" text for speech synthesis.',
          type: 'invalid_request_error',
          code: 'missing_speech_input',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let speechInput = request.input;
  if (config.privacyGuard?.enabled) {
    const check = applyPrivacyGuard([{ role: 'user', content: speechInput }], {
      enabled: true,
      action: config.privacyGuard.action || 'anonymize',
      detectPii: config.privacyGuard.detectPii,
      customPatterns: config.privacyGuard.customPatterns,
      redactionStyle: config.privacyGuard.redactionStyle,
      whitelist: config.privacyGuard.whitelist,
      auditLogging: config.privacyGuard.auditLogging,
    });
    if (!check.passed) {
      return new Response(
        JSON.stringify({
          error: {
            message: check.reason || 'Speech input blocked by Privacy Guard',
            type: 'privacy_guard_violation',
            code: 'pii_leakage_detected',
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const mod = check.modifiedMessages[0]?.content;
    if (typeof mod === 'string') speechInput = mod;
  }

  let candidates = upstreams.filter((u) => {
    if (u.type === 'whisper' || u.type === 'speaches') {
      return Boolean(u.audio && u.audio.mode !== 'stt' && u.audio.ttsEndpoint);
    }
    if (isDedicatedAudioUpstreamType(u.type)) {
      return u.audio?.mode !== 'stt';
    }
    if (u.audio && u.audio.mode !== 'stt') return true;
    if (u.type === 'lemonade' || u.type === 'openai-compatible') return true;
    return false;
  });

  if (config.egressPolicy === 'local-only') {
    candidates = candidates.filter((u) => {
      const effEndpoint = u.audio?.ttsEndpoint || u.endpoint;
      return isLocalUpstream({ ...u, endpoint: effEndpoint });
    });
    if (candidates.length === 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'No local TTS speech upstream available (egressPolicy: local-only).',
            type: 'invalid_request_error',
            code: 'egress_policy_local_only',
          },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  if (candidates.length === 0) {
    candidates = [
      {
        id: 'default-kokoro-tts',
        name: 'Local Kokoro-FastAPI TTS (:8880)',
        type: 'kokoro-tts',
        endpoint: 'http://127.0.0.1:8880',
        priority: 1,
        models: ['*'],
        audio: {
          mode: 'tts',
          ttsBackend: 'kokoro',
          defaultTtsModel: TTS_BACKEND_PRESETS.kokoro.defaultModel,
          defaultVoice: TTS_BACKEND_PRESETS.kokoro.defaultVoice,
        },
      },
    ];
  }

  candidates.sort((a, b) => {
    const dedA = isDedicatedAudioUpstreamType(a.type) || Boolean(a.audio) ? 1 : 0;
    const dedB = isDedicatedAudioUpstreamType(b.type) || Boolean(b.audio) ? 1 : 0;
    if (dedA !== dedB) return dedB - dedA;
    const costA = getEffectiveCostPer1kTokens(a);
    const costB = getEffectiveCostPer1kTokens(b);
    if (costA !== costB) return costA - costB;
    return b.priority - a.priority;
  });

  const timeoutMs = options?.timeoutMs ?? config.switchyard?.timeoutMs ?? 60000;
  const estPromptTokens = Math.max(1, Math.ceil(speechInput.length / 4));
  let lastError = 'All TTS speech upstreams failed.';

  for (const upstream of candidates) {
    const rawTargetEndpoint =
      upstream.audio?.ttsEndpoint ||
      (upstream.audio?.mode === 'both' &&
      upstream.audio?.ttsBackend &&
      upstream.audio.ttsBackend !== 'openai' &&
      upstream.audio.ttsBackend !== 'lemonade' &&
      upstream.endpoint.includes(':8005')
        ? 'http://localhost:8880'
        : upstream.endpoint);

    const endpointCheck = validateUpstreamHttpEndpoint(rawTargetEndpoint, {
      allowLoopbackAndLan: true,
    });
    if (!endpointCheck.ok) {
      lastError = endpointCheck.reason || `Blocked unsafe TTS endpoint: ${rawTargetEndpoint}`;
      continue;
    }

    const ttsPreset =
      upstream.audio?.ttsBackend ||
      (upstream.type === 'lemonade'
        ? 'lemonade'
        : isLocalUpstream({ ...upstream, endpoint: rawTargetEndpoint })
        ? 'kokoro'
        : 'openai');
    const effectiveModel =
      request.model &&
      request.model !== 'auto' &&
      request.model !== '*' &&
      !(
        isLocalUpstream({ ...upstream, endpoint: rawTargetEndpoint }) &&
        (request.model === 'tts-1' ||
          request.model === 'tts-1-hd' ||
          request.model === 'gpt-4o-mini-tts') &&
        upstream.audio?.defaultTtsModel
      )
        ? request.model
        : upstream.audio?.defaultTtsModel ||
          TTS_BACKEND_PRESETS[ttsPreset]?.defaultModel ||
          'kokoro';

    const effectiveVoice =
      request.voice ||
      upstream.audio?.defaultVoice ||
      TTS_BACKEND_PRESETS[ttsPreset]?.defaultVoice ||
      'af_heart';
    const format: AudioResponseFormat =
      request.response_format || upstream.audio?.responseFormat || 'mp3';

    const trimmed = rawTargetEndpoint.trim().replace(/\/+$/, '');
    const url = trimmed.endsWith('/v1')
      ? `${trimmed}/audio/speech`
      : `${trimmed}/v1/audio/speech`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (upstream.apiKey) {
      headers['Authorization'] = `Bearer ${upstream.apiKey}`;
    }

    const startTime = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (options?.signal) {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }

      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: effectiveModel,
          input: speechInput,
          voice: effectiveVoice,
          response_format: format,
          ...(typeof request.speed === 'number' ? { speed: request.speed } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        lastError = `TTS upstream ${upstream.name} returned HTTP ${res.status}`;
        continue;
      }

      const audioBytes = await res.arrayBuffer();
      const duration_ms = Date.now() - startTime;
      const costUsd = estimateUpstreamRequestCostUsd(upstream, estPromptTokens, 0);

      logRequestFn({
        model: effectiveModel,
        upstream_id: upstream.id,
        status: 200,
        duration_ms,
        prompt_tokens: estPromptTokens,
        completion_tokens: 0,
        ttft_ms: duration_ms,
        cost_usd: costUsd,
        user_id: options?.scope?.userId || 'default',
      });

      const mimeType = res.headers.get('content-type') || inferAudioMimeType(format);
      return new Response(audioBytes, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'x-eluvix-upstream': upstream.id,
          'x-eluvix-model': effectiveModel,
          'x-eluvix-audio-voice': effectiveVoice,
          'x-eluvix-cost-usd': costUsd.toFixed(6),
        },
      });
    } catch (err: any) {
      lastError = err?.message || `Failed to reach TTS upstream ${upstream.name}`;
    }
  }

  return new Response(
    JSON.stringify({
      error: {
        message: lastError,
        type: 'upstream_error',
        code: 'audio_speech_failed',
      },
    }),
    { status: 502, headers: { 'Content-Type': 'application/json' } }
  );
}
