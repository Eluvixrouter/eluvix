import { NextResponse } from 'next/server';
import { getBatchFileContent } from '@eluvix/router-core';
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
  const content = getBatchFileContent(resolvedParams.id, caller.userId);
  if (content === null) {
    return NextResponse.json(
      { error: { message: `File "${resolvedParams.id}" not found.`, type: 'not_found_error' } },
      { status: 404 }
    );
  }
  return new Response(content, {
    status: 200,
    headers: { 'Content-Type': 'application/jsonl; charset=utf-8' },
  });
}
