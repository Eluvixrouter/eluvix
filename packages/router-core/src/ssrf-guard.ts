/**
 * Unified browser-safe SSRF & Cloud Metadata Guard for Eluvix.
 *
 * Zero `node:*` imports so this module can be safely bundled in both server
 * runtimes (`@eluvix/router-core`, `apps/nextjs`, `apps/desktop`) and client
 * graph compilers/inspectors.
 *
 * Modes:
 * - `allowLoopbackAndLan: false` (default): Strict public-internet egress guard.
 *   Blocks loopback, RFC1918 private LAN, CGNAT, link-local, cloud IMDS
 *   (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`, `metadata.google.internal`),
 *   NAT64 (`64:ff9b::/96`), IPv4-mapped/compatible IPv6, multicast, and internal suffixes.
 * - `allowLoopbackAndLan: true`: Local/LAN engine guard (for ComfyUI, Ollama,
 *   RamaLama, Lemonade, vLLM, and Desktop custom model probes). Permits
 *   loopback (`localhost`, `127.0.0.0/8`, `::1`) and private LAN (`10/8`,
 *   `172.16/12`, `192.168/16`, Tailscale CGNAT, `.local`/`.lan`/`.home`), while
 *   STILL strictly blocking cloud metadata services, `0.0.0.0`/`::` confusion,
 *   link-local `169.254.0.0/16` & `fe80::/10`, multicast/broadcast, NAT64, and
 *   internal cloud suffixes (`.internal`, `.arpa`).
 */

export interface SsrfGuardOptions {
  /**
   * When true, permits localhost/loopback and RFC1918/LAN addresses for local
   * AI inference engines while still blocking cloud metadata, 0.0.0.0, link-local,
   * NAT64, and multicast/broadcast addresses. Defaults to false.
   */
  allowLoopbackAndLan?: boolean;
}

export interface EndpointValidationResult {
  ok: boolean;
  reason?: string;
  normalizedHostname?: string;
}

const ALWAYS_BLOCKED_HOSTNAMES = new Set([
  '0.0.0.0',
  '::',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
  'instance-data',
]);

/**
 * Evaluates whether a hostname or IP literal should be blocked to prevent SSRF
 * and cloud instance metadata (IMDS) exfiltration.
 */
