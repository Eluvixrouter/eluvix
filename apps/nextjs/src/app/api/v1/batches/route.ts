import { NextResponse } from 'next/server';
import { createBatchJob, executeBatchJob, listBatchJobs } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';
import { getRouter } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'batches' });
  if (!caller.ok) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', type: 'authentication_error', code: caller.reason } },
      { status: caller.reason === 'insufficient-scope' ? 403 : 401 }
    );
  }
  const jobs = listBatchJobs(caller.userId);
  return NextResponse.json({ object: 'list', data: jobs });
}

export async function POST(req: Request) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'batches' });
  if (!caller.ok) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', type: 'authentication_error', code: caller.reason } },
      { status: caller.reason === 'insufficient-scope' ? 403 : 401 }
    );
  }
  if (caller.role === 'readonly') {
    return NextResponse.json(
      { error: { message: 'Forbidden: read-only user.', type: 'insufficient_role' } },
      { status: 403 }
    );
  }

  const body = await req.json().catch(() => ({}));
  if (!body?.input_file_id || typeof body.input_file_id !== 'string') {
    return NextResponse.json(
      { error: { message: 'Missing required parameter: "input_file_id".', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }

  try {
    const job = createBatchJob({
      input_file_id: body.input_file_id,
      endpoint: body.endpoint,
      completion_window: body.completion_window,
      metadata: body.metadata,
      userId: caller.userId,
    });

    if (job.status === 'in_progress') {
      const router = getRouter();
      if (body.await_completion === true) {
        const completed = await executeBatchJob(job.id, router, { userId: caller.userId });
        return NextResponse.json(completed || job, { status: 200 });
      }
      queueMicrotask(() => {
        void executeBatchJob(job.id, router, { userId: caller.userId }).catch(() => {});
      });
    }

    return NextResponse.json(job, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { error: { message: err?.message || 'Failed to create batch job.', type: 'invalid_request_error' } },
      { status: 400 }
    );
  }
}
