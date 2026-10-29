import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAppPaths } from './paths.js';
import {
  authenticateLdapUser,
  resolveLdapConfig,
  type EluvixRole,
  type LdapAuthResult,
} from './ldap.js';

export type { EluvixRole, LdapAuthConfig, LdapUserRecord, LdapAuthResult } from './ldap.js';
export { authenticateLdapUser, resolveLdapConfig, getLdapStatus } from './ldap.js';

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

  // Propagate to process.env so dependent submodules have immediate access
  process.env.ADMIN_PASSWORD = effectiveAdminPassword;
  process.env.NEXTAUTH_SECRET = effectiveNextAuthSecret;

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
  key: string;
  label: string;
  origin: 'client' | 'harness' | 'playground';
  userId: string;
  role?: EluvixRole;
  memoryProfile?: string;
  createdAt: string;
}

function getKeysFilePath(appName = 'eluvix'): string {
  const { configDir } = getAppPaths(appName);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return path.join(configDir, 'keys.json');
}

export function listNamedApiKeys(appName = 'eluvix'): NamedApiKey[] {
  const keysFile = getKeysFilePath(appName);
  if (!fs.existsSync(keysFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
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
  },
  appName = 'eluvix'
): NamedApiKey {
  const keysFile = getKeysFilePath(appName);
  const keys = listNamedApiKeys(appName);
  const rawLabel = (input.label || input.name || 'API Key').trim() || 'API Key';
  const newKey: NamedApiKey = {
    id: `key_${crypto.randomBytes(6).toString('hex')}`,
    key: `elx_${generateRandomLetters(32)}`,
    label: rawLabel,
    origin: input.origin || 'client',
    userId: input.userId?.trim() || 'default',
    role: input.role || 'operator',
    memoryProfile: input.memoryProfile,
    createdAt: new Date().toISOString()
  };
  keys.push(newKey);
  fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2), { encoding: 'utf8', mode: 0o600 });
  return newKey;
}

export function revokeNamedApiKey(id: string, appName = 'eluvix'): boolean {
  const keysFile = getKeysFilePath(appName);
  const keys = listNamedApiKeys(appName);
  const next = keys.filter(k => k.id !== id);
  if (next.length === keys.length) return false;
  fs.writeFileSync(keysFile, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  return true;
}

export function resolveBearerToken(
  token: string,
  adminPasswordOrAppName?: string,
  appName = 'eluvix'
): {
  valid: boolean;
  isAdmin?: boolean;
  userId: string;
  role?: EluvixRole;
  origin: 'client' | 'harness' | 'playground';
  keyLabel?: string;
} {
  if (!token) {
    return { valid: false, userId: 'default', origin: 'client' };
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
        keyLabel: 'admin'
      };
    }
  }

  const keys = listNamedApiKeys(appName);
  for (const entry of keys) {
    const kb = Buffer.from(entry.key);
    if (a.length === kb.length && crypto.timingSafeEqual(a, kb)) {
      return {
        valid: true,
        isAdmin: entry.role === 'admin',
        userId: entry.userId || 'default',
        role: entry.role || 'operator',
        origin: entry.origin || 'client',
        keyLabel: entry.label
      };
    }
  }

  return { valid: false, userId: 'default', origin: 'client' };
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