export function isBlockedSsrfHost(hostname: string, options?: SsrfGuardOptions): boolean {
  if (!hostname || typeof hostname !== 'string') return true;
  const allowLocal = options?.allowLoopbackAndLan === true;

  let host = hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
  // Strip trailing FQDN dot (e.g. "metadata.google.internal.")
  if (host.endsWith('.')) {
    host = host.slice(0, -1);
  }
  if (!host) return true;

  // NAT64 well-known prefix (RFC 6052 / RFC 8215: 64:ff9b::/96 and 64:ff9b:1::/48)
  if (host.startsWith('64:ff9b:') || host.startsWith('64:ff9b::')) {
    return true;
  }

  // AWS EC2 IPv6 IMDS endpoint (fd00:ec2::254) — always blocked even on LAN
  if (host === 'fd00:ec2::254' || host.startsWith('fd00:ec2:')) {
    return true;
  }

  // IPv4-compatible IPv6 (e.g. ::127.0.0.1 or ::169.254.169.254)
  if (host.startsWith('::') && /^::\d+\.\d+\.\d+\.\d+$/.test(host)) {
    host = host.slice(2);
  }

  // Strip IPv4-mapped IPv6 prefix (e.g. ::ffff:127.0.0.1 or normalized ::ffff:a9fe:a9fe, ::ffff:0:...)
  if (host.startsWith('::ffff:0:')) {
    const mappedZero = host.slice(9);
    const hexMatch = mappedZero.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const high = parseInt(hexMatch[1], 16);
      const low = parseInt(hexMatch[2], 16);
      host = `${(high >>> 8) & 255}.${high & 255}.${(low >>> 8) & 255}.${low & 255}`;
    } else {
      host = mappedZero;
    }
  } else if (host.startsWith('::ffff:')) {
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

  if (ALWAYS_BLOCKED_HOSTNAMES.has(host)) {
    return true;
  }

  // Cloud/infrastructure internal DNS zones are always blocked
  if (host.endsWith('.internal') || host.endsWith('.arpa')) {
    return true;
  }

  // Loopback & local mDNS hostnames
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.home')
  ) {
    return !allowLocal;
  }

  // Hexadecimal integer IPv4 (e.g. 0xa9fea9fe for 169.254.169.254)
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const num = Number(host);
    if (!Number.isFinite(num) || num < 0 || num > 4294967295) return true;
    host = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }

  // Decimal integer-formatted IPv4 (e.g. 2130706433 for 127.0.0.1, 2852039166 for 169.254.169.254)
  if (/^\d+$/.test(host)) {
    const num = parseInt(host, 10);
    if (isNaN(num) || num < 0 || num > 4294967295) return true;
    host = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }

  // Dotted IPv4 checks (including octal-prefixed octets rejected unless canonical decimal)
  const ipv4Match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const octets = [ipv4Match[1], ipv4Match[2], ipv4Match[3], ipv4Match[4]];
    // Block ambiguous leading-zero octal notation (e.g. 0251.0376.0251.0376)
    if (octets.some(o => o.length > 1 && o.startsWith('0'))) {
      return true;
    }
    const [a, b, c, d] = octets.map(Number);
    if ([a, b, c, d].some(n => n > 255 || isNaN(n))) return true;

    // 0.0.0.0/8 ("this network" / Linux localhost confusion) — ALWAYS blocked
    if (a === 0) return true;
    // 169.254.0.0/16 (link-local / AWS, GCP, Azure cloud IMDS) — ALWAYS blocked
    if (a === 169 && b === 254) return true;
    // 100.100.100.200 (Alibaba Cloud IMDS) — ALWAYS blocked
    if (a === 100 && b === 100 && c === 100 && d === 200) return true;
    // 192.0.0.0/24 (IETF protocol assignments), TEST-NETs, 6to4 relay, benchmarking — ALWAYS blocked
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved / broadcast) — ALWAYS blocked
    if (a >= 224) return true;

    // Loopback & Private LAN / Tailscale CGNAT ranges — blocked unless allowLoopbackAndLan is true
    if (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return !allowLocal;
    }

    return false;
  }

  // IPv6 link-local (fe80::/10 -> fe80..febf) and multicast (ff00::/8) — ALWAYS blocked
  if (
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb') ||
    host.startsWith('ff') ||
    host === '::'
  ) {
    return true;
  }

  // IPv6 loopback (::1) and Unique Local Addresses (fc00::/7 -> fc00..fdff, excluding fd00:ec2:: above)
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) {
    return !allowLocal;
  }

  return false;
}

/**
 * Validates a full HTTP(S) upstream endpoint URL against scheme smuggling,
 * embedded credentials, cloud metadata IMDS targets, and SSRF host rules.
 */
export function validateUpstreamHttpEndpoint(
  endpointUrl: string,
  options?: SsrfGuardOptions
): EndpointValidationResult {
  if (!endpointUrl || typeof endpointUrl !== 'string' || !endpointUrl.trim()) {
    return { ok: false, reason: 'Endpoint URL must be a non-empty string' };
  }

  let parsed: URL;
  try {
    parsed = new URL(endpointUrl.trim());
  } catch {
    return { ok: false, reason: 'Invalid endpoint URL syntax' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `Unsupported URL protocol "${parsed.protocol}" (only http: and https: are permitted)`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      reason: 'Embedded URL credentials (user:pass@host) are not permitted in upstream endpoints',
    };
  }

  const normalizedHostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
  if (isBlockedSsrfHost(normalizedHostname, options)) {
    return {
      ok: false,
      reason: `Blocked SSRF or cloud metadata target host: "${parsed.hostname}"`,
      normalizedHostname,
    };
  }

  return { ok: true, normalizedHostname };
}

/**
 * Convenience boolean check for local/LAN engine endpoints: returns `true` when
 * the URL is malformed, uses a non-HTTP(S) scheme, embeds credentials, or points
 * to a blocked cloud metadata / `0.0.0.0` / link-local / multicast address.
 */
export function isBlockedMetadataOrInvalidHost(endpointUrl: string): boolean {
  return !validateUpstreamHttpEndpoint(endpointUrl, { allowLoopbackAndLan: true }).ok;
}
