import { NextResponse } from 'next/server';
import { getRouter, getProviderAgent } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    
    // Prioritize consumer activity: pause background GPU provider jobs
    try {
      getProviderAgent().notifyConsumerActive(30000);
    } catch {
      // Ignore if provider agent isn't running
    }

    const router = getRouter();
    
    // Use the core routing logic
    const response = await router.routeChatCompletion(body);

    const contentType = response.headers.get('content-type') || '';
    const upstreamHeader = response.headers.get('x-eluvix-upstream') || '';
    const complexityHeader = response.headers.get('x-eluvix-complexity') || '';
    const tokensHeader = response.headers.get('x-eluvix-tokens') || '';
    const modelHeader = response.headers.get('x-eluvix-model') || '';

    const traceHeaders: Record<string, string> = {};
    if (upstreamHeader) traceHeaders['x-eluvix-upstream'] = upstreamHeader;
    if (complexityHeader) traceHeaders['x-eluvix-complexity'] = complexityHeader;
    if (tokensHeader) traceHeaders['x-eluvix-tokens'] = tokensHeader;
    if (modelHeader) traceHeaders['x-eluvix-model'] = modelHeader;

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
      const content = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text ?? '';
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

          // Chunk 3: Finish reason
          const chunkStop = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop'
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
    return NextResponse.json(
      {
        error: {
          message: err.message || 'Internal server error',
          type: 'server_error',
          param: null,
          code: null
        }
      },
      { status: 500 }
    );
  }
}
