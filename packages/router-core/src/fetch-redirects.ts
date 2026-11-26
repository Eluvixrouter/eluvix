/**
 * Browser-safe outbound fetch redirect policy (audit M-8).
 *
 * `fetchWithSafeRedirects` follows redirects MANUALLY, same-origin only:
 * the platform default follows redirects anywhere, which lets a
 * configured — or compromised — endpoint answer 307 and bounce a
 * credential-bearing request, body included, to an attacker host. The
 * fetch spec strips `Authorization` on cross-origin redirects but NOT
 * custom headers like `x-api-key` / `X-Vault-Token`, so credentials
 * could ride along. Here cross-origin redirects are refused outright
 * and same-origin redirects are followed up to a small bound.
 *
 * This module has ZERO `node:*` imports so browser/client bundles can
 * import it (e.g. via otel-exporter). The DNS-based metadata check
 * lives in fetch-policy.ts, which re-exports this module.
 */

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

