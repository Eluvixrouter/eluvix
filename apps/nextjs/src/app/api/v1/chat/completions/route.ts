import { NextResponse } from 'next/server';
import { getRouter, getProviderAgent } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
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
    
    // Use the core routing logic
    const response = await router.routeChatCompletion(body, { signal: req.signal });

    const contentType = response.headers.get('content-type') || '';
    const upstreamHeader = response.headers.get('x-eluvix-upstream') || '';
    const complexityHeader = response.headers.get('x-eluvix-complexity') || '';
    const tokensHeader = response.headers.get('x-eluvix-tokens') || '';
    const modelHeader = response.headers.get('x-eluvix-model') || '';
    const effortHeader = response.headers.get('x-eluvix-effort') || '';

    const traceHeaders: Record<string, string> = {};
    if (upstreamHeader) traceHeaders['x-eluvix-upstream'] = upstreamHeader;
    if (complexityHeader) traceHeaders['x-eluvix-complexity'] = complexityHeader;
    if (tokensHeader) traceHeaders['x-eluvix-tokens'] = tokensHeader;
    if (modelHeader) traceHeaders['x-eluvix-model'] = modelHeader;
    if (effortHeader) traceHeaders['x-eluvix-effort'] = effortHeader;

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

    if (msg.startsWith('No upstream available for model:')) {
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

    if (msg === 'All upstreams failed to process the request.') {
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

    if (err.name === 'AbortError' || msg.includes('Client aborted') || msg.includes('client_closed_request')) {
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

    if (err.name === 'TimeoutError' || msg.includes('timed out')) {
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
