import { NextResponse } from 'next/server';
import { getProviderAgent } from '@/lib/router';
import { getProviderSettings } from '@eluvix/router-core';
import { resolveCallerIdentity } from '@/lib/caller-identity';

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

    const rawSettings = getProviderSettings();
    const status = await agent.getStatus();

    // Same redaction as the status GET: the node_token authenticates this
    // node to the external provider network and must not leak to operators
    // through the config POST's read-back.
    const caller = await resolveCallerIdentity(req);
    const isAdmin = caller.ok && caller.role === 'admin';
    const settings = rawSettings
      ? {
          ...rawSettings,
          node_token: isAdmin ? rawSettings.node_token : (rawSettings.node_token ? '[REDACTED]' : ''),
        }
      : rawSettings;

    return NextResponse.json({
      success: true,
      settings,
      status
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
