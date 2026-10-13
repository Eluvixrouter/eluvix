import { NextResponse } from 'next/server';
import { orchestratorManager } from '@/lib/orchestration/manager';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const status = await orchestratorManager.getStatus();
    return NextResponse.json({
      success: true,
      ...status
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      error: error.message || 'Failed to query orchestrator status'
    }, { status: 500 });
  }
}
