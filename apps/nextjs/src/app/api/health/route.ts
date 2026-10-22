import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Liveness/readiness target for the Helm chart's nextjs probes
// (helm/eluvix/templates/deployment-nextjs.yaml). Intentionally trivial:
// it proves the Next.js server is up and routing, nothing more.
export async function GET() {
  return NextResponse.json({ status: 'ok', service: 'eluvix-nextjs' });
}
