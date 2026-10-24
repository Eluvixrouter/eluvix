import { NextResponse } from 'next/server';
import { resolveBearerToken, type RequestScope } from '@eluvix/router-core';
import { getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/route-explain
 *
 * Decision tracing for the live router: explains how a chat request
 * WOULD be routed (selection stages, ranked failover order, chosen
 * upstream) without contacting any upstream. Body mirrors a chat
 * completion request: { model?, messages, tools?, scope?, hops?, memoryTainted? }.
 */
export async function POST(req: Request) {
  let keyUserId: string | undefined;
  let keyOrigin: RequestScope['origin'] | undefined;
  const authHeader = req?.headers?.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('elx_')) {
      const resolved = resolveBearerToken(token);
      if (!resolved.valid) {
        return NextResponse.json(
          { error: 'Incorrect API key provided.' },
          { status: 401 }
        );
      }
      keyUserId = resolved.userId;
      keyOrigin = resolved.origin;
    }
  }

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
    const headerOrigin = req?.headers?.get('x-eluvix-origin');
    const origin: RequestScope['origin'] =
      keyOrigin ||
      body.scope?.origin ||
      body.origin ||
      (headerOrigin === 'harness' || headerOrigin === 'playground' ? headerOrigin : 'client');
    const scope: Partial<RequestScope> = {
      userId:
        keyUserId ||
        body.scope?.userId ||
        req?.headers?.get('x-eluvix-user') ||
        (typeof body.user === 'string' && body.user.trim() ? body.user.trim() : 'default'),
      sessionId: body.scope?.sessionId || req?.headers?.get('x-eluvix-session') || undefined,
      origin
    };
    const hops = Math.max(
      0,
      Number.isFinite(Number(body.hops))
        ? Number(body.hops)
        : parseInt(req?.headers?.get('x-eluvix-hops') || '0', 10) || 0
    );

    const explanation = getRouter().explainRoute(
      {
        model: body.model || 'auto',
        messages: body.messages,
        tools: body.tools,
        stream: false
      },
      {
        scope,
        hops,
        memoryTainted: Boolean(body.memoryTainted)
      }
    );
    return NextResponse.json(explanation);
  } catch (error) {
    const err = error as Error;
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
