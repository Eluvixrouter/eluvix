export function evaluateMathExpression(expr: string): number {
  if (!expr || typeof expr !== 'string') {
    throw new Error('Expression must be a non-empty string');
  }

  // Tokenize
  const tokens: string[] = [];
  let i = 0;
  const str = expr.trim();
  if (!str) throw new Error('Expression cannot be empty');

  while (i < str.length) {
    const ch = str[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let numStr = '';
      let dotCount = 0;
      while (i < str.length && /[0-9.]/.test(str[i])) {
        if (str[i] === '.') {
          dotCount++;
          if (dotCount > 1) throw new Error('Invalid number format: multiple decimal points');
        }
        numStr += str[i];
        i++;
      }
      tokens.push(numStr);
      continue;
    }
    if ('+-*/%()'.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    throw new Error(`Invalid character in expression: "${ch}"`);
  }

  if (tokens.length === 0) throw new Error('Expression cannot be empty');

  let pos = 0;

  function peek(): string | undefined {
    return tokens[pos];
  }

  function consume(expected?: string): string {
    const token = tokens[pos];
    if (expected !== undefined && token !== expected) {
      throw new Error(`Expected "${expected}" but found "${token ?? 'end of expression'}"`);
    }
    pos++;
    return token;
  }

  function parseExpression(): number {
    let value = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = consume();
      const right = parseTerm();
      if (op === '+') value += right;
      else value -= right;
    }
    return value;
  }

  function parseTerm(): number {
    let value = parseFactor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = consume();
      const right = parseFactor();
      if (op === '*') {
        value *= right;
      } else if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        value /= right;
      } else if (op === '%') {
        if (right === 0) throw new Error('Division by zero');
        value %= right;
      }
    }
    return value;
  }

  function parseFactor(): number {
    const token = peek();
    if (!token) throw new Error('Unexpected end of expression');

    // Handle unary + or -
    if (token === '+' || token === '-') {
      consume();
      const factor = parseFactor();
      return token === '-' ? -factor : factor;
    }

    if (token === '(') {
      consume('(');
      const value = parseExpression();
      if (peek() !== ')') {
        throw new Error('Mismatched parentheses: missing closing parenthesis');
      }
      consume(')');
      return value;
    }

    const num = Number(token);
    if (isNaN(num)) {
      throw new Error(`Unexpected token "${token}"`);
    }
    consume();
    return num;
  }

  const result = parseExpression();
  if (pos < tokens.length) {
    throw new Error(`Unexpected extra token "${tokens[pos]}"`);
  }
  if (!isFinite(result)) {
    throw new Error('Result is not a finite number');
  }
  return result;
}

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { isBlockedSsrfHost } from '@eluvix/router-core/ssrf-guard';

export function isBlockedHost(hostname: string): boolean {
  return isBlockedSsrfHost(hostname, { allowLoopbackAndLan: false });
}

export async function isBlockedDns(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').trim();
  if (isBlockedHost(host)) return true;
  try {
    const addresses = await dns.lookup(host, { all: true });
    for (const record of addresses) {
      if (isBlockedHost(record.address)) {
        return true;
      }
    }
  } catch {
    // If DNS resolution fails, allow caller to handle connection error
  }
  return false;
}

/**
 * Thrown by fetchWithPinnedDns when the hostname or one of its resolved
 * addresses is a blocked SSRF/metadata target.
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export interface PinnedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Guard mode; defaults to strict public-internet (loopback/LAN blocked). */
  allowLoopbackAndLan?: boolean;
}

function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':');
}

