import { NextResponse } from 'next/server';
import { getRollingSpendUsd } from '@eluvix/router-core';
import { getRouter } from '@/lib/router';
import { requirePaperclipCaller } from '@/lib/paperclip-route-helpers';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await requirePaperclipCaller(req);
  if (!auth.ok) return auth.response;

  const router = getRouter();
  const cfg = router.getConfig();
  const pcCfg = cfg.integrations?.paperclip;
  const rolling24hSpendUsd = getRollingSpendUsd(24, auth.identity.userId);

  return NextResponse.json({
    ok: true,
    userId: auth.identity.userId,
    via: auth.identity.via,
    paperclipIntegrationEnabled: Boolean(pcCfg?.enabled),
    trustHeadersFrom: pcCfg?.trustHeadersFrom ?? 'scoped-key',
    egressPolicy: cfg.egressPolicy ?? 'allow-egress',
    rolling24hSpendUsd,
    maxDailySpendUsd: cfg.switchyard?.maxDailySpendUsd ?? null,
  });
}
