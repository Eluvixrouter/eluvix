import { NextResponse } from 'next/server';
import { getLdapStatus } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const caller = await resolveCallerIdentity(req);
    const isAdmin = caller.ok && caller.role === 'admin';
    const status = getLdapStatus();
    // The login page fetches this endpoint pre-auth to decide whether to
    // offer LDAP sign-in, so it stays reachable without credentials — but
    // directory recon fields are gated: unauthenticated callers learn only
    // whether LDAP is enabled, never the base DN or break-glass setting.
    return NextResponse.json({
      success: true,
      data: {
        ldapEnabled: status.enabled,
        ...(isAdmin ? { url: status.url } : {}),
        ...(caller.ok ? { baseDn: status.baseDn, allowLocalBreakGlass: status.allowLocalBreakGlass } : {}),
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
