import { NextResponse } from 'next/server';
import { getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/route-explain
 *
 * Decision tracing for the live router: explains how a chat request
 * WOULD be routed (selection stages, ranked failover order, chosen
 * upstream) without contacting any upstream. Body mirrors a chat
 * completion request: { model?, messages, tools? }.
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json({ error: `Malformed JSON: ${err.message}` }, { status: 400 });
  }

  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      { error: 'A non-empty "messages" array is required to explain a route.' },
      { status: 400 }
    );
  }

  try {
    const explanation = getRouter().explainRoute({
      model: body.model || 'auto',
      messages: body.messages,
      tools: body.tools,
      stream: false
    });
    return NextResponse.json(explanation);
  } catch (error) {
    const err = error as Error;
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
