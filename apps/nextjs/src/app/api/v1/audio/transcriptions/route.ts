import { NextResponse } from 'next/server';
import {
  resolveBearerToken,
  type RequestScope,
  type TranscriptionResponseFormat,
} from '@eluvix/router-core';
import { getRouter, getProviderAgent } from '@/lib/router';
import { resolveSessionUserId, extractApiTokenFromHeaders } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/audio/transcriptions (also reachable via /v1/audio/transcriptions rewrite)
 *
 * Headless OpenAI-compatible Speech-to-Text (Whisper / Speaches / whisper.cpp / Lemonade / OpenAI)
 * multipart FormData gateway with SSRF protection and optional post-STT PrivacyGuard scrubbing.
 */
export async function POST(req: Request) {
  let keyUserId: string | undefined;
  let keyOrigin: RequestScope['origin'] | undefined;
  const rawToken = extractApiTokenFromHeaders(req);
  if (rawToken && rawToken.startsWith('elx_')) {
    const resolved = resolveBearerToken(rawToken);
    if (!resolved.valid) {
      return NextResponse.json(
        {
          error: {
            message: 'Incorrect API key provided.',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        { status: 401 }
      );
    }
    keyUserId = resolved.userId;
    keyOrigin = resolved.origin;
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err: any) {
    return NextResponse.json(
      {
        error: {
          message: `Invalid multipart/form-data payload: ${err?.message || 'parse error'}`,
          type: 'invalid_request_error',
          code: 'invalid_multipart',
        },
      },
      { status: 400 }
    );
  }

  const fileField = formData.get('file');
  if (!fileField || typeof fileField === 'string') {
    return NextResponse.json(
      {
        error: {
          message: "Missing required multipart field: 'file'.",
          type: 'invalid_request_error',
          param: 'file',
          code: 'missing_required_parameter',
        },
      },
      { status: 400 }
    );
  }

  try {
    try {
      getProviderAgent().notifyConsumerActive(30000);
    } catch {
      // Ignore if provider agent isn't running
    }

    const router = getRouter();
    const sessionUserId = keyUserId ? null : await resolveSessionUserId(req);
    const scope: Partial<RequestScope> = {
      userId: keyUserId || sessionUserId || 'default',
      origin: keyOrigin || 'client',
    };
    const hops = Math.max(0, parseInt(req.headers.get('x-eluvix-hops') || '0', 10) || 0);

    const model = formData.get('model');
    const language = formData.get('language');
    const prompt = formData.get('prompt');
    const responseFormat = formData.get('response_format');
    const tempRaw = formData.get('temperature');

    const response = await router.routeAudioTranscription(
      {
        file: fileField as Blob,
        filename: (fileField as File).name || 'audio.wav',
        mimeType: (fileField as Blob).type || 'audio/wav',
        ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
        ...(typeof language === 'string' && language.trim() ? { language: language.trim() } : {}),
        ...(typeof prompt === 'string' && prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(typeof responseFormat === 'string' && responseFormat.trim()
          ? { response_format: responseFormat.trim() as TranscriptionResponseFormat }
          : {}),
        ...(typeof tempRaw === 'string' && Number.isFinite(Number(tempRaw))
          ? { temperature: Number(tempRaw) }
          : {}),
      },
      {
        signal: req.signal,
        scope,
        hops,
      }
    );

    const headers: Record<string, string> = {
      'Content-Type': response.headers.get('content-type') || 'application/json',
    };
    response.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (lower.startsWith('x-eluvix-') || lower === 'retry-after') {
        headers[key] = val;
      }
    });

    const bodyBytes = await response.arrayBuffer();
    return new Response(bodyBytes, {
      status: response.status,
      headers,
    });
  } catch (err: any) {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 502;
    return NextResponse.json(
      {
        error: {
          message: err?.message || 'Audio transcription routing failed.',
          type: status < 500 ? 'invalid_request_error' : 'upstream_error',
        },
      },
      { status }
    );
  }
}
