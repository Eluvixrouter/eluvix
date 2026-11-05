import { NextResponse } from 'next/server';
import { version } from '../../../../package.json';

export const dynamic = 'force-dynamic';

// Liveness/readiness target for the Helm chart's nextjs probes
// (helm/eluvix/templates/deployment-nextjs.yaml). Intentionally trivial:
// it proves the Next.js server is up and routing, nothing more.
// The version is read from apps/nextjs/package.json so a running instance
// always reports the release it was built from (hunt-2 M13); it cannot
// drift from the docs the way a hardcoded badge can.
export async function GET() {
  return NextResponse.json({ status: 'ok', service: 'eluvix-nextjs', version });
}
