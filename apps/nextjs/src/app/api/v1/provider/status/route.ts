import { NextResponse } from 'next/server';
import { getProviderAgent } from '@/lib/router';
import { getRedactedProviderSettings, getProviderJobLogs } from '@eluvix/router-core';

export const dynamic = 'force-dynamic';

// No identity resolution here: the response is identical for every
// caller (audit M-29 redaction), and auth is enforced by middleware.
// The T4 test calls GET() with no request; resolveCallerIdentity would
// throw on an absent req, so it is deliberately not called.
export async function GET() {
  try {
    const agent = getProviderAgent();
    const status = await agent.getStatus();
    // Redacted variant (audit M-29): the node token is a bearer credential
    // for the marketplace and must never leave the process; the client
    // gets a boolean node_token_configured flag instead.
    const settings = getRedactedProviderSettings();
    const recentJobs = getProviderJobLogs(15);

    return NextResponse.json({
      success: true,
      status,
      settings,
      recentJobs
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
