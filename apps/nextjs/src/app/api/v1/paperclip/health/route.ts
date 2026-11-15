import dns from 'node:dns/promises';
import { NextResponse } from 'next/server';
import { isBlockedSsrfHost, validateUpstreamHttpEndpoint } from '@eluvix/router-core/ssrf-guard';
import { resolveCallerIdentity } from '@/lib/caller-identity';
import { getConfig } from '@/lib/router';

export const dynamic = 'force-dynamic';

async function resolveAndValidatePaperclipBaseUrl(rawUrl: string): Promise<
  | { ok: true; normalizedBaseUrl: string }
  | { ok: false; status: number; error: string }
> {
  const urlCheck = validateUpstreamHttpEndpoint(rawUrl, { allowLoopbackAndLan: true });
  if (!urlCheck.ok) {
    const isSchemeOrSyntax =
      urlCheck.reason?.includes('Invalid') || urlCheck.reason?.includes('Unsupported URL protocol');
    return {
      ok: false,
      status: isSchemeOrSyntax ? 400 : 403,
      error: urlCheck.reason || 'Blocked Paperclip base URL',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, status: 400, error: 'Invalid Paperclip base URL' };
  }

  const hostOnly = parsed.hostname.replace(/^\[|\]$/g, '');
  if (hostOnly && hostOnly !== 'localhost' && hostOnly !== '127.0.0.1' && hostOnly !== '::1') {
    try {
      const records = await dns.lookup(hostOnly, { all: true });
      for (const rec of records) {
        if (isBlockedSsrfHost(rec.address, { allowLoopbackAndLan: true })) {
          return {
            ok: false,
            status: 403,
            error: `Resolved IP "${rec.address}" is blocked by SSRF policy`,
          };
        }
      }
    } catch {
      // Allow fetch attempt to report clean connectivity error
    }
  }

  return {
    ok: true,
    normalizedBaseUrl: parsed.toString().replace(/\/$/, ''),
  };
}

async function probePaperclipHealth(req: Request, requestedBaseUrl?: string) {
  const callerPaperclip = await resolveCallerIdentity(req, { requiredScope: 'paperclip' });
  const caller =
    !callerPaperclip.ok && callerPaperclip.reason === 'insufficient-scope'
      ? await resolveCallerIdentity(req, { requiredScope: 'admin:config' })
      : callerPaperclip;
  if (!caller.ok) {
    const status = caller.reason === 'insufficient-scope' ? 403 : 401;
    return NextResponse.json(
      {
        ok: false,
        error:
          status === 403
            ? 'API key lacks required "paperclip" or "admin:config" scope.'
            : 'Unauthorized',
      },
      { status }
    );
  }

  const cfg = getConfig();
  const targetBaseUrl =
    (typeof requestedBaseUrl === 'string' && requestedBaseUrl.trim()) ||
    cfg.integrations?.paperclip?.paperclipBaseUrl ||
    'http://127.0.0.1:3100';

  const validated = await resolveAndValidatePaperclipBaseUrl(targetBaseUrl);
  if (!validated.ok) {
    return NextResponse.json(
      { ok: false, baseUrl: targetBaseUrl, error: validated.error },
      { status: validated.status }
    );
  }

  const startedAt = Date.now();
  try {
    const res = await fetch(`${validated.normalizedBaseUrl}/api/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
    });
    const latencyMs = Date.now() - startedAt;
    if (res.status >= 300 && res.status < 400) {
      return NextResponse.json({
        ok: false,
        status: res.status,
        latencyMs,
        baseUrl: validated.normalizedBaseUrl,
        error: 'Redirect responses from Paperclip health endpoint are blocked',
      });
    }
    let details: unknown = null;
    try {
      details = await res.json();
    } catch {
      details = null;
    }
    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      latencyMs,
      baseUrl: validated.normalizedBaseUrl,
      details,
    });
  } catch (err: any) {
    return NextResponse.json({
      ok: false,
      latencyMs: Date.now() - startedAt,
      baseUrl: validated.normalizedBaseUrl,
      error: err?.message || 'Paperclip health check failed',
    });
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const baseUrl = url.searchParams.get('baseUrl') || undefined;
  return probePaperclipHealth(req, baseUrl);
}

export async function POST(req: Request) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const baseUrl =
    typeof body?.paperclipBaseUrl === 'string'
      ? body.paperclipBaseUrl
      : typeof body?.baseUrl === 'string'
        ? body.baseUrl
        : undefined;
  return probePaperclipHealth(req, baseUrl);
}
