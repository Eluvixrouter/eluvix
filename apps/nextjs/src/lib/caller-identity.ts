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
  | {
      ok: true;
      userId: string;
      username?: string;
      role: 'admin' | 'operator' | 'readonly';
      groups?: string[];
      authSource?: 'ldap' | 'local';
      via: 'api-key' | 'admin' | 'session';
    }
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
 * Resolves the full session identity from the NextAuth signed JWT token.
 */
export async function resolveSessionIdentity(req: Request): Promise<{
  userId: string;
  username: string;
  role: 'admin' | 'operator' | 'readonly';
  groups: string[];
  authSource: 'ldap' | 'local';
} | null> {
  try {
    const tokenParams: Record<string, unknown> = { req: req as any };
    tokenParams['secret'] = process.env.NEXTAUTH_SECRET;
    const token = await getToken(tokenParams as any);
    if (!token) return null;
    const rawUserId = (token.userId as string) || (token.sub as string);
    const userId = rawUserId && rawUserId !== '1' ? rawUserId : ADMIN_MEMORY_USER_ID;
    const username = (token.username as string) || (userId.startsWith('ldap:') ? userId.slice(5) : 'admin');
    const role = ((token.role as string) || 'admin') as 'admin' | 'operator' | 'readonly';
    const groups = Array.isArray(token.groups) ? (token.groups as string[]) : [];
    const authSource = (token.authSource as 'ldap' | 'local') || 'local';
    return { userId, username, role, groups, authSource };
  } catch {
    return null;
  }
}

/**
 * The caller's identity when they arrive with the browser session cookie,
 * or null. Used to scope memory recall/write-back to the signed-in user.
 */
export async function resolveSessionUserId(req: Request): Promise<string | null> {
  const session = await resolveSessionIdentity(req);
  return session ? session.userId : null;
}

/**
 * Resolve WHO is calling, for per-user data scoping. The identity comes
 * only from credentials the caller actually proved:
 *
 *   - a named `elx_` API key → the userId bound to that key;
 *   - the admin password as a Bearer token → the admin's 'default' store;
 *   - the NextAuth session cookie → the proved user's store (ldap:<uid> or 'default').
 */
export async function resolveCallerIdentity(req: Request): Promise<CallerIdentityResult> {
  const authHeader = req.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token.startsWith('elx_')) {
      const resolved = resolveBearerToken(token);
      return resolved.valid
        ? {
            ok: true,
            userId: resolved.userId,
            role: resolved.role || 'operator',
            via: 'api-key',
          }
        : { ok: false, reason: 'invalid-key' };
    }
    if (token.length > 0) {
      const resolved = resolveBearerToken(token);
      if (resolved.valid && resolved.isAdmin) {
        return {
          ok: true,
          userId: resolved.userId,
          username: 'admin',
          role: 'admin',
          via: 'admin',
        };
      }
      for (const expected of [process.env.ADMIN_PASSWORD, process.env.LEGACY_ADMIN_PASSWORD]) {
        if (expected && (await secureCompare(token, expected))) {
          return {
            ok: true,
            userId: ADMIN_MEMORY_USER_ID,
            username: 'admin',
            role: 'admin',
            via: 'admin',
          };
        }
      }
      return { ok: false, reason: 'invalid-key' };
    }
  }

  const session = await resolveSessionIdentity(req);
  if (session) {
    return {
      ok: true,
      userId: session.userId,
      username: session.username,
      role: session.role,
      groups: session.groups,
      authSource: session.authSource,
      via: 'session',
    };
  }

  return { ok: false, reason: 'no-identity' };
}
