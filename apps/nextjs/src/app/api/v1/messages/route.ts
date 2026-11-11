import { NextResponse } from 'next/server';
import {
  resolveBearerToken,
  anthropicToOpenAiChatRequest,
  openAiToAnthropicMessageResponse,
  transformOpenAiSseToAnthropicSse,
  type AnthropicMessagesRequest,
  type ChatRequest,
  type RequestScope,
} from '@eluvix/router-core';
import { getRouter, getProviderAgent } from '@/lib/router';
import { resolveSessionUserId, extractApiTokenFromHeaders } from '@/lib/caller-identity';
import { classifyChatError } from '@/lib/chat-error';

export const dynamic = 'force-dynamic';

function anthropicErrorResponse(
  status: number,
  type: string,
  message: string,
  headers?: Record<string, string>
) {
  return NextResponse.json(
    {
      type: 'error',
      error: {
        type,
        message,
      },
    },
    { status, headers }
  );
}

/**
 * POST /api/v1/messages (also reachable via /v1/messages rewrite)
 *
 * Native Anthropic Messages API wire-protocol gateway for Claude Code,
 * Anthropic SDKs, and multi-agent harnesses. Supports `x-api-key` and
 * `Authorization: Bearer`, tool_use / tool_result turns, extended thinking
 * blocks, base64/URL vision blocks, capability-tier vendor model aliasing,
 * and full Anthropic SSE event-stream translation.
 */
export async function POST(req: Request) {
  let keyUserId: string | undefined;
  let keyOrigin: RequestScope['origin'] | undefined;
  const rawToken = extractApiTokenFromHeaders(req);
  if (rawToken && rawToken.startsWith('elx_')) {
    const resolved = resolveBearerToken(rawToken);
    if (!resolved.valid) {
      return anthropicErrorResponse(401, 'authentication_error', 'Incorrect API key provided.');
    }
    keyUserId = resolved.userId;
    keyOrigin = resolved.origin;
  }

  let body: AnthropicMessagesRequest;
  try {
    body = await req.json();
  } catch (err: any) {
    return anthropicErrorResponse(
      400,
      'invalid_request_error',
      `Invalid JSON in request body: ${err?.message || 'parse error'}`
    );
  }

  if (!body || typeof body !== 'object') {
    return anthropicErrorResponse(400, 'invalid_request_error', 'Request body must be a valid JSON object.');
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return anthropicErrorResponse(
      400,
      'invalid_request_error',
      "Missing required parameter: 'messages' must be a non-empty array."
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
    const headerOrigin = req.headers.get('x-eluvix-origin');
    const origin: RequestScope['origin'] =
      keyOrigin ||
      (headerOrigin === 'harness' || headerOrigin === 'playground' ? headerOrigin : 'client');
    const scope: Partial<RequestScope> = {
      userId: keyUserId || sessionUserId || 'default',
      sessionId: req.headers.get('x-eluvix-session') || undefined,
      origin,
    };
    const hops = Math.max(0, parseInt(req.headers.get('x-eluvix-hops') || '0', 10) || 0);

    const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'claude-3-7-sonnet';
    const chatReq = anthropicToOpenAiChatRequest({ ...body, model: requestedModel }) as unknown as ChatRequest;

    const response = await router.routeChatCompletion(chatReq, {
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

    if (response.status >= 400) {
      const errJson = await response.json().catch(() => ({}));
      const errMsg =
        errJson?.error?.message ||
        (typeof errJson?.error === 'string' ? errJson.error : null) ||
        `Upstream returned status ${response.status}`;
      const errType =
        response.status === 429
          ? 'rate_limit_error'
          : response.status === 401
            ? 'authentication_error'
            : response.status === 403
              ? 'permission_error'
              : response.status >= 500
                ? 'api_error'
                : 'invalid_request_error';
      return anthropicErrorResponse(response.status, errType, errMsg, traceHeaders);
    }

    const contentType = response.headers.get('content-type') || '';
    if (chatReq.stream && response.body && contentType.includes('text/event-stream')) {
      const anthropicStream = transformOpenAiSseToAnthropicSse(response.body, requestedModel);
      return new Response(anthropicStream, {
        status: response.status,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          ...traceHeaders,
        },
      });
    }

    const openAiJson = await response.json();
    const anthropicMessage = openAiToAnthropicMessageResponse(openAiJson, requestedModel);
    return NextResponse.json(anthropicMessage, {
      status: response.status,
      headers: traceHeaders,
    });
  } catch (error) {
    const err = error as Error & { statusCode?: number };
    const msg = err.message || 'Internal server error';
    if (typeof err.statusCode === 'number') {
      return anthropicErrorResponse(
        err.statusCode,
        err.statusCode === 429 ? 'rate_limit_error' : 'invalid_request_error',
        msg
      );
    }
    const kind = classifyChatError(err);
    if (kind === 'no-upstream') {
      return anthropicErrorResponse(404, 'not_found_error', msg);
    }
    if (kind === 'all-upstreams-failed') {
      return anthropicErrorResponse(502, 'api_error', msg);
    }
    if (kind === 'timeout') {
      return anthropicErrorResponse(504, 'overloaded_error', msg);
    }
    return anthropicErrorResponse(500, 'api_error', msg);
  }
}