/**
 * Fetch a URL with DNS-pinned resolution (hunt-2 suspect S-C3).
 *
 * The naive check-then-fetch pattern resolves the hostname twice — once in
 * isBlockedDns and once inside fetch() — so a DNS answer that flips between
 * the two (TTL-0 rebinding) can steer the connection to a loopback or
 * cloud-metadata address the check just cleared. This helper resolves the
 * hostname exactly ONCE, refuses the URL if the literal host or ANY
 * returned address is blocked, then connects the socket directly to the
 * first validated address. The URL's hostname is preserved for TLS SNI,
 * certificate validation, and the Host header; only the connection target
 * is pinned.
 *
 * Implementation note: the pinning is done with `createConnection`, NOT
 * with the `lookup` request option. Empirically, `http.request` in Node
 * 24.22.1 never invokes a custom `lookup` (proven with a standalone
 * script: `net.connect` calls it, `http.request`/`http.get` do not), so a
 * lookup-based pin is silently unpinned. Connecting to the validated IP
 * literal via `net.connect` / `tls.connect` (with `servername` for SNI)
 * cannot re-resolve, which is the actual guarantee.
 *
 * Redirects are never followed (callers handle them per hop, as the web
 * scraper does). Throws SsrfBlockedError for blocked targets; DNS and
 * network failures propagate to the caller.
 */
