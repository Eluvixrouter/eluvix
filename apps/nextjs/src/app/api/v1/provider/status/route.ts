import { NextResponse } from 'next/server';
import { getProviderAgent } from '@/lib/router';
import { getProviderSettings, getProviderJobLogs } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const caller = await resolveCallerIdentity(req);
    const agent = getProviderAgent();
    const status = await agent.getStatus();
    const rawSettings = getProviderSettings();
    const recentJobs = getProviderJobLogs(15);

    const isAdmin = caller.ok && caller.role === 'admin';
    const settings = rawSettings
      ? {
          ...rawSettings,
          node_token: isAdmin ? rawSettings.node_token : (rawSettings.node_token ? '[REDACTED]' : ''),
        }
      : rawSettings;

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
