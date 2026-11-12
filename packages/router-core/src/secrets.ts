import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getAppPaths } from './paths.js';
import { validateUpstreamHttpEndpoint } from './ssrf-guard.js';

export type SecretReferenceScheme = 'env' | 'file' | 'bao' | 'vault' | 'keychain' | 'literal';

interface CachedSecretEntry {
  value: string;
  expiresAtMs: number;
}

const secretCache = new Map<string, CachedSecretEntry>();
const DEFAULT_SECRET_CACHE_TTL_MS = 60_000;

export function clearSecretReferenceCache(): void {
  secretCache.clear();
}

/**
 * Classifies whether a credential string is a Secret Reference URI (`env:`, `file:`,
 * `bao:`, `vault:`, `keychain:`) or a raw literal string.
 */
export function parseSecretReference(raw?: string | null): {
  scheme: SecretReferenceScheme;
  target: string;
  field?: string;
} {
  if (!raw || typeof raw !== 'string') {
    return { scheme: 'literal', target: '' };
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('env:')) {
    return { scheme: 'env', target: trimmed.slice(4).trim() };
  }
  if (trimmed.startsWith('file:')) {
    return { scheme: 'file', target: trimmed.slice(5).trim() };
  }
  if (trimmed.startsWith('bao:') || trimmed.startsWith('vault:')) {
    const rest = trimmed.replace(/^(?:bao|vault):/, '').trim();
    const hashIdx = rest.indexOf('#');
    if (hashIdx !== -1) {
      return {
        scheme: trimmed.startsWith('bao:') ? 'bao' : 'vault',
        target: rest.slice(0, hashIdx).trim(),
        field: rest.slice(hashIdx + 1).trim() || 'api_key',
      };
    }
    return {
      scheme: trimmed.startsWith('bao:') ? 'bao' : 'vault',
      target: rest,
      field: 'api_key',
    };
  }
  if (trimmed.startsWith('keychain:')) {
    return { scheme: 'keychain', target: trimmed.slice(9).trim() };
  }
  return { scheme: 'literal', target: trimmed };
}

export function isSecretReference(raw?: string | null): boolean {
  return parseSecretReference(raw).scheme !== 'literal';
}

/**
 * Masks literal API keys for safe API/UI display while preserving Secret Reference URIs
 * (`env:OPENAI_API_KEY`, `bao:secret/data/llm#openai`, `keychain:eluvix/openai`) verbatim
 * so operators can inspect which reference is bound without ever exposing the resolved secret.
 */
export function maskSecretOrReferenceForDisplay(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const parsed = parseSecretReference(raw);
  if (parsed.scheme !== 'literal') {
    return raw.trim();
  }
  const val = parsed.target;
  if (val.length <= 8) return '••••••••';
  return `${val.slice(0, 6)}...${val.slice(-4)}`;
}

/**
 * Synchronously resolves `env:`, `file:`, `keychain:`, or cached `bao:`/`vault:` secret references.
 */
