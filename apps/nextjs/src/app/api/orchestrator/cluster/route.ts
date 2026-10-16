import { NextResponse } from 'next/server';
import { orchestratorManager } from '@/lib/orchestration/manager';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'status';

    if (!['create', 'delete', 'start', 'stop', 'status'].includes(action)) {
      return NextResponse.json({
        success: false,
        error: `Invalid cluster action: ${action}. Allowed: create, delete, start, stop, status.`
      }, { status: 400 });
    }

    const res = await orchestratorManager.manageCluster(action as any);

    return NextResponse.json({
      success: res.success,
      action,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: res.durationMs
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message || 'Cluster action failed'
    }, { status: 500 });
  }
}
