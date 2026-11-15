import { NextResponse } from 'next/server';
import {
  classifyPaperclipTask,
  evaluatePaperclipCandidateAssignments,
  recordPaperclipIssueClassification,
  type PaperclipCandidateAgent,
} from '@eluvix/router-core';
import {
  assertPaperclipCompanyScope,
  buildPaperclipFleetSummary,
  requirePaperclipCaller,
} from '@/lib/paperclip-route-helpers';
import { getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await requirePaperclipCaller(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || !body.task || !Array.isArray(body.candidates)) {
    return NextResponse.json(
      {
        error: {
          message: 'Body must include "task" and "candidates" array.',
          type: 'invalid_request_error',
        },
      },
      { status: 400 }
    );
  }

  const task = {
    issueId: typeof body.task.issueId === 'string' ? body.task.issueId : undefined,
    title: String(body.task.title || ''),
    description: typeof body.task.description === 'string' ? body.task.description : undefined,
    priority: body.task.priority,
    labels: Array.isArray(body.task.labels) ? body.task.labels.map(String) : undefined,
    sensitivity: body.task.sensitivity,
    parentAssigneeAgentId:
      typeof body.task.parentAssigneeAgentId === 'string'
        ? body.task.parentAssigneeAgentId
        : undefined,
  };

  const classification = classifyPaperclipTask(task);
  const companyId =
    typeof body.companyId === 'string'
      ? body.companyId
      : typeof body.task.companyId === 'string'
      ? body.task.companyId
      : undefined;
  const companyErr = assertPaperclipCompanyScope(auth.identity, companyId);
  if (companyErr) return companyErr;

  if (task.issueId) {
    recordPaperclipIssueClassification({
      issueId: task.issueId,
      userId: auth.identity.userId,
      companyId,
      taskClass: classification.taskClass,
      title: task.title,
      priority: typeof task.priority === 'string' ? task.priority : undefined,
    });
  }
  const fleet = buildPaperclipFleetSummary();
  const candidates = body.candidates as PaperclipCandidateAgent[];
  const topN = typeof body.topN === 'number' && body.topN > 0 ? Math.min(20, body.topN) : undefined;
  const result = await evaluatePaperclipCandidateAssignments({
    router: getRouter(),
    task,
    candidates,
    fleet,
    userId: auth.identity.userId,
    companyIds: auth.identity.paperclip?.companyIds,
    weights: body.weights,
    topN: topN ?? Math.max(5, candidates.length || 5),
    explore: Boolean(body.explore),
    exploreSeed: typeof body.exploreSeed === 'number' ? body.exploreSeed : undefined,
    useEmbeddings: typeof body.useEmbeddings === 'boolean' ? body.useEmbeddings : undefined,
  });

  return NextResponse.json(result);
}
