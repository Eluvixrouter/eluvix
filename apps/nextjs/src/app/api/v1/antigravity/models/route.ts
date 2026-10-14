import { NextResponse } from 'next/server';
import { discoverAntigravityModels } from '@eluvix/router-core';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const forceRefresh = searchParams.get('refresh') === 'true';
    const cliPath = searchParams.get('cliPath') || 'agy';

    // Validate cliPath is safe
    const safeCli = cliPath === 'agy' || cliPath === 'antigravity' ? cliPath : 'agy';
    const result = await discoverAntigravityModels(safeCli, forceRefresh);

    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: { message: err?.message || 'Failed to discover Antigravity models' } },
      { status: 500 }
    );
  }
}
