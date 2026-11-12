import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAppPaths } from './paths.js';
import { recordAuditEvent } from './audit.js';
import {
  authenticateLdapUser,
  resolveLdapConfig,
  type EluvixRole,
  type LdapAuthResult,
} from './ldap.js';

export type { EluvixRole, LdapAuthConfig, LdapUserRecord, LdapAuthResult } from './ldap.js';
export { authenticateLdapUser, resolveLdapConfig, getLdapStatus } from './ldap.js';

export type ApiKeyScope =
  | 'chat'
  | 'embeddings'
  | 'audio'
  | 'mcp'
  | 'evals:live'
  | 'export'
  | 'admin:config'
  | 'batches'
  | 'rerank'
  | 'prompts'
  | 'webhooks'
  | '*';

export interface AuthConfig {
  adminPassword?: string;
  nextAuthSecret?: string;
  createdAt?: string;
}

export interface AuthConfigResult {
  adminPassword: string;
  nextAuthSecret: string;
  authFile: string;
  configDir: string;
  isNew: boolean;
}

/**
 * Generates a cryptographically secure random alphabetical string of specified length (default 24 letters)
 * without modulo bias.
 */
export function generateRandomLetters(length = 24): string {
  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += letters[crypto.randomInt(0, letters.length)];
  }
  return result;
}

/**
 * Ensures the XDG config and data directories exist. If an auth config does not exist,
 * generates a random 24-letter password and nextauth secret, writing it to auth.json.
 */
export function getOrCreateAuthConfig(appName = 'eluvix'): AuthConfigResult {
  const { configDir, dataDir } = getAppPaths(appName);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const authFile = path.join(configDir, 'auth.json');
  let authConfig: AuthConfig = {};
  let isNew = false;

  if (fs.existsSync(authFile)) {
    try {
      const raw = fs.readFileSync(authFile, 'utf8');
      authConfig = JSON.parse(raw);
    } catch {
      authConfig = {};
    }
  }

  if (!authConfig.adminPassword) {
    authConfig.adminPassword = generateRandomLetters(24);
    isNew = true;
  }

  if (!authConfig.nextAuthSecret) {
    authConfig.nextAuthSecret = crypto.randomBytes(32).toString('hex');
    isNew = true;
  }

  if (isNew) {
    authConfig.createdAt = new Date().toISOString();
    fs.writeFileSync(authFile, JSON.stringify(authConfig, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    });
  }

  const effectiveAdminPassword = process.env.ADMIN_PASSWORD || authConfig.adminPassword;
  const effectiveNextAuthSecret = process.env.NEXTAUTH_SECRET || authConfig.nextAuthSecret;

  // Do not mutate process.env.ADMIN_PASSWORD so disk rotations take effect
  if (!process.env.NEXTAUTH_SECRET && effectiveNextAuthSecret) {
    process.env.NEXTAUTH_SECRET = effectiveNextAuthSecret;
  }

  return {
    adminPassword: effectiveAdminPassword,
    nextAuthSecret: effectiveNextAuthSecret,
    authFile,
    configDir,
    isNew
  };
}

export interface NamedApiKey {
  id: string;
  /**
   * Returned in full (`elx_<32-letters>`) ONLY at creation time from `createNamedApiKey()`.
   * On disk in `keys.json` and when listed via `listNamedApiKeys()`, `key` is masked to `${keyPrefix}...`
   * while `keyHash` stores the SHA-256 hex digest of the raw key.
   */
  key: string;
  keyHash?: string;
  keyPrefix?: string;
  label: string;
  origin: 'client' | 'harness' | 'playground';
  userId: string;
  role?: EluvixRole;
  memoryProfile?: string;
  scopes?: ApiKeyScope[];
  expiresAt?: string;
  maxDailySpendUsd?: number;
  rpm?: number;
  createdAt: string;
}

export function hashApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

interface KeysFileCacheEntry {
  mtimeMs: number;
  keys: NamedApiKey[];
}

const keysFileCache = new Map<string, KeysFileCacheEntry>();
const keyRpmWindows = new Map<string, number[]>();

export function clearApiKeysCache(): void {
  keysFileCache.clear();
  keyRpmWindows.clear();
}

function getKeysFilePath(appName = 'eluvix'): string {
  const { configDir } = getAppPaths(appName);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return path.join(configDir, 'keys.json');
}