export async function fetchWithPinnedDns(
  url: string | URL,
  init?: PinnedFetchInit
): Promise<Response> {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https protocols are supported (got "${parsed.protocol}")`);
  }
  const allowLocal = init?.allowLoopbackAndLan === true;
  const hostname = parsed.hostname;
  if (isBlockedSsrfHost(hostname, { allowLoopbackAndLan: allowLocal })) {
    throw new SsrfBlockedError(
      `Access to private, loopback, or metadata addresses is blocked (host "${hostname}")`
    );
  }

  // Resolve exactly once. IP literals skip the lookup (net.connect does too).
  let pinned: { address: string; family: number }[] | null = null;
  if (!isIpLiteral(hostname)) {
    let resolved;
    try {
      resolved = await dns.lookup(hostname, { all: true });
    } catch (err: any) {
      throw new Error(`DNS resolution failed for "${hostname}": ${err?.message || err}`);
    }
    if (!resolved || resolved.length === 0) {
      throw new Error(`DNS resolution failed for "${hostname}": no addresses returned`);
    }
    for (const rec of resolved) {
      if (isBlockedSsrfHost(rec.address, { allowLoopbackAndLan: allowLocal })) {
        throw new SsrfBlockedError(
          `Access to private, loopback, or metadata addresses is blocked (host "${hostname}" resolves to "${rec.address}")`
        );
      }
    }
    pinned = resolved.map((r) => ({ address: r.address, family: r.family }));
  }

  // The pinned connection target: the first validated address, or the
  // literal host itself (IP literals need no lookup at all).
  const targetAddress = pinned
    ? pinned[0].address
    : hostname.replace(/^\[|\]$/g, '');
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  const isHttps = parsed.protocol === 'https:';
  // Host header keeps the original hostname (bracketed for IPv6 literals,
  // port included when non-default) so virtual-host routing still works.
  const defaultPort = isHttps ? 443 : 80;
  const hostForHeader = isIpLiteral(hostname)
    ? `${hostname.includes(':') ? `[${hostname.replace(/^\[|\]$/g, '')}]` : hostname}${port !== defaultPort ? `:${port}` : ''}`
    : `${hostname}${port !== defaultPort ? `:${port}` : ''}`;

  return new Promise<Response>((resolve, reject) => {
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method: init?.method || 'GET',
        headers: { host: hostForHeader, ...init?.headers },
        signal: init?.signal,
        // Pin by connecting to the validated IP literal. Node never
        // re-resolves a literal, so no second DNS lookup can occur.
        createConnection: () =>
          isHttps
            ? tls.connect({
                host: targetAddress,
                port,
                // SNI + cert validation against the original hostname
                // (never an IP literal — Node rejects those as servername).
                ...(isIpLiteral(hostname) ? {} : { servername: hostname }),
              })
            : net.connect({ host: targetAddress, port }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              for (const item of v) headers.append(k, item);
            } else {
              headers.set(k, v);
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 200,
              headers,
            })
          );
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

export function normalizeProbeUrl(endpoint: string, type: string): string {
  const trimmed = (endpoint || '').trim().replace(/\/+$/, '');
  const baseWithoutV1 = trimmed.replace(/\/v1$/, '');

  if (type === 'ollama') {
    return `${baseWithoutV1}/api/tags`;
  }
  if (type === 'comfyui') {
    return `${baseWithoutV1}/system_stats`;
  }
  if (type === 'lemonade' || type === 'ramalama' || type === 'openai-compatible' || type === 'vllm' || type === 'vllm-sr' || type === 'switchyard' || type === 'openviking' || type === 'trueforge') {
    return `${baseWithoutV1}/v1/models`;
  }
  return trimmed;
}

export const ALLOWED_DOCKER_SERVICES = new Set([
  'switchyard',
  'vllm-sr',
  'ollama',
  'ramalama',
  'comfyui',
  'vllm',
  'sglang',
  'agent-router',
  'agentgateway',
  'openviking',
  'lightrag',
  'graphiti',
  'trueforge',
  'opencode',
  'aider',
  'swe-agent',
  'cline',
  'plandex',
  'sandbox',
  'lemonade',
  'router'
]);

export function isValidContainerName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim().toLowerCase();
  return ALLOWED_DOCKER_SERVICES.has(trimmed);
}

import crypto from 'crypto';
import { resolveCallerIdentity } from '@/lib/caller-identity';

/**
 * Hunt-3 C-L3: docker control (up/down/logs) is gated on a real admin
 * identity — never the Host header. Accepts, in order:
 *
 *  1. A bearer token matching the configured admin token env var:
 *     `ELUVIX_ADMIN_TOKEN` (preferred; `ENCLAVIX_ADMIN_TOKEN` and
 *     `ADMIN_TOKEN` are accepted aliases). Set one of these in production:
 *     without it, token-only admin access does not exist.
 *  2. A proven admin/operator identity: the admin bearer (the auth.json
 *     admin password) or an admin/operator NextAuth session or named
 *     `elx_` key, resolved via resolveCallerIdentity.
 *
 * Readonly callers are refused. Use this async check in route handlers;
 * the sync isAuthorizedAdmin() below keeps only the token-env check and
 * fails closed when no token is configured (its old dev loopback bypass
 * and prod deny-all behavior are both gone).
 */
export async function isAuthorizedAdminAsync(req: Request): Promise<boolean> {
  const adminSecret =
    process.env.ELUVIX_ADMIN_TOKEN ||
    process.env.ENCLAVIX_ADMIN_TOKEN ||
    process.env.ADMIN_TOKEN;
  const authHeader = req.headers.get('authorization') || '';
  const token =
    authHeader.replace(/^Bearer\s+/i, '').trim() ||
    req.headers.get('x-admin-token') ||
    req.headers.get('x-enclavix-token') ||
    req.headers.get('x-eluvix-token') ||
    '';
  if (adminSecret && token) {
    if (token.length !== adminSecret.length) return false;
    if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(adminSecret))) {
      return true;
    }
  }

  const caller = await resolveCallerIdentity(req);
  return caller.ok && (caller.role === 'admin' || caller.role === 'operator');
}

export function isAuthorizedAdmin(req: Request): boolean {
  const adminSecret = process.env.ENCLAVIX_ADMIN_TOKEN || process.env.ELUVIX_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim() || req.headers.get('x-admin-token') || req.headers.get('x-enclavix-token') || req.headers.get('x-eluvix-token') || '';

  if (!adminSecret) {
    // Hunt-3 C-L3: no token configured means no token-based admin access,
    // in any environment — the old dev loopback bypass (any
    // credential-less localhost request counted as admin) is gone.
    return false;
  }
  if (!token || token.length !== adminSecret.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(adminSecret));
}
