import { NextResponse } from 'next/server';
import { resolveBearerToken, type RequestScope } from '@eluvix/router-core';
import { getRouter, getProviderAgent } from '@/lib/router';
import { resolveSessionIdentity, extractApiTokenFromHeaders } from '@/lib/caller-identity';
import { classifyChatError } from '@/lib/chat-error';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Verify named elx_ API key if used (Authorization: Bearer or x-api-key)
  let keyUserId: string | undefined;
  let keyOrigin: RequestScope['origin'] | undefined;
  const rawToken = extractApiTokenFromHeaders(req);
  if (rawToken && rawToken.startsWith('elx_')) {
    const resolved = resolveBearerToken(rawToken, undefined, 'eluvix', { requiredScope: 'chat' });
    if (!resolved.valid) {
      const status =
        resolved.reason === 'insufficient-scope'
          ? 403
          : resolved.reason === 'rate-limited' || resolved.reason === 'budget-exceeded'
          ? 429
          : 401;
      return NextResponse.json(
        {
          error: {
            message:
              resolved.reason === 'insufficient-scope'
                ? 'API key lacks required "chat" scope.'
                : resolved.reason === 'expired'
                ? 'API key has expired.'
                : resolved.reason === 'rate-limited'
                ? 'API key rate limit (RPM) exceeded.'
                : resolved.reason === 'budget-exceeded'
                ? 'API key daily spend budget exceeded.'
                : 'Incorrect API key provided.',
            type: 'invalid_request_error',
            code: resolved.reason || 'invalid_api_key'
          }
        },
        { status }
      );
    }
    // Readonly named keys may not execute completions (quota spend,
    // harness triggers, memory write-back). Session readonly callers are
    // blocked by the middleware blocklist; this is the key path.
    if (resolved.role === 'readonly') {
      return NextResponse.json(
        {
          error: {
            message: 'Forbidden: read-only users cannot execute chat requests.',
            type: 'insufficient_role',
            code: 'forbidden_readonly_user'
          }
        },
        { status: 403 }
      );
    }
    keyUserId = resolved.userId;
    keyOrigin = resolved.origin;
  }

  let body: any;
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json(
      {
        error: {
          message: `Invalid JSON in request body: ${err.message}`,
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_json'
        }
      },
      { status: 400 }
    );
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      {
        error: {
          message: 'Request body must be a valid JSON object.',
          type: 'invalid_request_error',
          param: null,
          code: 'invalid_request'
        }
      },
      { status: 400 }
    );
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      {
        error: {
          message: "Missing required parameter: 'messages' must be a non-empty array.",
          type: 'invalid_request_error',
          param: 'messages',
          code: 'missing_required_parameter'
        }
      },
      { status: 400 }
    );
  }

  try {
    // Prioritize consumer activity: pause background GPU provider jobs
    try {
      getProviderAgent().notifyConsumerActive(30000);
    } catch {
      // Ignore if provider agent isn't running
    }

    const router = getRouter();
    // Identity comes only from credentials the caller actually proved:
    // a named elx_ key's bound userId, or the browser session (the
    // admin's 'default' store). The x-eluvix-user header and body.user
    // are self-asserted and are deliberately NOT consulted (audit H-2):
    // keyless, sessionless callers that reach this route passed the
    // middleware with the admin bearer, so they belong to 'default'.
    const sessionIdentity = keyUserId ? null : await resolveSessionIdentity(req);
    // Session readonly callers are blocked by the middleware blocklist;
    // this is the same check in-handler so the route is safe on its own.
    if (sessionIdentity?.role === 'readonly') {
      return NextResponse.json(
        {
          error: {
            message: 'Forbidden: read-only users cannot execute chat requests.',
            type: 'insufficient_role',
            code: 'forbidden_readonly_user'
          }
        },
        { status: 403 }
      );
    }
    const sessionUserId = sessionIdentity?.userId ?? null;
    const headerOrigin = req.headers.get('x-eluvix-origin');
    const origin: RequestScope['origin'] =
      keyOrigin ||
      (headerOrigin === 'harness' || headerOrigin === 'playground' ? headerOrigin : 'client');
    const scope: Partial<RequestScope> = {
      userId: keyUserId || sessionUserId || 'default',
      sessionId:
        req.headers.get('x-eluvix-session') ||
        (typeof body.metadata?.sessionId === 'string' ? body.metadata.sessionId : undefined),
      origin
    };
    const hops = Math.max(0, parseInt(req.headers.get('x-eluvix-hops') || '0', 10) || 0);
    const headerPromptRef = req.headers.get('x-eluvix-prompt');
    if (headerPromptRef && headerPromptRef.trim()) {
      body.metadata = {
        ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
        promptRef: body.metadata?.promptRef || headerPromptRef.trim(),
      };
    }

    const VALID_CONFIDENTIAL = new Set(['disabled', 'prefer-tee', 'require-tee', 'require-dual-attestation']);
    const VALID_QUANT = new Set(['disabled', 'prefer-nvfp4-hadamard', 'lossless-reasoning']);
    const VALID_FABRIC = new Set(['disabled', 'prefer-rail-optimized', 'require-collision-free-fabric']);
    const VALID_CRS = new Set(['disabled', 'slice-and-verify', 'strict-zero-false-positive']);
    const VALID_ATTENTION = new Set([
      'disabled',
      'prefer-fa3-warp-specialized',
      'prefer-blackwell-tmem',
      'require-fp8-ping-pong'
    ]);

    if (body.metadata && typeof body.metadata === 'object') {
      if (body.metadata.confidentialPolicy && !VALID_CONFIDENTIAL.has(String(body.metadata.confidentialPolicy))) {
        delete body.metadata.confidentialPolicy;
      }
      if (body.metadata.quantizationPolicy && !VALID_QUANT.has(String(body.metadata.quantizationPolicy))) {
        delete body.metadata.quantizationPolicy;
      }
      if (body.metadata.fabricPolicy && !VALID_FABRIC.has(String(body.metadata.fabricPolicy))) {
        delete body.metadata.fabricPolicy;
      }
      if (body.metadata.crsPolicy && !VALID_CRS.has(String(body.metadata.crsPolicy))) {
        delete body.metadata.crsPolicy;
      }
      if (body.metadata.attentionPolicy && !VALID_ATTENTION.has(String(body.metadata.attentionPolicy))) {
        delete body.metadata.attentionPolicy;
      }
    }

    const confidentialHeader = req.headers.get('x-eluvix-confidential');
    if (confidentialHeader && VALID_CONFIDENTIAL.has(confidentialHeader)) {
      body.metadata = {
        ...(body.metadata || {}),
        confidentialPolicy: confidentialHeader
      };
    }
    const quantHeader = req.headers.get('x-eluvix-quantization');
    if (quantHeader && VALID_QUANT.has(quantHeader)) {
      body.metadata = {
        ...(body.metadata || {}),
        quantizationPolicy: quantHeader
      };
    }
    const fabricHeader = req.headers.get('x-eluvix-fabric');
    if (fabricHeader && VALID_FABRIC.has(fabricHeader)) {
      body.metadata = {
        ...(body.metadata || {}),
        fabricPolicy: fabricHeader
      };
    }
    const crsHeader = req.headers.get('x-eluvix-crs');
    if (crsHeader && VALID_CRS.has(crsHeader)) {
      body.metadata = {
        ...(body.metadata || {}),
        crsPolicy: crsHeader
      };
    }
    const attentionHeader = req.headers.get('x-eluvix-attention');
    if (attentionHeader && VALID_ATTENTION.has(attentionHeader)) {
      body.metadata = {
        ...(body.metadata || {}),
        attentionPolicy: attentionHeader
      };
    }

    // Use the core routing logic
    const response = await router.routeChatCompletion(body, {
      signal: req.signal,
      scope,
      hops
    });

    const contentType = response.headers.get('content-type') || '';
    const traceHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if ((lower.startsWith('x-eluvix-') || lower === 'retry-after') && value) {
        traceHeaders[lower] = value;
      }
    });

    // If upstream or guard returned an error status, return JSON error with exact status
    if (!response.ok) {
      let errorBody: any;
      try {
        errorBody = await response.json();
      } catch {
        const text = await response.text().catch(() => 'Upstream request failed');
        errorBody = {
          error: {
            message: text || 'Upstream request failed',
            type: 'upstream_error',
            param: null,
            code: null
          }
        };
      }
      return NextResponse.json(errorBody, {
        status: response.status,
        headers: traceHeaders
      });
    }

    // Handle streaming request
    if (body.stream) {
      // If upstream already returns SSE stream, pipe it through directly
      if (contentType.includes('text/event-stream') && response.body) {
        return new Response(response.body, {
          status: response.status,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            ...traceHeaders
          }
        });
      }

      // If upstream returned JSON, synthesize standard OpenAI SSE chunks
      const json = await response.json();
      const message = json.choices?.[0]?.message || {};
      const content = message.content ?? json.choices?.[0]?.text ?? '';
      const toolCalls = message.tool_calls;
      const finishReason = json.choices?.[0]?.finish_reason || (toolCalls ? 'tool_calls' : 'stop');
      const model = json.model || body.model || 'auto';
      const id = json.id || `chatcmpl-${Date.now()}`;
      const created = json.created || Math.floor(Date.now() / 1000);

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // Chunk 1: Role initialization
          const chunkRole = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: { role: 'assistant', content: '' },
              finish_reason: null
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkRole)}\n\n`));

          // Chunk 2: Content payload
          if (content) {
            const chunkContent = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{
                index: 0,
                delta: { content },
                finish_reason: null
              }]
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkContent)}\n\n`));
          }

          // Chunk 2b: Tool calls payload
          if (toolCalls) {
            const chunkTools = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{
                index: 0,
                delta: { tool_calls: toolCalls },
                finish_reason: null
              }]
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkTools)}\n\n`));
          }

          // Chunk 3: Finish reason
          const chunkStop = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: finishReason
            }]
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkStop)}\n\n`));

          // Termination marker
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      });

      return new Response(stream, {
        status: response.status,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          ...traceHeaders
        }
      });
    }

    const data = await response.json();
    return NextResponse.json(data, {
      status: response.status,
      headers: traceHeaders
    });
  } catch (error) {
    const err = error as Error;
    const msg = err.message || 'Internal server error';
    const kind = classifyChatError(err);

    if (kind === 'no-upstream') {
      const isVision = msg.includes('with vision capability');
      return NextResponse.json(
        {
          error: {
            message: msg,
            type: 'invalid_request_error',
            param: isVision ? 'messages' : 'model',
            code: isVision ? 'vision_not_supported' : 'model_not_found'
          }
        },
        { status: isVision ? 400 : 404 }
      );
    }

    if (kind === 'all-upstreams-failed') {
      return NextResponse.json(
        {
          error: {
            message: msg,
            type: 'upstream_error',
            param: null,
            code: 'bad_gateway'
          }
        },
        { status: 502 }
      );
    }

    if (kind === 'client-aborted') {
      return NextResponse.json(
        {
          error: {
            message: 'Client aborted request.',
            type: 'client_closed_request',
            param: null,
            code: 'request_cancelled'
          }
        },
        { status: 499 }
      );
    }

    if (kind === 'timeout') {
      return NextResponse.json(
        {
          error: {
            message: msg,
            type: 'timeout_error',
            param: null,
            code: 'gateway_timeout'
          }
        },
        { status: 504 }
      );
    }

    return NextResponse.json(
      {
        error: {
          message: msg,
          type: 'server_error',
          param: null,
          code: null
        }
      },
      { status: 500 }
    );
  }
}
