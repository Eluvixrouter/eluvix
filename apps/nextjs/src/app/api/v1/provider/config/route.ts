import { NextResponse } from 'next/server';
import { getProviderAgent } from '@/lib/router';
import { getProviderSettings } from '@eluvix/router-core';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const agent = getProviderAgent();

    agent.updateConfig({
      serverUrl: body.serverUrl,
      nodeToken: body.nodeToken,
      nodeName: body.nodeName,
      engineUrl: body.engineUrl,
      engineType: body.engineType,
      pricingMode: body.pricingMode,
      floorPriceIn: typeof body.floorPriceIn === 'number' ? body.floorPriceIn : undefined,
      floorPriceOut: typeof body.floorPriceOut === 'number' ? body.floorPriceOut : undefined,
      pauseOnUserActive: Boolean(body.pauseOnUserActive),
      maxGpuTempC: body.maxGpuTempC || 82,
      maxConcurrency: body.maxConcurrency || 1,
    });

    const updated = getProviderSettings();
    const status = await agent.getStatus();

    return NextResponse.json({
      success: true,
      settings: updated,
      status
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
