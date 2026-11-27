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

export { fetchWithSafeRedirects, MAX_SAFE_REDIRECTS } from './fetch-redirects.js';

/**
 * Maximum response body a memory provider (or the A2A adapter) will parse
 * as JSON (hunt-3 B-L6). Matches the repo's 10MB body cap
 * (`apps/desktop/src/main/server.ts: MAX_BODY_BYTES`). The body is read
 * incrementally and the parse is refused as soon as the cap is crossed,
 * so a compromised server returning a multi-hundred-MB body cannot OOM
 * the router process while recall sits on the chat hot path.
 */
export const MAX_PROVIDER_RESPONSE_BYTES = 10 * 1024 * 1024;

export async function readCappedJson(
  res: Response,
  maxBytes: number = MAX_PROVIDER_RESPONSE_BYTES
): Promise<any> {
  const body = res.body;
  if (!body || typeof (body as ReadableStream<Uint8Array>).getReader !== 'function') {
    // Non-streaming stub (e.g. a test double exposing only .json()).
    return await res.json();
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {}
          throw new Error(
            `Response body exceeds the ${maxBytes}-byte JSON parse cap; refusing to parse`
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
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
