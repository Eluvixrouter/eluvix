import { NextResponse } from 'next/server';
import { resolveAndRecordPaperclipFeedback } from '@eluvix/router-core';
import { assertPaperclipCompanyScope, requirePaperclipCaller } from '@/lib/paperclip-route-helpers';

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

  const companyId =
    typeof body.companyId === 'string'
      ? body.companyId
      : typeof body.task?.companyId === 'string'
      ? body.task.companyId
      : undefined;
  const companyErr = assertPaperclipCompanyScope(auth.identity, companyId);
  if (companyErr) return companyErr;

  const result = resolveAndRecordPaperclipFeedback({
    userId: auth.identity.userId,
    companyId,
    allowedCompanyIds: auth.identity.paperclip?.companyIds,
    issueId: body.issueId,
    agentId: body.agentId,
    runId: typeof body.runId === 'string' ? body.runId : undefined,
    task: body.task && typeof body.task === 'object' ? body.task : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
    description: typeof body.description === 'string' ? body.description : undefined,
    priority: body.priority,
    labels: Array.isArray(body.labels) ? body.labels.map(String) : undefined,
    sensitivity: body.sensitivity,
    taskClass: typeof body.taskClass === 'string' ? body.taskClass : undefined,
    success: Boolean(body.success),
    reopened: Boolean(body.reopened),
    outcomeStatus: typeof body.outcomeStatus === 'string' ? body.outcomeStatus : undefined,
    costUsd: typeof body.costUsd === 'number' ? body.costUsd : undefined,
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : undefined,
  });

  return NextResponse.json(result);
}
