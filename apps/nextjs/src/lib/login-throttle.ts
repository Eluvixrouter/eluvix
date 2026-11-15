/**
 * Per-IP login throttling for the credentials authorize path (audit L-3).
 *
 * The login form was previously unthrottled: an attacker who could reach
 * the page could guess the admin password at full speed. Failures are now
 * counted per client IP; past a small free allowance, each failure locks
 * the IP out for an escalating window (30s, doubling, capped at 15min).
 * A successful login clears the counter. State is in-memory — a process
 * restart resets it, which is acceptable for a single-admin local app
 * and keeps no attacker-influenceable state on disk.
 */

interface FailureRecord {
  failures: number;
  lockedUntil: number;
  lastFailureAt: number;
}

const records = new Map<string, FailureRecord>();

const FREE_FAILURES = 4;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;

function lockoutForFailure(failures: number): number {
  if (failures <= FREE_FAILURES) return 0;
  const exponent = failures - FREE_FAILURES - 1;
  return Math.min(BASE_LOCKOUT_MS * 2 ** exponent, MAX_LOCKOUT_MS);
}

/** Milliseconds the key remains locked out (0 = attempts allowed). */
export function loginLockoutRemainingMs(key: string, now: number = Date.now()): number {
  const record = records.get(key);
  if (!record) return 0;
  // Forget stale records whose lockout and memory have both expired.
  if (record.lockedUntil <= now && now - record.lastFailureAt > MAX_LOCKOUT_MS) {
    records.delete(key);
    return 0;
  }
  return Math.max(0, record.lockedUntil - now);
}

export function recordLoginFailure(
  key: string,
  now: number = Date.now()
): { failures: number; lockoutMs: number } {
  const record = records.get(key) || { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
  record.failures += 1;
  record.lastFailureAt = now;
  const lockoutMs = lockoutForFailure(record.failures);
  record.lockedUntil = lockoutMs > 0 ? now + lockoutMs : record.lockedUntil;
  records.set(key, record);
  return { failures: record.failures, lockoutMs };
}

export function recordLoginSuccess(key: string): void {
  records.delete(key);
}

export function __resetLoginThrottleForTests(): void {
  records.clear();
}

/**
 * Best-effort client IP for throttling. NextAuth's authorize request
 * exposes the raw headers; behind server.mjs there is no proxy, so the
 * forwarded headers reflect whatever the client sent — spoofable, but
 * the fallback bucket still throttles: all header-less / unparseable
 * attempts share the 'unknown' key, so evading per-IP limits requires
 * rotating *plausible* IPs, and each new IP still gets only FREE_FAILURES
 * free attempts before lockouts engage.
 */
export function getLoginThrottleKey(req: { headers?: any } | undefined | null): string {
  const headers = req?.headers;
  if (!headers) return 'unknown';
  const read = (name: string): string | null => {
    try {
      if (typeof headers.get === 'function') return headers.get(name);
      const value = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : (value ?? null);
    } catch {
      return null;
    }
  };
  const forwarded = read('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = read('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}
