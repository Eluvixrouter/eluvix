import { NextResponse } from 'next/server';
import {
  classifyPaperclipTask,
  getPaperclipOutcomePriors,
  recommendPaperclipAssignees,
  type PaperclipCandidateAgent,
} from '@eluvix/router-core';
import {
  buildPaperclipFleetSummary,
  requirePaperclipCaller,
} from '@/lib/paperclip-route-helpers';

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
  };

  const classification = classifyPaperclipTask(task);
  const priors = getPaperclipOutcomePriors(classification.taskClass, auth.identity.userId);
  const fleet = buildPaperclipFleetSummary();
  const candidates = body.candidates as PaperclipCandidateAgent[];
  const result = recommendPaperclipAssignees(task, candidates, fleet, body.weights, priors);

  const topN = typeof body.topN === 'number' && body.topN > 0 ? Math.min(20, body.topN) : undefined;
  return NextResponse.json({
    ...result,
    recommendations: topN ? result.recommendations.slice(0, topN) : result.recommendations,
  });
}
