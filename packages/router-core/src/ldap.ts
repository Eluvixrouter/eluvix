import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'ldapts';
import { getAppPaths } from './paths.js';

export type EluvixRole = 'admin' | 'operator' | 'readonly';

export interface LdapAuthConfig {
  enabled: boolean;
  autoBindLocalLdap: boolean;
  allowLocalBreakGlass: boolean;
  url: string;
  baseDn: string;
  bindDn?: string;
  bindPassword?: string;
  userSearchBase?: string;
  userSearchFilter?: string;
  groupSearchBase?: string;
  groupSearchFilter?: string;
  adminGroups: string[];
  operatorGroups: string[];
  readonlyGroups: string[];
  defaultRole: 'admin' | 'operator' | 'readonly' | 'none';
  timeoutMs?: number;
}

export interface LdapUserRecord {
  dn: string;
  username: string;
  displayName?: string;
  email?: string;
  groups: string[];
  role: EluvixRole;
  locked?: boolean;
}

export interface LdapAuthResult {
  authenticated: boolean;
  userId?: string; // e.g. "ldap:alice" or "default"
  username?: string;
  displayName?: string;
  email?: string;
  dn?: string;
  groups?: string[];
  role?: EluvixRole;
  authSource?: 'ldap' | 'local';
  error?: string;
}

/**
 * Escapes special characters in LDAP filter assertions per RFC 4515.
 */