function writeKeysFileAtomic(keysFile: string, keys: NamedApiKey[]): void {
  const tmpFile = `${keysFile}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(keys, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpFile, keysFile);
  try {
    const stat = fs.statSync(keysFile);
    keysFileCache.set(keysFile, { mtimeMs: stat.mtimeMs, keys: keys.map((k) => ({ ...k })) });
  } catch {
    keysFileCache.delete(keysFile);
  }
}

/**
 * Loads `keys.json` with an `mtimeMs`-invalidated in-memory cache and automatically
 * migrates any legacy plaintext `elx_...` keys in place to `keyHash = sha256(key)` +
 * `keyPrefix` + masked `key = "${keyPrefix}..."`.
 */
export function listNamedApiKeys(appName = 'eluvix'): NamedApiKey[] {
  const keysFile = getKeysFilePath(appName);
  if (!fs.existsSync(keysFile)) {
    keysFileCache.delete(keysFile);
    return [];
  }
  try {
    const stat = fs.statSync(keysFile);
    const cached = keysFileCache.get(keysFile);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.keys.map((k) => ({ ...k }));
    }

    const parsed = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    if (!Array.isArray(parsed)) return [];

    let migratedCount = 0;
    const normalized: NamedApiKey[] = parsed.map((entry: any) => {
      const rawKey = typeof entry?.key === 'string' ? entry.key : '';
      const isPlaintextElx =
        rawKey.startsWith('elx_') &&
        !rawKey.endsWith('...') &&
        rawKey.length >= 12 &&
        !entry.keyHash;
      if (isPlaintextElx) {
        migratedCount += 1;
        const prefix = rawKey.slice(0, 8);
        return {
          ...entry,
          keyHash: hashApiKey(rawKey),
          keyPrefix: prefix,
          key: `${prefix}...`,
        };
      }
      return entry as NamedApiKey;
    });

    if (migratedCount > 0) {
      writeKeysFileAtomic(keysFile, normalized);
    } else {
      keysFileCache.set(keysFile, { mtimeMs: stat.mtimeMs, keys: normalized });
    }

    return normalized.map((k) => ({ ...k }));
  } catch {
    return [];
  }
}

export function createNamedApiKey(
  input: {
    label?: string;
    name?: string;
    origin?: 'client' | 'harness' | 'playground';
    userId?: string;
    role?: EluvixRole;
    memoryProfile?: string;
    scopes?: ApiKeyScope[];
    expiresAt?: string;
    maxDailySpendUsd?: number;
    rpm?: number;
    actorId?: string;
  },
  appName = 'eluvix'
): NamedApiKey {
  const keysFile = getKeysFilePath(appName);
  const keys = listNamedApiKeys(appName);
  const rawLabel = (input.label || input.name || 'API Key').trim() || 'API Key';
  const rawPlaintextKey = `elx_${generateRandomLetters(32)}`;
  const keyPrefix = rawPlaintextKey.slice(0, 8);
  const keyHash = hashApiKey(rawPlaintextKey);
  const createdAt = new Date().toISOString();

  const persistedRecord: NamedApiKey = {
    id: `key_${crypto.randomBytes(6).toString('hex')}`,
    key: `${keyPrefix}...`,
    keyHash,
    keyPrefix,
    label: rawLabel,
    origin: input.origin || 'client',
    userId: input.userId?.trim() || 'default',
    role: input.role || 'operator',
    memoryProfile: input.memoryProfile,
    ...(Array.isArray(input.scopes) && input.scopes.length > 0 ? { scopes: input.scopes } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(typeof input.maxDailySpendUsd === 'number' && input.maxDailySpendUsd > 0
      ? { maxDailySpendUsd: input.maxDailySpendUsd }
      : {}),
    ...(typeof input.rpm === 'number' && input.rpm > 0 ? { rpm: input.rpm } : {}),
    createdAt,
  };

  keys.push(persistedRecord);
  writeKeysFileAtomic(keysFile, keys);

  try {
    recordAuditEvent({
      actorId: input.actorId || input.userId || 'default',
      actorRole: input.role || 'admin',
      action: 'api_key.create',
      resourceType: 'api_key',
      resourceId: persistedRecord.id,
      details: {
        label: persistedRecord.label,
        keyPrefix,
        userId: persistedRecord.userId,
        role: persistedRecord.role,
        origin: persistedRecord.origin,
        scopes: persistedRecord.scopes || ['*'],
        expiresAt: persistedRecord.expiresAt || null,
      },
    });
  } catch {
    // Non-fatal if audit DB is unavailable
  }

  return {
    ...persistedRecord,
    key: rawPlaintextKey,
  };
}

export function revokeNamedApiKey(id: string, appName = 'eluvix', actorId = 'default'): boolean {
  const keysFile = getKeysFilePath(appName);
  const keys = listNamedApiKeys(appName);
  const target = keys.find((k) => k.id === id);
  const next = keys.filter((k) => k.id !== id);
  if (next.length === keys.length) return false;
  writeKeysFileAtomic(keysFile, next);
  keyRpmWindows.delete(id);

  try {
    recordAuditEvent({
      actorId,
      actorRole: 'admin',
      action: 'api_key.revoke',
      resourceType: 'api_key',
      resourceId: id,
      details: {
        label: target?.label || id,
        keyPrefix: target?.keyPrefix || null,
        userId: target?.userId || 'default',
      },
    });
  } catch {
    // Non-fatal
  }

  return true;
}

function checkKeySlidingWindowRpm(keyId: string, rpmLimit: number, nowMs: number): boolean {
  const windowStart = nowMs - 60_000;
  const existing = keyRpmWindows.get(keyId) || [];
  const active = existing.filter((ts) => ts > windowStart);
  if (active.length >= rpmLimit) {
    keyRpmWindows.set(keyId, active);
    return false;
  }
  active.push(nowMs);
  keyRpmWindows.set(keyId, active);
  return true;
}

export interface ResolveBearerTokenOptions {
  requiredScope?: ApiKeyScope;
  nowMs?: number;
  currentDailySpendUsd?: number;
  enforceRateLimit?: boolean;
}

export function resolveBearerToken(
  token: string,
  adminPasswordOrAppName?: string,
  appName = 'eluvix',
  options?: ResolveBearerTokenOptions
): {
  valid: boolean;
  reason?: 'invalid-key' | 'expired' | 'insufficient-scope' | 'rate-limited' | 'budget-exceeded';
  isAdmin?: boolean;
  userId: string;
  role?: EluvixRole;
  origin: 'client' | 'harness' | 'playground';
  keyId?: string;
  keyLabel?: string;
  scopes?: ApiKeyScope[];
  expiresAt?: string;
  maxDailySpendUsd?: number;
  rpm?: number;
} {
  if (!token) {
    return { valid: false, reason: 'invalid-key', userId: 'default', origin: 'client' };
  }
  const { adminPassword: storedAdminPassword } = getOrCreateAuthConfig(appName);
  const candidateAdmins = [storedAdminPassword];
  if (adminPasswordOrAppName && adminPasswordOrAppName !== appName) {
    candidateAdmins.push(adminPasswordOrAppName);
  }
  const a = Buffer.from(token);
  for (const cand of candidateAdmins) {
    if (!cand) continue;
    const b = Buffer.from(cand);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return {
        valid: true,
        isAdmin: true,
        userId: 'default',
        role: 'admin',
        origin: 'client',
        keyLabel: 'admin',
        scopes: ['*'],
      };
    }
  }

  const candidateHash = hashApiKey(token);
  const candidateHashBuf = Buffer.from(candidateHash, 'utf8');
  const keys = listNamedApiKeys(appName);
  const nowMs = options?.nowMs ?? Date.now();

  for (const entry of keys) {
    let matched = false;
    if (entry.keyHash) {
      const storedHashBuf = Buffer.from(entry.keyHash, 'utf8');
      if (
        candidateHashBuf.length === storedHashBuf.length &&
        crypto.timingSafeEqual(candidateHashBuf, storedHashBuf)
      ) {
        matched = true;
      }
    } else if (entry.key && !entry.key.endsWith('...')) {
      const kb = Buffer.from(entry.key);
      if (a.length === kb.length && crypto.timingSafeEqual(a, kb)) {
        matched = true;
      }
    }

    if (matched) {
      // 1. Check expiration
      if (entry.expiresAt) {
        const expMs = Date.parse(entry.expiresAt);
        if (Number.isFinite(expMs) && nowMs >= expMs) {
          return {
            valid: false,
            reason: 'expired',
            userId: entry.userId || 'default',
            role: entry.role || 'operator',
            origin: entry.origin || 'client',
            keyId: entry.id,
            keyLabel: entry.label,
            expiresAt: entry.expiresAt,
          };
        }
      }

      // 2. Check required scope
      if (
        options?.requiredScope &&
        Array.isArray(entry.scopes) &&
        entry.scopes.length > 0 &&
        !entry.scopes.includes('*') &&
        !entry.scopes.includes(options.requiredScope)
      ) {
        return {
          valid: false,
          reason: 'insufficient-scope',
          userId: entry.userId || 'default',
          role: entry.role || 'operator',
          origin: entry.origin || 'client',
          keyId: entry.id,
          keyLabel: entry.label,
          scopes: entry.scopes,
        };
      }

      // 3. Check per-key daily spend cap
      if (
        typeof entry.maxDailySpendUsd === 'number' &&
        entry.maxDailySpendUsd > 0 &&
        typeof options?.currentDailySpendUsd === 'number' &&
        options.currentDailySpendUsd >= entry.maxDailySpendUsd
      ) {
        return {
          valid: false,
          reason: 'budget-exceeded',
          userId: entry.userId || 'default',
          role: entry.role || 'operator',
          origin: entry.origin || 'client',
          keyId: entry.id,
          keyLabel: entry.label,
          maxDailySpendUsd: entry.maxDailySpendUsd,
        };
      }

      // 4. Check per-key sliding-window RPM rate limit
      if (
        options?.enforceRateLimit !== false &&
        typeof entry.rpm === 'number' &&
        entry.rpm > 0
      ) {
        const okRpm = checkKeySlidingWindowRpm(entry.id, entry.rpm, nowMs);
        if (!okRpm) {
          return {
            valid: false,
            reason: 'rate-limited',
            userId: entry.userId || 'default',
            role: entry.role || 'operator',
            origin: entry.origin || 'client',
            keyId: entry.id,
            keyLabel: entry.label,
            rpm: entry.rpm,
          };
        }
      }

      return {
        valid: true,
        isAdmin: entry.role === 'admin',
        userId: entry.userId || 'default',
        role: entry.role || 'operator',
        origin: entry.origin || 'client',
        keyId: entry.id,
        keyLabel: entry.label,
        scopes: entry.scopes,
        expiresAt: entry.expiresAt,
        maxDailySpendUsd: entry.maxDailySpendUsd,
        rpm: entry.rpm,
      };
    }
  }

  return { valid: false, reason: 'invalid-key', userId: 'default', origin: 'client' };
}

/**
 * Unified credential authenticator supporting both LDAP and local break-glass admin.
 */
export async function authenticateEluvixCredentials(
  username?: string,
  password?: string,
  appName = 'eluvix'
): Promise<LdapAuthResult> {
  const trimmedUser = (username || '').trim();
  const trimmedPass = password || '';

  if (!trimmedPass) {
    return { authenticated: false, error: 'Password is required' };
  }

  const { adminPassword: storedAdminPassword } = getOrCreateAuthConfig(appName);
  const candidateAdmins = [storedAdminPassword];
  if (process.env.ADMIN_PASSWORD) candidateAdmins.push(process.env.ADMIN_PASSWORD);
  if (process.env.LEGACY_ADMIN_PASSWORD) candidateAdmins.push(process.env.LEGACY_ADMIN_PASSWORD);

  const isLocalAdminPass = candidateAdmins.some((cand) => {
    if (!cand) return false;
    const a = Buffer.from(trimmedPass);
    const b = Buffer.from(cand);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });

  const ldapConfig = resolveLdapConfig(undefined, appName);

  // 1. Local admin check if username is blank or explicitly admin/local
  if (!trimmedUser || trimmedUser.toLowerCase() === 'admin' || trimmedUser.toLowerCase() === 'local') {
    if (isLocalAdminPass) {
      if (ldapConfig.enabled && !ldapConfig.allowLocalBreakGlass) {
        return {
          authenticated: false,
          error: 'Local break-glass administrator login is disabled by policy',
        };
      }
      return {
        authenticated: true,
        userId: 'default',
        username: 'admin',
        displayName: 'Local Administrator',
        role: 'admin',
        groups: ['local-admin', 'break-glass'],
        authSource: 'local',
      };
    }
  }

  // 2. If LDAP is enabled and a username was provided, attempt LDAP authentication
  if (ldapConfig.enabled && trimmedUser) {
    const ldapRes = await authenticateLdapUser(trimmedUser, trimmedPass, ldapConfig, appName);
    if (ldapRes.authenticated) {
      return ldapRes;
    }
    // If LDAP failed, but caller used admin/local with local admin pass and break-glass is allowed
    if (
      isLocalAdminPass &&
      ldapConfig.allowLocalBreakGlass &&
      (trimmedUser.toLowerCase() === 'admin' || trimmedUser.toLowerCase() === 'local')
    ) {
      return {
        authenticated: true,
        userId: 'default',
        username: 'admin',
        displayName: 'Local Administrator (Break-Glass)',
        role: 'admin',
        groups: ['local-admin', 'break-glass'],
        authSource: 'local',
      };
    }
    return ldapRes;
  }

  // 3. Fallback when LDAP is disabled: verify local admin password
  if (isLocalAdminPass) {
    return {
      authenticated: true,
      userId: 'default',
      username: trimmedUser || 'admin',
      displayName: 'Local Administrator',
      role: 'admin',
      groups: ['local-admin'],
      authSource: 'local',
    };
  }

  return { authenticated: false, error: 'Invalid username or password' };
}


