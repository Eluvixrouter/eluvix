import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

const PROTECTED_PAGES = ['/', '/editor', '/playground', '/observability', '/configurator'];

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

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const origin = req.headers.get('origin');

  // 1. CSRF Origin Protection: Block cross-origin requests from untrusted web pages
  if (origin && origin !== 'null') {
    if (!isLocalOrigin(origin)) {
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

  // 2. Protect API routes (/api/v1/* and /api/secrets/*)
  if (pathname.startsWith('/api/v1/') || pathname.startsWith('/api/secrets/')) {
    const authHeader = req.headers.get('authorization');
    const expectedPassword = process.env.ADMIN_PASSWORD;

    // Check Bearer token
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      if (expectedPassword && (await secureTokenCompare(token, expectedPassword))) {
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
    '/api/v1/:path*',
    '/api/secrets/:path*'
  ]
};

