import { NextResponse } from 'next/server';
import { resolveBearerToken, type RequestScope } from '@eluvix/router-core';
import { getRouter, getProviderAgent } from '@/lib/router';
import { resolveSessionUserId, extractApiTokenFromHeaders } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/embeddings (also reachable via /v1/embeddings rewrite)
 *
 * Sovereign OpenAI-compatible embeddings router with PrivacyGuard PII scrubbing,
 * Ollama `/api/embed` + OpenAI `/v1/embeddings` multi-engine failover, and
 * Matryoshka L2-normalized vector dimension pinning (`dimensions`).
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

  if (!body || typeof body !== 'object' || body.input === undefined || body.input === null) {
    return NextResponse.json(
      {
        error: {
          message: "Missing required parameter: 'input' is required.",
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
      getProviderAgent().notifyConsumerActive(15000);
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

    const response = await router.routeEmbeddings(body as any, {
      signal: req.signal,
      scope,
      hops,
    });

    const traceHeaders: Record<string, string> = {};
    response.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (lower.startsWith('x-eluvix-') || lower === 'retry-after') {
        traceHeaders[key] = val;
      }
    });

    const payload = await response.json();
    return NextResponse.json(payload, {
      status: response.status,
      headers: traceHeaders,
    });
  } catch (err: any) {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 502;
    return NextResponse.json(
      {
        error: {
          message: err?.message || 'Embeddings routing failed.',
          type: status < 500 ? 'invalid_request_error' : 'upstream_error',
        },
      },
      { status }
    );
  }
}
