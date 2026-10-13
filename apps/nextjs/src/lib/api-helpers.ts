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

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  // IPv4 checks
  const ipv4Match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 10.0.0.0/8 (private)
    if (a === 10) return true;
    // 172.16.0.0/12 (private)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (private)
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
  }

  // IPv6 link-local / unique local
  if (host.startsWith('fe80:') || host.startsWith('fc00:') || host.startsWith('fd00:')) {
    return true;
  }

  return false;
}

export function normalizeProbeUrl(endpoint: string, type: string): string {
  const trimmed = (endpoint || '').trim().replace(/\/+$/, '');
  const baseWithoutV1 = trimmed.replace(/\/v1$/, '');

  if (type === 'ollama') {
    return `${baseWithoutV1}/api/tags`;
  }
  if (type === 'lemonade' || type === 'openai-compatible' || type === 'vllm' || type === 'vllm-sr') {
    return `${baseWithoutV1}/v1/models`;
  }
  return trimmed;
}

export const ALLOWED_DOCKER_SERVICES = new Set([
  'switchyard',
  'vllm-sr',
  'ollama',
  'vllm',
  'agent-router',
  'agentgateway',
  'lemonade',
  'router'
]);

export function isValidContainerName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  const trimmed = name.trim().toLowerCase();
  return ALLOWED_DOCKER_SERVICES.has(trimmed) || /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(trimmed);
}
