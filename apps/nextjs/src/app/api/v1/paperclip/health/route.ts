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

  // Hunt-3 C-M6: a caller-supplied baseUrl turns this endpoint into a
  // loopback/LAN SSRF probe for the lowest-privilege key class. Only an
  // admin (or an admin:config-scoped key, which resolved via the fallback
  // above) may probe an arbitrary baseUrl; everyone else probes the
  // configured paperclipBaseUrl only, and a supplied URL is refused
  // outright rather than silently ignored.
  const mayChooseTarget =
    caller.role === 'admin' ||
    (!callerPaperclip.ok && callerPaperclip.reason === 'insufficient-scope');
  const supplied = typeof requestedBaseUrl === 'string' ? requestedBaseUrl.trim() : '';

  const cfg = getConfig();
  const configuredBaseUrl =
    cfg.integrations?.paperclip?.paperclipBaseUrl || 'http://127.0.0.1:3100';
  // Supplying exactly the configured URL changes nothing, so it is allowed
  // for any caller; supplying anything else is an admin-only probe target.
  const suppliedIsConfigured =
    supplied.replace(/\/$/, '') === configuredBaseUrl.replace(/\/$/, '');
  if (supplied && !suppliedIsConfigured && !mayChooseTarget) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Only admin callers may probe a custom Paperclip baseUrl.',
      },
      { status: 403 }
    );
  }

  const targetBaseUrl = (mayChooseTarget && supplied) || configuredBaseUrl;

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
    // Hunt-3 C-M6: never echo the target's response body — the probe
    // reports reachability only (status + latency). Echoing the JSON let
    // a paperclip-scoped key exfiltrate arbitrary loopback/LAN payloads.
    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      latencyMs,
      baseUrl: validated.normalizedBaseUrl,
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
