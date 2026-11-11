import { NextResponse } from 'next/server';
import { inspectRamalamaCli } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const caller = await resolveCallerIdentity(req);
    if (!caller.ok) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const inspection = await inspectRamalamaCli({ timeoutMs: 4000 });
    return NextResponse.json({
      success: true,
      ...inspection,
    });
  } catch (error) {
    const err = error as Error;
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
