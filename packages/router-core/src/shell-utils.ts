/**
 * Shell input escaping and configuration sanitization utilities for
 * generated launch scripts, FRRouting configurations, and Linux sysctl / iproute2 commands.
 */

/**
 * Escapes a string for safe inclusion as a POSIX shell command argument.
 * Strips dangerous ASCII control characters and wraps in single quotes with escaped internal quotes.
 */
export function escapeShellArg(raw: unknown, fallback = ''): string {
  if (typeof raw !== 'string') {
    if (raw == null) return `'${fallback}'`;
    raw = String(raw);
  }
  const clean = (raw as string).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  if (clean.length === 0) {
    return `'${fallback}'`;
  }
  return `'${clean.replace(/'/g, `'\\''`)}'`;
}

/**
 * Sanitizes an identifier (e.g. hostnames, interface names, container IDs, node labels)
 * to only allow alphanumeric characters, dots, underscores, colons, and hyphens.
 */
export function sanitizeSafeIdentifier(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (/^[a-zA-Z0-9_.:-]+$/.test(trimmed)) {
    return trimmed;
  }
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  return sanitized.length > 0 ? sanitized : fallback;
}

/**
 * Sanitizes an IPv6 address or SRv6 segment list (e.g. fcbb:bb00:0202:0104:0040::).
 * Rejects any shell metacharacters, spaces, or injection attempts.
 */
export function sanitizeIpv6SegmentList(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F:,/]+$/.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

/**
 * Sanitizes an IPv4 CIDR subnet (e.g. 10.100.2.0/24).
 */
export function sanitizeIpv4Subnet(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (/^([0-9]{1,3}\.){3}[0-9]{1,3}(\/[0-9]{1,2})?$/.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

/**
 * Parses and bounds a positive integer within [min, max].
 */
export function sanitizePositiveInt(
  raw: unknown,
  fallback: number,
  min = 1,
  max = 65535
): number {
  if (raw == null) return fallback;
  const num = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (Number.isNaN(num) || !Number.isFinite(num)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(num)));
}
