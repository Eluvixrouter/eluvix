import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

const PROTECTED_PAGES = ['/', '/editor', '/playground', '/observability', '/configurator', '/provider', '/harness'];

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === 'eluvix.local' ||
      url.protocol === 'app:' ||
      url.protocol === 'vscode-webview:'
    );
  } catch {
    return false;
  }
}

async function secureTokenCompare(provided: string, expected: string): Promise<boolean> {
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
 * State-mutating API prefixes that read-only callers may not touch with a
 * non-GET method. Chat routes are state-mutating (they spend quota, can
 * trigger harness sessions, and write chat history / memory), so
 * /api/v1/chat covers both /api/v1/chat and /api/v1/chat/completions.
 * Exported for unit tests; the middleware applies it to session callers,
 * while elx_ named keys are enforced in the chat handlers themselves
 * (the Edge middleware cannot read keys.json, so key verification is
 * deferred to the Node route handlers).
 */
export function isProtectedMutationPath(pathname: string): boolean {
  return (
    pathname.startsWith('/api/secrets') ||
    pathname.startsWith('/api/orchestrator') ||
    pathname.startsWith('/api/v1/chat') ||
    pathname.startsWith('/api/v1/config') ||
    pathname.startsWith('/api/v1/configurator') ||
    pathname.startsWith('/api/v1/detect-models') ||
    pathname.startsWith('/api/v1/tools') ||
    pathname.startsWith('/api/v1/docker') ||
    pathname.startsWith('/api/v1/layouts') ||
    pathname.startsWith('/api/v1/provider') ||
    pathname.startsWith('/api/v1/observability') ||
    pathname.startsWith('/api/v1/memory') ||
    pathname.startsWith('/api/v1/harness/sessions') ||
    pathname.startsWith('/api/v1/files') ||
    pathname.startsWith('/api/v1/batches') ||
    pathname.startsWith('/api/v1/prompts') ||
    pathname.startsWith('/api/v1/webhooks')
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const origin = req.headers.get('origin');

  // 1. CSRF Origin Protection: Block cross-origin requests from untrusted web pages
  if (origin) {
    if (origin === 'null' || !isLocalOrigin(origin)) {
      return NextResponse.json(
        {
          error: {
            message: 'Cross-Origin requests from untrusted origins are blocked.',
            type: 'cors_violation',
            code: 'unauthorized_origin'
          }
        },
        { status: 403 }
      );
    }
  }

  // 2. Protect API routes (/api/v1/*, /v1/*, /api/secrets/*, and /api/orchestrator/*)
  if (
    pathname.startsWith('/api/v1/') ||
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/api/secrets/') ||
    pathname.startsWith('/api/orchestrator/')
  ) {
    const normalizedApiPath = pathname.startsWith('/v1/') ? `/api${pathname}` : pathname;
    const authHeader = req.headers.get('authorization');
    const xApiKeyHeader = req.headers.get('x-api-key');
    const expectedPassword = process.env.ADMIN_PASSWORD;

    const bearerToken =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : xApiKeyHeader && xApiKeyHeader.trim()
          ? xApiKeyHeader.trim()
          : null;

    // Check Bearer token or Anthropic-compatible x-api-key header
    if (bearerToken !== null) {
      const token = bearerToken;
      const legacyPassword = process.env.LEGACY_ADMIN_PASSWORD;
      const isExpected = expectedPassword ? await secureTokenCompare(token, expectedPassword) : false;
      const isLegacy = legacyPassword ? await secureTokenCompare(token, legacyPassword) : false;
      if (isExpected || isLegacy) {
        return NextResponse.next();
      }
      // Named API keys (elx_<32 letters>) are verified against keys.json inside Node route handlers
      if (
        /^elx_[A-Za-z]{24,64}$/.test(token) &&
        (normalizedApiPath.startsWith('/api/v1/chat') ||
          normalizedApiPath.startsWith('/api/v1/messages') ||
          normalizedApiPath.startsWith('/api/v1/responses') ||
          normalizedApiPath.startsWith('/api/v1/embeddings') ||
          normalizedApiPath.startsWith('/api/v1/audio') ||
          normalizedApiPath.startsWith('/api/v1/images') ||
          normalizedApiPath.startsWith('/api/v1/mcp') ||
          normalizedApiPath.startsWith('/api/v1/evals') ||
          normalizedApiPath.startsWith('/api/v1/distillation') ||
          normalizedApiPath.startsWith('/api/v1/metrics') ||
          normalizedApiPath.startsWith('/api/v1/memory') ||
          normalizedApiPath.startsWith('/api/v1/models') ||
          normalizedApiPath.startsWith('/api/v1/route-explain') ||
          normalizedApiPath.startsWith('/api/v1/export') ||
          normalizedApiPath.startsWith('/api/v1/harness/sessions') ||
          normalizedApiPath.startsWith('/api/v1/audit') ||
          normalizedApiPath.startsWith('/api/v1/files') ||
          normalizedApiPath.startsWith('/api/v1/batches') ||
          normalizedApiPath.startsWith('/api/v1/rerank') ||
          normalizedApiPath.startsWith('/api/v1/prompts') ||
          normalizedApiPath.startsWith('/api/v1/webhooks'))
      ) {
        return NextResponse.next();
      }
      // Model listing (GET only): OpenAI-compatible clients configured by
      // the Configurator (OpenCode, Continue) enumerate models with their
      // named key. The key is verified inside the models route handlers —
      // an invalid elx_-shaped token gets a 401 there, never data. This
      // widens the passthrough by exactly one read-only endpoint family;
      // see the Tier 4 PR body for the full rationale.
      if (
        req.method === 'GET' &&
        /^elx_[A-Za-z]{24,64}$/.test(token) &&
        pathname.startsWith('/api/v1/models')
      ) {
        return NextResponse.next();
      }
      return NextResponse.json(
        {
          error: {
            message: 'Incorrect API key provided.',
            type: 'invalid_request_error',
            code: 'invalid_api_key'
          }
        },
        { status: 401 }
      );
    }

    // Check NextAuth session token (for browser UI fetch calls)
    const secret = process.env.NEXTAUTH_SECRET;
    const sessionToken = await getToken({ req, secret });
    if (sessionToken) {
      // RBAC check: read-only directory auditors cannot execute state-mutating requests
      const userRole = (sessionToken.role as string) || 'admin';
      if (
        userRole === 'readonly' &&
        req.method !== 'GET' &&
        req.method !== 'HEAD' &&
        req.method !== 'OPTIONS'
      ) {
        const isProtectedMutation = isProtectedMutationPath(pathname);

        if (isProtectedMutation) {
          return NextResponse.json(
            {
              error: {
                message: 'Forbidden: read-only users cannot modify router configuration, state, or secrets.',
                type: 'insufficient_role',
                code: 'forbidden_readonly_user',
              },
            },
            { status: 403 }
          );
        }
      }
      return NextResponse.next();
    }

    // Neither Bearer token nor session cookie found
    return NextResponse.json(
      {
        error: {
          message: "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer format (e.g. 'Authorization: Bearer <your-admin-password>').",
          type: 'invalid_request_error',
          code: 'missing_api_key'
        }
      },
      { status: 401 }
    );
  }

  // 3. Protect UI pages
  const isProtectedPage = PROTECTED_PAGES.some(
    p => pathname === p || (p !== '/' && pathname.startsWith(p + '/'))
  );

  if (isProtectedPage) {
    const secret = process.env.NEXTAUTH_SECRET;
    const sessionToken = await getToken({ req, secret });
    if (!sessionToken) {
      const loginUrl = new URL('/login', req.url);
      loginUrl.searchParams.set('callbackUrl', req.url);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/',
    '/editor/:path*',
    '/playground/:path*',
    '/observability/:path*',
    '/configurator/:path*',
    '/provider/:path*',
    '/harness/:path*',
    '/api/v1/:path*',
    '/v1/:path*',
    '/api/secrets/:path*',
    '/api/orchestrator/:path*'
  ]
};

