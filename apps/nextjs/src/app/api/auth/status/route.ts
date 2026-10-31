import { NextResponse } from 'next/server';
import { getLdapStatus } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const caller = await resolveCallerIdentity(req);
    const isAdmin = caller.ok && caller.role === 'admin';
    const status = getLdapStatus();
    return NextResponse.json({
      success: true,
      data: {
        ldapEnabled: status.enabled,
        ...(isAdmin ? { url: status.url } : {}),
        baseDn: status.baseDn,
        allowLocalBreakGlass: status.allowLocalBreakGlass,
      },
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err.message || 'Failed to query auth status',
        data: {
          ldapEnabled: false,
          allowLocalBreakGlass: true,
        },
      },
      { status: 500 }
    );
  }
}
