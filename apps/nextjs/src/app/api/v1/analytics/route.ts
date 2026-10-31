import { NextResponse } from 'next/server';
import { getRequestLogs } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const caller = await resolveCallerIdentity(req);
    const isAdmin = caller.ok && caller.role === 'admin';
    const logs = getRequestLogs(100, isAdmin ? undefined : (caller.ok ? caller.userId : 'anonymous')); // Get last 100 requests
    
    // Calculate basic analytics
    const totalRequests = logs.length;
    const avgLatency = totalRequests > 0 
      ? Math.round(logs.reduce((acc: number, log: any) => acc + (log.duration_ms || 0), 0) / totalRequests)
      : 0;

    // Estimate cost savings (Assume local saves $0.005 per request vs cloud)
    const localRequests = logs.filter((log: any) => {
      const up = (log.upstream_id || '').toLowerCase();
      return (
        up.includes('ollama') || 
        up.includes('vllm') || 
        up.includes('lemonade') ||
        up.includes('switchyard')
      );
    }).length;

    const estimatedSavings = (localRequests * 0.005).toFixed(3);

    return NextResponse.json({
      success: true,
      data: {
        totalRequests,
        avgLatency,
        estimatedSavings,
        logs
      }
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