export function resolveUpstreamSecretSync(
  raw?: string | null,
  options?: {
    appName?: string;
    nowMs?: number;
    ttlMs?: number;
    keychainRunner?: (service: string, account: string) => string | undefined;
  }
): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const parsed = parseSecretReference(raw);
  if (parsed.scheme === 'literal') {
    return parsed.target || undefined;
  }

  const nowMs = options?.nowMs ?? Date.now();
  const ttlMs = options?.ttlMs ?? DEFAULT_SECRET_CACHE_TTL_MS;
  const cacheKey = raw.trim();
  const cached = secretCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.value;
  }

  if (parsed.scheme === 'env') {
    const varName = parsed.target;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      return undefined;
    }
    const envVal = process.env[varName];
    return envVal ? envVal.trim() : undefined;
  }

  if (parsed.scheme === 'file') {
    const { configDir } = getAppPaths(options?.appName || 'eluvix');
    const resolvedBase = path.resolve(configDir);
    const candidatePath = path.isAbsolute(parsed.target)
      ? path.resolve(parsed.target)
      : path.resolve(resolvedBase, parsed.target);
    // Restrict relative or config-scoped secret files to configDir to prevent arbitrary file reads
    if (
      !candidatePath.startsWith(resolvedBase + path.sep) &&
      candidatePath !== resolvedBase
    ) {
      return undefined;
    }
    try {
      if (!fs.existsSync(candidatePath)) return undefined;
      const val = fs.readFileSync(candidatePath, 'utf8').trim();
      if (val) {
        secretCache.set(cacheKey, { value: val, expiresAtMs: nowMs + ttlMs });
      }
      return val || undefined;
    } catch {
      return undefined;
    }
  }

  if (parsed.scheme === 'keychain') {
    const slashIdx = parsed.target.indexOf('/');
    const service = (slashIdx !== -1 ? parsed.target.slice(0, slashIdx) : 'eluvix').trim();
    const account = (slashIdx !== -1 ? parsed.target.slice(slashIdx + 1) : parsed.target).trim();
    if (!service || !account || !/^[A-Za-z0-9_.:@-]+$/.test(service) || !/^[A-Za-z0-9_.:@-]+$/.test(account)) {
      return undefined;
    }
    try {
      let secretVal: string | undefined;
      if (options?.keychainRunner) {
        secretVal = options.keychainRunner(service, account);
      } else if (process.platform === 'darwin') {
        secretVal = execFileSync(
          'security',
          ['find-generic-password', '-s', service, '-a', account, '-w'],
          { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
      } else {
        secretVal = execFileSync(
          'secret-tool',
          ['lookup', 'service', service, 'account', account],
          { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
      }
      if (secretVal) {
        secretCache.set(cacheKey, { value: secretVal, expiresAtMs: nowMs + ttlMs });
        return secretVal;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Asynchronously resolves any Secret Reference (`env:`, `file:`, `keychain:`, `bao:`, `vault:`)
 * with in-memory TTL caching and SSRF protection on OpenBao / HashiCorp Vault endpoints.
 */
export async function resolveUpstreamSecret(
  raw?: string | null,
  options?: {
    appName?: string;
    nowMs?: number;
    ttlMs?: number;
    fetchImpl?: typeof fetch;
    baoAddr?: string;
    baoToken?: string;
    keychainRunner?: (service: string, account: string) => string | undefined;
  }
): Promise<string | undefined> {
  if (!raw || typeof raw !== 'string') return undefined;
  const parsed = parseSecretReference(raw);
  if (parsed.scheme !== 'bao' && parsed.scheme !== 'vault') {
    return resolveUpstreamSecretSync(raw, options);
  }

  const nowMs = options?.nowMs ?? Date.now();
  const ttlMs = options?.ttlMs ?? DEFAULT_SECRET_CACHE_TTL_MS;
  const cacheKey = raw.trim();
  const cached = secretCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.value;
  }

  const baseAddr = (
    options?.baoAddr ||
    process.env.BAO_ADDR ||
    process.env.VAULT_ADDR ||
    ''
  )
    .trim()
    .replace(/\/+$/, '');
  const token = (
    options?.baoToken ||
    process.env.BAO_TOKEN ||
    process.env.VAULT_TOKEN ||
    ''
  ).trim();

  if (!baseAddr || !token || !parsed.target) {
    return undefined;
  }

  const cleanPath = parsed.target.replace(/^\/+/, '').replace(/^v1\//, '');
  const fullUrl = `${baseAddr}/v1/${cleanPath}`;
  const ssrf = validateUpstreamHttpEndpoint(fullUrl, { allowLoopbackAndLan: true });
  if (!ssrf.ok) {
    return undefined;
  }

  const fetchFn = options?.fetchImpl || globalThis.fetch;
  try {
    const res = await fetchFn(fullUrl, {
      method: 'GET',
      headers: {
        'X-Vault-Token': token,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as Record<string, any>;
    // Support both KV v2 (`data.data[field]`) and KV v1 (`data[field]`)
    const fieldName = parsed.field || 'api_key';
    const val =
      json?.data?.data?.[fieldName] ??
      json?.data?.[fieldName] ??
      undefined;
    if (typeof val === 'string' && val.trim()) {
      const trimmed = val.trim();
      secretCache.set(cacheKey, { value: trimmed, expiresAtMs: nowMs + ttlMs });
      return trimmed;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
