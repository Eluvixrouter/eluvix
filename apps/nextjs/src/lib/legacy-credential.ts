import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAppPaths } from '@eluvix/router-core';

/**
 * Legacy Enclavix credential migration (audit L-4, decision D6).
 *
 * Pre-rename installs stored their admin password at
 * ~/.config/enclavix/auth.json; server.mjs still loads it and exports it
 * as LEGACY_ADMIN_PASSWORD, where the middleware accepts it as a bearer
 * token. That dual-credential state is deprecated: it is honored for this
 * release WITH a startup warning, and removed in the next.
 *
 * Migration is login-driven: the first time the operator signs in with
 * the legacy password (proving they know it), it becomes the current
 * password — written into the current auth.json (mode 0o600) — and every
 * legacy auth.json on disk is renamed to `auth.json.migrated`, so future
 * server starts no longer load it and the env var disappears.
 */

export interface LegacyMigrationResult {
  /** True when the migration completed and the legacy credential is retired. */
  retired: boolean;
  detail: string;
}

function legacyAuthFileCandidates(): string[] {
  const candidates = new Set<string>();
  // The exact path server.mjs loads from:
  candidates.add(path.join(os.homedir(), '.config', 'enclavix', 'auth.json'));
  // The XDG-shaped path, for installs that set XDG_CONFIG_HOME:
  try {
    candidates.add(path.join(getAppPaths('enclavix').configDir, 'auth.json'));
  } catch {}
  return Array.from(candidates);
}

export function migrateLegacyCredential(legacyPassword: string): LegacyMigrationResult {
  try {
    const { configDir } = getAppPaths('eluvix');
    const currentAuthFile = path.join(configDir, 'auth.json');

    let current: Record<string, unknown> = {};
    if (fs.existsSync(currentAuthFile)) {
      try {
        current = JSON.parse(fs.readFileSync(currentAuthFile, 'utf8'));
      } catch {
        current = {};
      }
    }
    current.adminPassword = legacyPassword;

    const tmpPath = `${currentAuthFile}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, currentAuthFile);
    try {
      fs.chmodSync(currentAuthFile, 0o600);
    } catch {}

    // getOrCreateAuthConfig() propagated the OLD password into
    // process.env.ADMIN_PASSWORD at startup, and that variable shadows
    // the file value for the authorize() check — update it so the
    // migrated password is the effective one immediately, not only
    // after a restart.
    process.env.ADMIN_PASSWORD = legacyPassword;

    const renamed: string[] = [];
    const failures: string[] = [];
    for (const legacyFile of legacyAuthFileCandidates()) {
      // Never rename the CURRENT auth file if the paths coincide.
      if (path.resolve(legacyFile) === path.resolve(currentAuthFile)) continue;
      if (!fs.existsSync(legacyFile)) continue;
      try {
        fs.renameSync(legacyFile, `${legacyFile}.migrated`);
        renamed.push(legacyFile);
      } catch (err: any) {
        failures.push(`${legacyFile}: ${err.message}`);
      }
    }

    // The env var must stop being honored in this process too — the
    // login just proved the credential and it is now the current one.
    delete process.env.LEGACY_ADMIN_PASSWORD;

    if (failures.length > 0) {
      return {
        retired: false,
        detail:
          `Password copied into the current auth config, but renaming the legacy file failed (${failures.join('; ')}). ` +
          'The legacy credential remains active for this process; rename or delete the file manually to complete the migration.'
      };
    }
    return {
      retired: true,
      detail:
        renamed.length > 0
          ? `Legacy credential migrated: it is now the current admin password and ${renamed.join(', ')} was renamed to .migrated.`
          : 'Legacy credential migrated: it is now the current admin password (no legacy auth.json file found on disk).'
    };
  } catch (err: any) {
    return {
      retired: false,
      detail:
        `Legacy credential accepted, but migration failed (${err.message}). ` +
        'The legacy credential remains active; the migration will be retried on the next legacy login.'
    };
  }
}
