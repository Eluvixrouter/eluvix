import { NextResponse } from 'next/server';
import { PAPERCLIP_VIRTUAL_MODELS } from '@eluvix/router-core';
import { getRouter } from '@/lib/router';
import {
  buildPaperclipFleetSummary,
  requirePaperclipCaller,
} from '@/lib/paperclip-route-helpers';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await requirePaperclipCaller(req);
  if (!auth.ok) return auth.response;

  const router = getRouter();
  const cfg = router.getConfig();
  const upstreams = buildPaperclipFleetSummary();

  return NextResponse.json({
    object: 'eluvix.switchyard.capabilities',
    egressPolicy: cfg.egressPolicy ?? 'allow-egress',
    strategy: cfg.switchyard?.strategy ?? cfg.strategy ?? 'cost-complexity',
    virtualModels: PAPERCLIP_VIRTUAL_MODELS,
    paperclipPolicy: cfg.integrations?.paperclip ?? { enabled: false },
    upstreams,
  });
}