export function escapeLdapFilter(str: string): string {
  return str.replace(/[*()\\\x00]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/**
 * Escapes special characters in LDAP Distinguished Names per RFC 4514.
 */
export function escapeLdapDn(str: string): string {
  return str.replace(/[,+"\\<>;#=]/g, (c) => '\\' + c);
}

const DEFAULT_LDAP_CONFIG: LdapAuthConfig = {
  enabled: false,
  autoBindLocalLdap: true,
  allowLocalBreakGlass: true,
  url: 'ldap://127.0.0.1:389',
  baseDn: 'dc=axonwall,dc=local',
  adminGroups: ['axonwall-admin', 'eluvix-admin'],
  operatorGroups: ['axonwall-operator', 'eluvix-operator'],
  readonlyGroups: ['axonwall-readonly', 'eluvix-readonly'],
  defaultRole: 'readonly',
  timeoutMs: 5000,
};

/**
 * Resolves the effective LDAP configuration by inspecting:
 * 1. Explicit override passed by caller.
 * 2. ELUVIX_CONFIG or /etc/axonwall/eluvix/eluvix.json (auth.ldap).
 * 3. Axonwall managed plugin binding file (/etc/axonwall/ldap-plugins/eluvix.json).
 * 4. Local ~/.config/eluvix/auth.json (ldap block).
 * 5. Environment variables (ELUVIX_LDAP_*).
 */
export function resolveLdapConfig(override?: Partial<LdapAuthConfig>, appName = 'eluvix'): LdapAuthConfig {
  let resolved: LdapAuthConfig = { ...DEFAULT_LDAP_CONFIG };

  // 1. Check Axonwall Plugin LDAP binding file (/etc/axonwall/ldap-plugins/eluvix.json or ELUVIX_LDAP_BINDING_FILE)
  const bindingFile =
    process.env.ELUVIX_LDAP_BINDING_FILE ||
    '/etc/axonwall/ldap-plugins/eluvix.json';
  if (fs.existsSync(bindingFile)) {
    try {
      const bindingRaw = fs.readFileSync(bindingFile, 'utf8');
      const binding = JSON.parse(bindingRaw);
      if (binding && typeof binding === 'object') {
        resolved.enabled = binding.enabled !== false;
        if (binding.url) resolved.url = binding.url;
        if (binding.baseDn) resolved.baseDn = binding.baseDn;
        if (binding.bindDn) resolved.bindDn = binding.bindDn;
        if (binding.bindPassword) resolved.bindPassword = binding.bindPassword;
        if (binding.userSearchBase) resolved.userSearchBase = binding.userSearchBase;
        if (binding.groupSearchBase) resolved.groupSearchBase = binding.groupSearchBase;
        if (binding.userSearchFilter) resolved.userSearchFilter = binding.userSearchFilter;
        if (binding.groupSearchFilter) resolved.groupSearchFilter = binding.groupSearchFilter;
        if (binding.roleGroups) {
          if (Array.isArray(binding.roleGroups.admin)) resolved.adminGroups = binding.roleGroups.admin;
          if (Array.isArray(binding.roleGroups.operator)) resolved.operatorGroups = binding.roleGroups.operator;
          if (Array.isArray(binding.roleGroups.readonly)) resolved.readonlyGroups = binding.roleGroups.readonly;
        }
      }
    } catch {
      // Ignore parse failure on binding file
    }
  }

  // 2. Check ELUVIX_CONFIG or /etc/axonwall/eluvix/eluvix.json
  const eluvixConfigFile = process.env.ELUVIX_CONFIG || '/etc/axonwall/eluvix/eluvix.json';
  if (fs.existsSync(eluvixConfigFile)) {
    try {
      const eluvixConfigRaw = fs.readFileSync(eluvixConfigFile, 'utf8');
      const eluvixConfig = JSON.parse(eluvixConfigRaw);
      const ldapBlock = eluvixConfig?.auth?.ldap;
      if (ldapBlock && typeof ldapBlock === 'object') {
        if (typeof ldapBlock.enabled === 'boolean') resolved.enabled = ldapBlock.enabled;
        if (typeof ldapBlock.autoBindLocalLdap === 'boolean') resolved.autoBindLocalLdap = ldapBlock.autoBindLocalLdap;
        if (typeof ldapBlock.allowLocalBreakGlass === 'boolean') resolved.allowLocalBreakGlass = ldapBlock.allowLocalBreakGlass;
        if (ldapBlock.url) resolved.url = ldapBlock.url;
        if (ldapBlock.baseDn) resolved.baseDn = ldapBlock.baseDn;
        if (ldapBlock.bindDn) resolved.bindDn = ldapBlock.bindDn;
        if (ldapBlock.bindPassword) resolved.bindPassword = ldapBlock.bindPassword;
        if (ldapBlock.userSearchBase) resolved.userSearchBase = ldapBlock.userSearchBase;
        if (ldapBlock.groupSearchBase) resolved.groupSearchBase = ldapBlock.groupSearchBase;
        if (Array.isArray(ldapBlock.adminGroups)) resolved.adminGroups = ldapBlock.adminGroups;
        if (Array.isArray(ldapBlock.operatorGroups)) resolved.operatorGroups = ldapBlock.operatorGroups;
        if (Array.isArray(ldapBlock.readonlyGroups)) resolved.readonlyGroups = ldapBlock.readonlyGroups;
        if (ldapBlock.defaultRole) resolved.defaultRole = ldapBlock.defaultRole;
      }
    } catch {
      // Ignore parse failure on eluvix config file
    }
  }

  // 3. Check ~/.config/eluvix/auth.json
  const { configDir } = getAppPaths(appName);
  const localAuthFile = path.join(configDir, 'auth.json');
  if (fs.existsSync(localAuthFile)) {
    try {
      const localAuthRaw = fs.readFileSync(localAuthFile, 'utf8');
      const localAuth = JSON.parse(localAuthRaw);
      if (localAuth?.ldap && typeof localAuth.ldap === 'object') {
        resolved = { ...resolved, ...localAuth.ldap };
      }
    } catch {
      // Ignore parse failure
    }
  }

  // 4. Check Environment variables
  if (process.env.ELUVIX_LDAP_ENABLED !== undefined) {
    resolved.enabled = process.env.ELUVIX_LDAP_ENABLED === 'true' || process.env.ELUVIX_LDAP_ENABLED === '1';
  }
  if (process.env.ELUVIX_LDAP_URL) resolved.url = process.env.ELUVIX_LDAP_URL;
  if (process.env.ELUVIX_LDAP_BASE_DN) resolved.baseDn = process.env.ELUVIX_LDAP_BASE_DN;
  if (process.env.ELUVIX_LDAP_BIND_DN) resolved.bindDn = process.env.ELUVIX_LDAP_BIND_DN;
  if (process.env.ELUVIX_LDAP_BIND_PASSWORD) resolved.bindPassword = process.env.ELUVIX_LDAP_BIND_PASSWORD;
  if (process.env.ELUVIX_LDAP_USER_SEARCH_BASE) resolved.userSearchBase = process.env.ELUVIX_LDAP_USER_SEARCH_BASE;
  if (process.env.ELUVIX_LDAP_GROUP_SEARCH_BASE) resolved.groupSearchBase = process.env.ELUVIX_LDAP_GROUP_SEARCH_BASE;
  if (process.env.ELUVIX_LDAP_ADMIN_GROUPS) {
    resolved.adminGroups = process.env.ELUVIX_LDAP_ADMIN_GROUPS.split(',').map((g) => g.trim()).filter(Boolean);
  }
  if (process.env.ELUVIX_LDAP_OPERATOR_GROUPS) {
    resolved.operatorGroups = process.env.ELUVIX_LDAP_OPERATOR_GROUPS.split(',').map((g) => g.trim()).filter(Boolean);
  }
  if (process.env.ELUVIX_LDAP_READONLY_GROUPS) {
    resolved.readonlyGroups = process.env.ELUVIX_LDAP_READONLY_GROUPS.split(',').map((g) => g.trim()).filter(Boolean);
  }
  if (process.env.ELUVIX_LDAP_ALLOW_BREAK_GLASS !== undefined) {
    resolved.allowLocalBreakGlass =
      process.env.ELUVIX_LDAP_ALLOW_BREAK_GLASS !== 'false' && process.env.ELUVIX_LDAP_ALLOW_BREAK_GLASS !== '0';
  }

  // 5. Apply caller overrides
  if (override) {
    resolved = { ...resolved, ...override };
  }

  // Ensure default sub-bases if not explicitly given
  if (!resolved.userSearchBase) {
    resolved.userSearchBase = `ou=users,${resolved.baseDn}`;
  }
  if (!resolved.groupSearchBase) {
    resolved.groupSearchBase = `ou=groups,${resolved.baseDn}`;
  }

  return resolved;
}

/**
 * Returns summary LDAP connectivity info for status reporting and UI badges.
 */
export function getLdapStatus(override?: Partial<LdapAuthConfig>, appName = 'eluvix') {
  const config = resolveLdapConfig(override, appName);
  return {
    enabled: config.enabled,
    url: config.url,
    baseDn: config.baseDn,
    allowLocalBreakGlass: config.allowLocalBreakGlass,
    serviceAccount: config.bindDn || 'anonymous',
  };
}

/**
 * Maps resolved group names to an EluvixRole with precedence: admin > operator > readonly.
 */
export function mapGroupsToRole(
  groups: string[],
  config: Pick<LdapAuthConfig, 'adminGroups' | 'operatorGroups' | 'readonlyGroups' | 'defaultRole'>
): EluvixRole | null {
  const normalizedGroups = new Set(groups.map((g) => g.toLowerCase().trim()));

  const isAdmin = config.adminGroups.some((ag) => normalizedGroups.has(ag.toLowerCase().trim()));
  if (isAdmin) return 'admin';

  const isOperator = config.operatorGroups.some((og) => normalizedGroups.has(og.toLowerCase().trim()));
  if (isOperator) return 'operator';

  const isReadonly = config.readonlyGroups.some((rg) => normalizedGroups.has(rg.toLowerCase().trim()));
  if (isReadonly) return 'readonly';

  if (config.defaultRole === 'none') {
    return null;
  }
  return config.defaultRole;
}

/**
 * Authenticates a user against OpenLDAP:
 * 1. Simple bind as service account (or direct bind if no service account).
 * 2. Search for user by uid.
 * 3. Check for account lockout attribute (pwdAccountLockedTime).
 * 4. Simple bind as user DN with the user's password.
 * 5. Query user's POSIX and groupOfNames groups.
 * 6. Map group membership to an Eluvix RBAC role.
 */
export async function authenticateLdapUser(
  username: string,
  password: string,
  configOverride?: Partial<LdapAuthConfig>,
  appName = 'eluvix'
): Promise<LdapAuthResult> {
  const trimmedUser = (username || '').trim();
  if (!trimmedUser || !password) {
    return { authenticated: false, error: 'Username and password are required' };
  }

  const config = resolveLdapConfig(configOverride, appName);
  if (!config.enabled) {
    return { authenticated: false, error: 'LDAP authentication is not enabled' };
  }

  const client = new Client({
    url: config.url,
    timeout: config.timeoutMs || 5000,
    connectTimeout: config.timeoutMs || 5000,
  });

  try {
    // Step 1: Bind as service account if configured
    if (config.bindDn && config.bindPassword) {
      await client.bind(config.bindDn, config.bindPassword);
    }

    // Step 2: Search for user entry
    const safeUser = escapeLdapFilter(trimmedUser);
    const searchFilter = (config.userSearchFilter || '(uid={username})').replaceAll('{username}', () => safeUser);

    const searchRes = await client.search(config.userSearchBase || config.baseDn, {
      filter: searchFilter,
      scope: 'sub',
      attributes: [
        'dn',
        'uid',
        'cn',
        'displayName',
        'mail',
        'gidNumber',
        'pwdAccountLockedTime',
        'memberOf',
      ],
    });

    if (searchRes.searchEntries.length === 0) {
      return { authenticated: false, error: 'User not found in directory' };
    }

    const userEntry = searchRes.searchEntries[0];
    const userDn = userEntry.dn;

    // Step 3: Check account lockout
    if (userEntry.pwdAccountLockedTime) {
      const lockedTime = String(userEntry.pwdAccountLockedTime);
      if (lockedTime && lockedTime !== '000001010000Z') {
        return { authenticated: false, error: 'Account is locked by password policy' };
      }
    }

    // Step 4: Simple bind as the target user to verify password
    const userClient = new Client({
      url: config.url,
      timeout: config.timeoutMs || 5000,
      connectTimeout: config.timeoutMs || 5000,
    });

    try {
      await userClient.bind(userDn, password);
    } catch {
      return { authenticated: false, error: 'Invalid username or password' };
    } finally {
      await userClient.unbind().catch(() => {});
    }

    // Step 5: Resolve groups
    const resolvedGroups: string[] = [];

    // Check memberOf attributes on user entry (RFC 2307bis / Active Directory / OpenLDAP memberof overlay)
    if (userEntry.memberOf) {
      const raw = Array.isArray(userEntry.memberOf) ? userEntry.memberOf : [userEntry.memberOf];
      for (const m of raw) {
        const trimmed = String(m).trim();
        const match = /^cn=([^,]+)/i.exec(trimmed);
        if (match && match[1]) {
          resolvedGroups.push(match[1]);
        } else {
          resolvedGroups.push(trimmed);
        }
      }
    }

    // Query POSIX groups (posixGroup: memberUid=<uid>) and groupOfNames (member=<dn>)
    const resolvedUid = userEntry.uid ? String(userEntry.uid) : trimmedUser;
    const safeUid = escapeLdapFilter(resolvedUid);
    const safeUserDn = escapeLdapFilter(userDn);
    const groupFilter = `(|(&(objectClass=posixGroup)(memberUid=${safeUid}))(&(objectClass=groupOfNames)(member=${safeUserDn})))`;

    try {
      const groupRes = await client.search(config.groupSearchBase || config.baseDn, {
        filter: groupFilter,
        scope: 'sub',
        attributes: ['cn'],
      });
      for (const entry of groupRes.searchEntries) {
        if (entry.cn) {
          const cnVal = Array.isArray(entry.cn) ? entry.cn[0] : entry.cn;
          if (cnVal && !resolvedGroups.includes(String(cnVal))) {
            resolvedGroups.push(String(cnVal));
          }
        }
      }
    } catch {
      // Group search failure should not block login if memberOf was present
    }

    // Step 6: Map groups to EluvixRole
    const role = mapGroupsToRole(resolvedGroups, config);
    if (!role) {
      return {
        authenticated: false,
        error: 'User does not belong to any authorized Eluvix role group',
      };
    }

    const displayName =
      (userEntry.displayName ? String(userEntry.displayName) : '') ||
      (userEntry.cn ? String(userEntry.cn) : '') ||
      trimmedUser;

    const email = userEntry.mail ? String(userEntry.mail) : undefined;

    return {
      authenticated: true,
      userId: `ldap:${trimmedUser}`,
      username: trimmedUser,
      displayName,
      email,
      dn: userDn,
      groups: resolvedGroups,
      role,
      authSource: 'ldap',
    };
  } catch (err: any) {
    return {
      authenticated: false,
      error: `LDAP directory connection error: ${err.message || 'unknown error'}`,
    };
  } finally {
    await client.unbind().catch(() => {});
  }
}
