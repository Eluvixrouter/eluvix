import { NextResponse } from 'next/server';
import {
  classifyPaperclipTask,
  recordPaperclipIssueClassification,
} from '@eluvix/router-core';
import { assertPaperclipCompanyScope, requirePaperclipCaller } from '@/lib/paperclip-route-helpers';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await requirePaperclipCaller(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || typeof body.title !== 'string') {
    return NextResponse.json(
      { error: { message: 'Missing required "title" string.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }

  const issueId = typeof body.issueId === 'string' ? body.issueId : undefined;
  const companyId = typeof body.companyId === 'string' ? body.companyId : undefined;
  const companyErr = assertPaperclipCompanyScope(auth.identity, companyId);
  if (companyErr) return companyErr;
  const classification = classifyPaperclipTask({
    issueId,
    title: body.title,
    description: typeof body.description === 'string' ? body.description : undefined,
    priority: body.priority,
    labels: Array.isArray(body.labels) ? body.labels.map(String) : undefined,
    sensitivity: body.sensitivity,
  });

  if (issueId) {
    recordPaperclipIssueClassification({
      issueId,
      userId: auth.identity.userId,
      companyId,
      taskClass: classification.taskClass,
      title: body.title,
      priority: typeof body.priority === 'string' ? body.priority : undefined,
    });
  }

  return NextResponse.json(classification);
}
