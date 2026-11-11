import { NextResponse } from 'next/server';
import {
  resolveBearerToken,
  responsesInputToChatRequest,
  openAiChatToResponsesObject,
  transformOpenAiSseToResponsesSse,
  getStoredResponse,
  saveStoredResponse,
  type ChatRequest,
  type RequestScope,
} from '@eluvix/router-core';
import { getRouter, getProviderAgent } from '@/lib/router';
import { resolveSessionUserId, extractApiTokenFromHeaders } from '@/lib/caller-identity';
import { classifyChatError } from '@/lib/chat-error';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/responses (also reachable via /v1/responses rewrite)
 *
 * OpenAI Responses API stateful gateway supporting `previous_response_id`
 * multi-turn SQLite conversation chains (strictly partitioned by `userId`),
 * `store: false` zero-retention mode, `instructions`, `reasoning.effort`,
 * function tools, and `response.created` / `response.output_text.delta` /
 * `response.completed` SSE streams.
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
      getProviderAgent().notifyConsumerActive(30000);
    } catch {
      // Ignore if provider agent isn't running
    }

    const router = getRouter();
    const sessionUserId = keyUserId ? null : await resolveSessionUserId(req);
    const effectiveUserId = keyUserId || sessionUserId || 'default';
    const headerOrigin = req.headers.get('x-eluvix-origin');
    const origin: RequestScope['origin'] =
      keyOrigin ||
      (headerOrigin === 'harness' || headerOrigin === 'playground' ? headerOrigin : 'client');
    const scope: Partial<RequestScope> = {
      userId: effectiveUserId,
      sessionId: req.headers.get('x-eluvix-session') || undefined,
      origin,
    };
    const hops = Math.max(0, parseInt(req.headers.get('x-eluvix-hops') || '0', 10) || 0);

    let priorMessages: Array<Record<string, any>> = [];
    const previousResponseId =
      typeof body.previous_response_id === 'string' && body.previous_response_id.trim()
        ? body.previous_response_id.trim()
        : null;

    if (previousResponseId) {
      const priorRecord = getStoredResponse(previousResponseId, effectiveUserId);
      if (!priorRecord) {
        return NextResponse.json(
          {
            error: {
              message: `Previous response '${previousResponseId}' not found for caller.`,
              type: 'invalid_request_error',
              param: 'previous_response_id',
              code: 'previous_response_not_found',
            },
          },
          { status: 404 }
        );
      }
      priorMessages = Array.isArray(priorRecord.messages) ? priorRecord.messages : [];
    }

    const { chatRequest } = responsesInputToChatRequest(body as any, priorMessages);
    const chatReq = chatRequest as unknown as ChatRequest;
    const shouldStore = body.store !== false;

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
      const errData = await response.json().catch(() => ({
        error: { message: `Upstream error (${response.status})`, type: 'api_error' },
      }));
      return NextResponse.json(errData, { status: response.status, headers: traceHeaders });
    }

    const servedModel =
      response.headers.get('x-eluvix-model') || chatReq.model || body.model || 'eluvix-default';
    const contentType = response.headers.get('content-type') || '';

    if (chatReq.stream && response.body && contentType.includes('text/event-stream')) {
      const responsesStream = transformOpenAiSseToResponsesSse({
        openAiStream: response.body,
        requestedModel: servedModel,
        previousResponseId,
        store: shouldStore,
        onCompleted: ({ responseObject, assistantMessage }) => {
          if (!shouldStore) return;
          saveStoredResponse({
            id: responseObject.id,
            userId: effectiveUserId,
            previousResponseId,
            model: servedModel,
            messages: [...chatRequest.messages, assistantMessage],
            response: responseObject,
          });
        },
      });

      return new Response(responsesStream, {
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
    const { responseObject, assistantMessage } = openAiChatToResponsesObject({
      chatJson: openAiJson,
      requestedModel: servedModel,
      previousResponseId,
      store: shouldStore,
    });

    if (shouldStore) {
      saveStoredResponse({
        id: responseObject.id,
        userId: effectiveUserId,
        previousResponseId,
        model: servedModel,
        messages: [...chatRequest.messages, assistantMessage],
        response: responseObject,
      });
    }

    return NextResponse.json(responseObject, {
      status: response.status,
      headers: traceHeaders,
    });
  } catch (error) {
    const err = error as Error & { statusCode?: number };
    const msg = err.message || 'Internal server error';
    if (typeof err.statusCode === 'number') {
      return NextResponse.json(
        { error: { message: msg, type: 'invalid_request_error' } },
        { status: err.statusCode }
      );
    }
    const kind = classifyChatError(err);
    const status =
      kind === 'no-upstream'
        ? 404
        : kind === 'all-upstreams-failed'
          ? 502
          : kind === 'timeout'
            ? 504
            : 500;
    return NextResponse.json(
      { error: { message: msg, type: kind === 'no-upstream' ? 'invalid_request_error' : 'server_error' } },
      { status }
    );
  }
}
