import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getAppPaths } from './paths.js';

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
