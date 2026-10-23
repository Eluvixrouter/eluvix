import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './paths.js';

/**
 * Request guards for Eluvix's local-only HTTP servers (security audit
 * C-1 / H-12 / H-13 — the desktop server shipped with no auth, no Origin
 * check, and no Host check). These are the pure, testable units behind the
 * desktop server's dispatch pipeline:
 *
 *  - Host allowlist: defeats DNS rebinding regardless of any other header.
 *  - Origin rejection: a present Origin that is not a trusted local origin
 *    is rejected outright (the discipline the Next.js middleware already
 *    applies — see apps/nextjs/src/middleware.ts), not merely denied CORS
 *    reflection after the handler has run.
 *  - A per-install desktop token, required on every route, so local pages
 *    and processes without the token file cannot drive the API at all.
 */

export const DESKTOP_TOKEN_HEADER = 'x-eluvix-desktop-token';
export const DESKTOP_TOKEN_FILENAME = 'desktop-token';

/**
 * Trusted local origins for browser-originated requests. Mirrors the
 * Next.js middleware's local-origin set, plus `file:` — the desktop
 * renderer itself is a `file://` page.
 */
export function isTrustedLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === 'eluvix.local' ||
      url.protocol === 'app:' ||
      url.protocol === 'vscode-webview:' ||
      url.protocol === 'file:'
    );
  } catch {
    return false;
  }
}

const ALLOWED_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'eluvix.local']);

/**
 * Validate a Host header against the local allowlist. Accepts an optional
 * port and bracketed IPv6 literals. Missing/malformed hosts are rejected.
 */
export function isAllowedLocalHost(hostHeader: string | undefined | null): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close === -1) return false;
    host = host.slice(1, close);
  } else if (host.indexOf(':') === host.lastIndexOf(':')) {
    // Single colon: host:port. (Zero colons: bare host. Two or more: a
    // bare IPv6 literal without brackets — no port to strip.)
    const colon = host.indexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  return ALLOWED_LOCAL_HOSTS.has(host);
}

/** Constant-time token comparison (length is not secret; content is). */
export function desktopTokenEquals(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Pull the desktop token out of a request's headers: the dedicated header
 * (renderer, scripts) or `Authorization: Bearer <token>` (OpenAI-compatible
 * CLI tools, which present their API key that way).
 */
export function extractDesktopToken(
  headers: Record<string, string | string[] | undefined>
): string | null {
  const direct = headers[DESKTOP_TOKEN_HEADER];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim();
    if (token) return token;
  }
  return null;
}

export interface DesktopTokenResult {
  token: string;
  tokenFile: string;
  isNew: boolean;
}

/**
 * Load the per-install desktop API token, generating and persisting one on
 * first run. The token lives in the app config dir in a `0o600` file whose
 * entire content is the token, so local CLI tools can do
 * `OPENAI_API_KEY=$(cat <tokenFile>)` — the same storage pattern as
 * `auth.json`. The token is never served over the HTTP API itself; the
 * desktop renderer receives it from the main process over IPC.
 */
export function getOrCreateDesktopToken(appName = 'eluvix'): DesktopTokenResult {
  const { configDir } = getAppPaths(appName);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const tokenFile = path.join(configDir, DESKTOP_TOKEN_FILENAME);

  if (fs.existsSync(tokenFile)) {
    try {
      const existing = fs.readFileSync(tokenFile, 'utf8').trim();
      if (existing) {
        return { token: existing, tokenFile, isNew: false };
      }
    } catch {}
  }

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, token + '\n', { encoding: 'utf8', mode: 0o600 });
  return { token, tokenFile, isNew: true };
}
