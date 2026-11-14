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

export function isAuthorizedAdmin(req: Request): boolean {
  const adminSecret = process.env.ENCLAVIX_ADMIN_TOKEN || process.env.ELUVIX_ADMIN_TOKEN || process.env.ADMIN_TOKEN;
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim() || req.headers.get('x-admin-token') || req.headers.get('x-enclavix-token') || req.headers.get('x-eluvix-token') || '';

  if (adminSecret) {
    if (!token || token.length !== adminSecret.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(adminSecret));
  }

  // In production, an admin token is strictly required
  if (process.env.NODE_ENV === 'production') {
    return false;
  }

  // In development, allow local loopback requests
  const host = req.headers.get('host') || '';
  return host.startsWith('localhost') || host.startsWith('127.0.0.1');
}
