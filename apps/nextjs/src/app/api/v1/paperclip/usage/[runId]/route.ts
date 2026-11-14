import { NextResponse } from 'next/server';
import { getPaperclipUsageByCorrelation } from '@eluvix/router-core';
import { requirePaperclipCaller } from '@/lib/paperclip-route-helpers';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  context: { params: Promise<{ runId: string }> }
) {
  const auth = await requirePaperclipCaller(req);
  if (!auth.ok) return auth.response;

  const resolvedParams = await context.params;
  const runId = decodeURIComponent(resolvedParams?.runId || '').trim();
  if (!runId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(runId)) {
    return NextResponse.json(
      { error: { message: 'Invalid runId parameter.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }

  const summary = getPaperclipUsageByCorrelation(runId, auth.identity.userId);
  return NextResponse.json(summary);
}
