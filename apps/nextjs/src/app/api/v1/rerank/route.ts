import { NextResponse } from 'next/server';
import { resolveCallerIdentity } from '@/lib/caller-identity';
import { getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'rerank' });
  if (!caller.ok) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', type: 'authentication_error', code: caller.reason } },
      { status: caller.reason === 'insufficient-scope' ? 403 : 401 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { message: 'Invalid JSON body.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }

  const router = getRouter();
  return router.routeRerank(body, {
    userId: caller.userId,
    signal: req.signal,
  });
}
