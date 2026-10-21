import { NextResponse } from 'next/server';
import { saveChatMessage } from '@eluvix/router-core';
import { getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON request body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json({ success: false, error: "Missing required parameter: 'messages' must be a non-empty array" }, { status: 400 });
  }

  try {
    const { session_id, ...forwardBody } = body;
    
    // Route in-process via Eluvix core router
    const router = getRouter();
    const res = await router.routeChatCompletion(forwardBody, {
      scope: {
        sessionId: typeof session_id === 'string' ? session_id : undefined,
        origin: 'playground'
      }
    });

    let data: any;
    try {
      data = await res.json();
    } catch {
      const text = await res.text().catch(() => '');
      data = { error: { message: text || 'Request failed' } };
    }
    
    // Extract our custom trace headers
    const upstream = res.headers.get('x-eluvix-upstream') || 'unknown';
    const complexity = res.headers.get('x-eluvix-complexity') || '0';
    const tokens = res.headers.get('x-eluvix-tokens') || '0';
    const memory = res.headers.get('x-eluvix-memory') || undefined;
    const memoryTokens = res.headers.get('x-eluvix-memory-tokens') || undefined;
    const harness = res.headers.get('x-eluvix-harness') || undefined;

    if (!res.ok) {
      return NextResponse.json({
        success: false,
        error: data?.error?.message || 'Request failed',
        data,
        trace: {
          upstream,
          complexity,
          tokens,
          memory,
          memoryTokens,
          harness,
          status: res.status
        }
      }, { status: res.status });
    }

    if (session_id && forwardBody.messages) {
      // Save user message (last one sent) only after successful validation & completion
      const userMsg = forwardBody.messages[forwardBody.messages.length - 1];
      if (userMsg) saveChatMessage(session_id, userMsg.role, userMsg.content);
      
      // Save assistant message
      const assistantMsg = data.choices?.[0]?.message;
      if (assistantMsg) saveChatMessage(session_id, assistantMsg.role, assistantMsg.content);
    }

    return NextResponse.json({
      success: true,
      data,
      trace: {
        upstream,
        complexity,
        tokens,
        memory,
        memoryTokens,
        harness,
        status: res.status
      }
    });

  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
