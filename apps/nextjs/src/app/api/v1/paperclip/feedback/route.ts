import { NextResponse } from 'next/server';
import { recordPaperclipAssignmentOutcome } from '@eluvix/router-core';
import { requirePaperclipCaller } from '@/lib/paperclip-route-helpers';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await requirePaperclipCaller(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.issueId !== 'string' ||
    typeof body.agentId !== 'string'
  ) {
    return NextResponse.json(
      {
        error: {
          message: 'Missing required "issueId" and "agentId" strings.',
          type: 'invalid_request_error',
        },
      },
      { status: 400 }
    );
  }

  recordPaperclipAssignmentOutcome({
    userId: auth.identity.userId,
    issueId: body.issueId,
    agentId: body.agentId,
    taskClass: typeof body.taskClass === 'string' ? body.taskClass : 'text:moderate',
    success: Boolean(body.success),
    costUsd: typeof body.costUsd === 'number' ? body.costUsd : 0,
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : 0,
  });

  return NextResponse.json({ ok: true });
}
