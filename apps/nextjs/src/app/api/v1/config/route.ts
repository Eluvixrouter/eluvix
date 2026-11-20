import { NextResponse } from 'next/server';
import { getConfig, saveConfig, redactConfigForApi, ConfigValidationError } from '@/lib/router';
import { resolveCallerIdentity } from '@/lib/caller-identity';

export const dynamic = 'force-dynamic';

// Non-admin responses use redactConfigForApi (audit M-29): upstream/memory
// apiKeys leave this process only as boolean "configured" flags. Admins
// see the raw config (server-side use). saveConfig() preserves the stored
// key when a redacted config is posted back.
export async function GET(req: Request) {
  const identity = await resolveCallerIdentity(req);
  const isAdmin = identity.ok && identity.role === 'admin';
  const rawConfig = getConfig();
  if (isAdmin) {
    return NextResponse.json(rawConfig);
  }
  return NextResponse.json(redactConfigForApi(rawConfig));
}

export async function POST(req: Request) {
  const identity = await resolveCallerIdentity(req);
  if (identity.ok && identity.role === 'readonly') {
    return NextResponse.json({ error: 'Forbidden: read-only users cannot modify router configuration' }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch (err: any) {
    return NextResponse.json({ error: `Malformed JSON: ${err.message}` }, { status: 400 });
  }

  try {
    const current = getConfig();
    const url = new URL(req.url, 'http://localhost');
    const isAuthoritative =
      url.searchParams.get('authoritative') === '1' ||
      req.headers.get('x-eluvix-authoritative-apply') === '1';

    // Default POST merges over the live config so partial updates never silently
    // drop sections the caller did not mention (audit L-C1: egressPolicy/memory).
    // Authoritative full-graph applies from the Eluvix Visual Node Routing Editor
    // replace the live config so deleting optional nodes (memory, paperclip,
    // privacy, fallbackChains, etc.) actually removes them — while still
    // preserving egressPolicy when omitted so a local-only deployment never
    // fails open accidentally.
    const nextConfig = isAuthoritative
      ? {
          ...(current.egressPolicy !== undefined && body.egressPolicy === undefined
            ? { egressPolicy: current.egressPolicy }
            : {}),
          ...body
        }
      : { ...current, ...body };
    const updated = saveConfig(nextConfig);
    const isAdmin = identity.ok && identity.role === 'admin';
    if (isAdmin) {
      return NextResponse.json({ success: true, config: updated });
    }
    return NextResponse.json({ success: true, config: redactConfigForApi(updated) });
  } catch (error) {
    const err = error as Error;
    const isValidationError = err instanceof ConfigValidationError || err.message.startsWith('Invalid');
    return NextResponse.json({ error: err.message }, { status: isValidationError ? 400 : 500 });
  }
}
