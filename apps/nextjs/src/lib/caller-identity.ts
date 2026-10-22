import { getToken } from 'next-auth/jwt';
import { resolveBearerToken } from '@eluvix/router-core';

/**
 * The memory store identity of the app's human operator. Eluvix is a
 * single-admin app: the NextAuth user is the admin (id "1"), and
 * resolveBearerToken likewise maps the admin password to userId 'default'.
 * Session and admin-bearer callers therefore share the 'default' store —
 * the same store the browser UI has always read and written.
 */
export const ADMIN_MEMORY_USER_ID = 'default';

export type CallerIdentityResult =
  | { ok: true; userId: string; via: 'api-key' | 'admin' | 'session' }
  | { ok: false; reason: 'invalid-key' | 'no-identity' };

async function secureCompare(provided: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [hashProvided, hashExpected] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected))
  ]);
  const a = new Uint8Array(hashProvided);
  const b = new Uint8Array(hashExpected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * The caller's identity when they arrive with the browser session cookie,
 * or null. Used to scope memory recall/write-back to the signed-in user
 * instead of a self-asserted header.
 */
export async function resolveSessionUserId(req: Request): Promise<string | null> {
  try {
    const tokenParams: Record<string, unknown> = { req: req as any };
    tokenParams['secret'] = process.env.NEXTAUTH_SECRET;
    const token = await getToken(tokenParams as any);
    return token ? ADMIN_MEMORY_USER_ID : null;
  } catch {
    return null;
  }
}

/**
 * Resolve WHO is calling, for per-user data scoping. The identity comes
 * only from credentials the caller actually proved:
 *
 *   - a named `elx_` API key → the userId bound to that key
 *     (resolveBearerToken); an invalid key is an error, never a fallback;
 *   - the admin password as a Bearer token (env ADMIN_PASSWORD /
 *     LEGACY_ADMIN_PASSWORD, or the stored auth-config password) → the
 *     admin's 'default' store;
 *   - the NextAuth session cookie → the admin's 'default' store.
 *
 * Anything else yields no identity. A userId supplied via query string,
 * body, or header is NEVER consulted here — it must not widen access
 * beyond the caller's own data.
 */
export async function resolveCallerIdentity(req: Request): Promise<CallerIdentityResult> {
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('elx_')) {
      const resolved = resolveBearerToken(token);
      return resolved.valid
        ? { ok: true, userId: resolved.userId, via: 'api-key' }
        : { ok: false, reason: 'invalid-key' };
    }
    if (token.length > 0) {
      const resolved = resolveBearerToken(token);
      if (resolved.valid && resolved.isAdmin) {
        return { ok: true, userId: resolved.userId, via: 'admin' };
      }
      for (const expected of [process.env.ADMIN_PASSWORD, process.env.LEGACY_ADMIN_PASSWORD]) {
        if (expected && (await secureCompare(token, expected))) {
          return { ok: true, userId: ADMIN_MEMORY_USER_ID, via: 'admin' };
        }
      }
      return { ok: false, reason: 'invalid-key' };
    }
  }

  const sessionUserId = await resolveSessionUserId(req);
  if (sessionUserId) {
    return { ok: true, userId: sessionUserId, via: 'session' };
  }

  return { ok: false, reason: 'no-identity' };
}
