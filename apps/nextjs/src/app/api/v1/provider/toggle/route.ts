import { NextResponse } from 'next/server';
import { getProviderAgent } from '@/lib/router';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const agent = getProviderAgent();

    if (body.enabled) {
      await agent.start();
    } else {
      await agent.stop();
    }

    const status = await agent.getStatus();
    return NextResponse.json({
      success: true,
      enabled: body.enabled,
      status
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
