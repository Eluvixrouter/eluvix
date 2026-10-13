import { NextResponse } from 'next/server';
import { getProviderAgent } from '@/lib/router';
import { getProviderSettings, getProviderJobLogs } from '@eluvix/router-core';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const agent = getProviderAgent();
    const status = await agent.getStatus();
    const settings = getProviderSettings();
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
