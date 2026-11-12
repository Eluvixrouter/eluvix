import { NextResponse } from 'next/server';
import { listAuditEvents, verifyAuditChain } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const caller = await resolveCallerIdentity(req);
  if (!caller.ok) {
    return NextResponse.json(
      {
        error: {
          message: caller.reason === 'insufficient-scope' ? 'Forbidden scope.' : 'Unauthorized.',
          type: 'authentication_error',
          code: caller.reason,
        },
      },
      { status: caller.reason === 'insufficient-scope' ? 403 : 401 }
    );
  }

  const url = new URL(req.url);
  const verify = url.searchParams.get('verify') === '1' || url.searchParams.get('verify') === 'true';
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
  const action = url.searchParams.get('action') || undefined;

  const events = listAuditEvents({
    limit,
    action,
    actorId: caller.role === 'admin' || caller.role === 'readonly' ? undefined : caller.userId,
  });
  const chainVerification = verify ? verifyAuditChain() : undefined;

  return NextResponse.json(
    {
      object: 'list',
      data: events,
      ...(chainVerification ? { verification: chainVerification } : {}),
    },
    {
      status: 200,
      headers: {
        ...(chainVerification
          ? { 'x-eluvix-audit-chain-valid': String(chainVerification.valid) }
          : {}),
      },
    }
  );
}
