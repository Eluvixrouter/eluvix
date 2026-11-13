/**
 * Outbound fetch policy for operator-configured endpoints (upstreams,
 * model detection, harness servers).
 *
 * Two rules live here:
 *
 * 1. Redirects are followed MANUALLY, same-origin only (audit M-8). The
 *    platform default follows redirects anywhere, which lets a configured
 *    — or compromised, or layout-imported — upstream answer 307 and
 *    bounce a chat POST, body included, to 169.254.169.254 or an internal
 *    API, with the internal response returned to the chat caller. The
 *    fetch spec strips `Authorization` on cross-origin redirects but NOT
 *    custom headers like `x-api-key`, so credentials could ride along.
 *    Here: cross-origin redirects are refused outright (so credentials
 *    and bodies never cross origins at all), same-origin redirects are
 *    followed up to a small bound, and the credential headers are
 *    explicitly deleted before any cross-origin hop would be built —
 *    defense in depth for a refusal that has already been decided.
 *
 * 2. Model detection refuses to probe cloud metadata / link-local
 *    targets (audit S-2). The endpoint host is resolved up front; if any
 *    resolved address is in 169.254.0.0/16, or the host is
 *    metadata.google.internal, the probe is blocked. Loopback literals
 *    the operator typed are exempt — probing local model servers is the
 *    feature this path exists for.
 *
 *    Residual, stated plainly: this narrows but does NOT eliminate the
 *    DNS-rebinding TOCTOU. The name is resolved again by fetch at
 *    connect time, so a hostile resolver could answer the check with a
 *    benign address and the connection with a metadata one. Fully
 *    closing the race requires a custom dispatcher that pins the
 *    validated address at connect time (e.g. an undici Agent with a
 *    lookup hook); that is out of scope here and the residual is
 *    accepted — the endpoint is admin-configured, and LAN probing is
 *    the endpoint's purpose.
 */
import { lookup } from 'node:dns/promises';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const MAX_SAFE_REDIRECTS = 3;

/**
 * fetch() with redirect: 'manual' plus the policy above. Drop-in
 * replacement for fetch at call sites that talk to configured
 * endpoints. Throws on cross-origin redirects and on redirect loops.
 */
export async function fetchWithSafeRedirects(
  input: string | URL,
  init: RequestInit = {},
  maxRedirects: number = MAX_SAFE_REDIRECTS
): Promise<Response> {
  // Keep the URL a string end to end: call sites pass strings, and
  // fetch mocks in tests legitimately expect a string first argument.
  let currentUrl = input.toString();
  let currentOrigin: string;
  try {
    currentOrigin = new URL(currentUrl).origin;
  } catch {
    // Unparseable URL (e.g. a synthetic test endpoint such as
    // http://localhost:11434-stub-m1, whose port is not numeric): no
    // origin can be established, so no redirect policy can apply.
    // Fall through to a plain fetch and let it fail on its own terms,
    // exactly as the old call sites did — the underlying fetch rejects
    // truly invalid URLs itself, so nothing invalid is ever fetched.
    return fetch(currentUrl, init);
  }
  let currentInit: RequestInit = { ...init };
  let followed = 0;

  for (;;) {
    const res = await fetch(currentUrl, { ...currentInit, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;

    let nextUrl: URL;
    try {
      nextUrl = new URL(location, currentUrl);
    } catch {
      return res;
    }

    // Discard the redirect body so the connection can close cleanly.
    try {
      await res.body?.cancel();
    } catch {
      // Ignore: the body may already be disturbed.
    }

    const headers = new Headers(currentInit.headers);
    if (nextUrl.origin !== currentOrigin) {
      // Credentials must never cross origins. The redirect is refused
      // outright below, so nothing is sent — these deletes keep the
      // invariant explicit in the code, not just implied by the throw.
      headers.delete('authorization');
      headers.delete('x-api-key');
      console.warn(
        `[Eluvix Fetch] Refusing cross-origin redirect ${currentOrigin} -> ${nextUrl.origin} (configured-endpoint fetches only follow redirects within the same origin)`
      );
      throw new Error(
        `Refused cross-origin redirect from ${currentOrigin} to ${nextUrl.origin}: ` +
          'fetches to configured endpoints never follow a redirect to a different origin, ' +
          'so request bodies and credentials cannot be bounced to an attacker-chosen host'
      );
    }

    if (followed >= maxRedirects) {
      throw new Error(
        `Too many redirects (more than ${maxRedirects}) while fetching ${currentOrigin}`
      );
    }
    followed++;

    // Method rewriting per the fetch spec: 303 always converts to GET;
    // 301/302 convert POST to GET. 307/308 preserve method and body.
    const method = (currentInit.method || 'GET').toUpperCase();
    const nextInit: RequestInit = { ...currentInit, headers };
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      if (method !== 'GET' && method !== 'HEAD') {
        nextInit.method = 'GET';
        delete nextInit.body;
        headers.delete('content-type');
        headers.delete('content-length');
      }
    }
    currentInit = nextInit;
    currentUrl = nextUrl.toString();
    currentOrigin = nextUrl.origin;
  }
}

const METADATA_HOSTNAMES = new Set(['metadata.google.internal']);

function normalizeHost(hostname: string): string {
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice(7);
    const hexMatch = mapped.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const high = parseInt(hexMatch[1], 16);
      const low = parseInt(hexMatch[2], 16);
      host = `${(high >>> 8) & 255}.${high & 255}.${(low >>> 8) & 255}.${low & 255}`;
    } else {
      host = mapped;
    }
  }
  return host;
}

function isLinkLocalAddress(address: string): boolean {
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(normalizeHost(address));
}

function isLoopbackLiteral(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * Pre-fetch resolution check for the model-detection path (S-2). Throws
 * when the endpoint host is, or resolves to, a cloud metadata /
 * link-local address. Unresolvable hosts are left alone — the fetch
 * itself will fail, and there is nothing to protect.
 */
export async function assertEndpointNotMetadata(endpoint: string): Promise<void> {
  let host: string;
  try {
    host = normalizeHost(new URL(endpoint).hostname);
  } catch {
    return; // Non-URL endpoints (cli://, acp://) make no HTTP fetch here.
  }
  if (!host) return;
  // Loopback literals the operator typed are exempt: probing local
  // model servers is the feature this path exists for.
  if (isLoopbackLiteral(host)) return;
  if (METADATA_HOSTNAMES.has(host) || isLinkLocalAddress(host)) {
    throw new Error(
      `Refusing to probe ${endpoint}: host "${host}" is a cloud metadata / link-local address`
    );
  }
  if (isIpLiteral(host)) return;

  let records: Array<{ address: string }> = [];
  try {
    records = await lookup(host, { all: true });
  } catch {
    return;
  }
  for (const record of records) {
    if (isLinkLocalAddress(record.address)) {
      throw new Error(
        `Refusing to probe ${endpoint}: host "${host}" resolves to link-local/metadata address ${record.address}`
      );
    }
  }
}
