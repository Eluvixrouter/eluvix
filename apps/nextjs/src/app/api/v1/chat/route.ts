import { NextResponse } from 'next/server';
import { saveChatMessage } from '@eluvix/router-core';
import { getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { session_id, ...forwardBody } = body;
    
    // Route in-process via Eluvix core router
    const router = getRouter();
    const res = await router.routeChatCompletion(forwardBody);

    const data = await res.json();
    
    // Extract our custom trace headers
    const upstream = res.headers.get('x-eluvix-upstream') || 'unknown';
    const complexity = res.headers.get('x-eluvix-complexity') || '0';
    const tokens = res.headers.get('x-eluvix-tokens') || '0';

    if (!res.ok) {
      return NextResponse.json({
        success: false,
        error: data?.error?.message || 'Request failed',
        data,
        trace: {
          upstream,
          complexity,
          tokens,
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
        status: res.status
      }
    });

  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
