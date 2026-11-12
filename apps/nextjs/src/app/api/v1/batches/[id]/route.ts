import { NextResponse } from 'next/server';
import { getBatchJob, cancelBatchJob } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  context: { params: { id: string } | Promise<{ id: string }> }
) {
  const caller = await resolveCallerIdentity(req, { requiredScope: 'batches' });
  if (!caller.ok) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', type: 'authentication_error', code: caller.reason } },
      { status: caller.reason === 'insufficient-scope' ? 403 : 401 }
    );
  }
  const resolvedParams = await Promise.resolve(context.params);
  const job = getBatchJob(resolvedParams.id, caller.userId);
  if (!job) {
    return NextResponse.json(
      { error: { message: `Batch "${resolvedParams.id}" not found.`, type: 'not_found_error' } },
      { status: 404 }
    );
  }
  return NextResponse.json(job);
}

export async function POST(
  req: Request,
  context: { params: { id: string } | Promise<{ id: string }> }
) {
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
  const resolvedParams = await Promise.resolve(context.params);
  const cancelled = cancelBatchJob(resolvedParams.id, caller.userId);
  if (!cancelled) {
    return NextResponse.json(
      { error: { message: `Batch "${resolvedParams.id}" not found.`, type: 'not_found_error' } },
      { status: 404 }
    );
  }
  return NextResponse.json(cancelled);
}
