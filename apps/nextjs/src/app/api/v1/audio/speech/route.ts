import { NextResponse } from 'next/server';
import { resolveBearerToken, type RequestScope } from '@eluvix/router-core';
import { getRouter, getProviderAgent } from '@/lib/router';
import { resolveSessionUserId, extractApiTokenFromHeaders } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/audio/speech (also reachable via /v1/audio/speech rewrite)
 *
 * Headless OpenAI-compatible Text-to-Speech (Kokoro-FastAPI / Piper / Lemonade / OpenAI)
 * binary audio synthesis gateway with SSRF protection and spend guardrails.
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

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json(
      {
        error: {
          message: `Invalid JSON in request body: ${err?.message || 'parse error'}`,
          type: 'invalid_request_error',
          code: 'invalid_json',
        },
      },
      { status: 400 }
    );
  }

  if (!body || typeof body !== 'object' || typeof body.input !== 'string' || !body.input.trim()) {
    return NextResponse.json(
      {
        error: {
          message: "Missing required parameter: 'input' must be a non-empty string.",
          type: 'invalid_request_error',
          param: 'input',
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

    const response = await router.routeAudioSpeech(body as any, {
      signal: req.signal,
      scope,
      hops,
    });

    const headers: Record<string, string> = {
      'Content-Type': response.headers.get('content-type') || 'audio/mpeg',
    };
    response.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (lower.startsWith('x-eluvix-') || lower === 'retry-after') {
        headers[key] = val;
      }
    });

    const audioBytes = await response.arrayBuffer();
    return new Response(audioBytes, {
      status: response.status,
      headers,
    });
  } catch (err: any) {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 502;
    return NextResponse.json(
      {
        error: {
          message: err?.message || 'Audio speech synthesis routing failed.',
          type: status < 500 ? 'invalid_request_error' : 'upstream_error',
        },
      },
      { status }
    );
  }
}
