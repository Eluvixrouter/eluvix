import { NextResponse } from 'next/server';
import { getLdapStatus } from '@eluvix/router-core';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const status = getLdapStatus();
    return NextResponse.json({
      success: true,
      data: {
        ldapEnabled: status.enabled,
        url: status.url,
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
