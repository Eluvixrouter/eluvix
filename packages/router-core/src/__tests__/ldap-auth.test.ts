import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  escapeLdapFilter,
  escapeLdapDn,
  mapGroupsToRole,
  resolveLdapConfig,
  getLdapStatus,
} from '../ldap.js';
import {
  authenticateEluvixCredentials,
  createNamedApiKey,
  resolveBearerToken,
  getOrCreateAuthConfig,
} from '../auth.js';

describe('Eluvix LDAP Authentication & RBAC Engine', () => {
  const testDir = path.join(os.tmpdir(), `eluvix-ldap-test-${Date.now()}`);
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
    process.env.XDG_DATA_HOME = path.join(testDir, 'data');
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ELUVIX_LDAP_ENABLED;
    delete process.env.ELUVIX_LDAP_URL;
    delete process.env.ELUVIX_LDAP_BASE_DN;
    delete process.env.ELUVIX_LDAP_BIND_DN;
    delete process.env.ELUVIX_LDAP_BIND_PASSWORD;
    delete process.env.ELUVIX_LDAP_ADMIN_GROUPS;
    delete process.env.ELUVIX_LDAP_OPERATOR_GROUPS;
    delete process.env.ELUVIX_LDAP_READONLY_GROUPS;
    delete process.env.ELUVIX_LDAP_ALLOW_BREAK_GLASS;
    delete process.env.ELUVIX_LDAP_BINDING_FILE;
    delete process.env.ELUVIX_CONFIG;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('RFC 4515 & RFC 4514 Escaping', () => {
    it('escapes special characters in LDAP filter assertions per RFC 4515', () => {
      expect(escapeLdapFilter('admin*user(test)\\0')).toBe('admin\\2auser\\28test\\29\\5c0');
      expect(escapeLdapFilter('alice.smith')).toBe('alice.smith');
    });

    it('escapes special characters in LDAP DN per RFC 4514', () => {
      expect(escapeLdapDn('Smith, John+Dev')).toBe('Smith\\, John\\+Dev');
      expect(escapeLdapDn('user#1=test<val>')).toBe('user\\#1\\=test\\<val\\>');
    });
  });

  describe('Group-to-Role RBAC Mapping', () => {
    const config = {
      adminGroups: ['axonwall-admin', 'eluvix-admin'],
      operatorGroups: ['axonwall-operator', 'eluvix-operator'],
      readonlyGroups: ['axonwall-readonly', 'eluvix-readonly'],
      defaultRole: 'readonly' as const,
    };

    it('maps admin groups with top priority', () => {
      expect(mapGroupsToRole(['eluvix-admin'], config)).toBe('admin');
      expect(mapGroupsToRole(['axonwall-admin', 'eluvix-operator'], config)).toBe('admin');
    });

    it('maps operator groups with second priority', () => {
      expect(mapGroupsToRole(['eluvix-operator'], config)).toBe('operator');
      expect(mapGroupsToRole(['axonwall-operator', 'axonwall-readonly'], config)).toBe('operator');
    });

    it('maps readonly groups with third priority', () => {
      expect(mapGroupsToRole(['eluvix-readonly'], config)).toBe('readonly');
      expect(mapGroupsToRole(['axonwall-readonly'], config)).toBe('readonly');
    });

    it('falls back to defaultRole when no matching groups are present', () => {
      expect(mapGroupsToRole(['staff', 'developers'], config)).toBe('readonly');
      expect(mapGroupsToRole([], { ...config, defaultRole: 'none' })).toBeNull();
    });
  });

  describe('Configuration Resolution & Auto-Discovery', () => {
    it('auto-discovers Axonwall managed plugin binding file when present', () => {
      const bindingPath = path.join(testDir, 'eluvix-plugin-binding.json');
      fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
      fs.writeFileSync(
        bindingPath,
        JSON.stringify({
          pluginId: 'eluvix',
          enabled: true,
          url: 'ldap://127.0.0.1:389',
          baseDn: 'dc=corp,dc=axonwall,dc=local',
          bindDn: 'cn=svc-eluvix,ou=services,dc=corp,dc=axonwall,dc=local',
          bindPassword: 'super-secret-password-12345',
          roleGroups: {
            admin: ['axonwall-admin', 'eluvix-admin'],
            operator: ['axonwall-operator', 'eluvix-operator'],
            readonly: ['axonwall-readonly', 'eluvix-readonly'],
          },
        })
      );
      process.env.ELUVIX_LDAP_BINDING_FILE = bindingPath;

      const resolved = resolveLdapConfig(undefined, 'test-app');
      expect(resolved.enabled).toBe(true);
      expect(resolved.baseDn).toBe('dc=corp,dc=axonwall,dc=local');
      expect(resolved.bindDn).toBe('cn=svc-eluvix,ou=services,dc=corp,dc=axonwall,dc=local');
      expect(resolved.bindPassword).toBe('super-secret-password-12345');
      expect(resolved.userSearchBase).toBe('ou=users,dc=corp,dc=axonwall,dc=local');
      expect(resolved.groupSearchBase).toBe('ou=groups,dc=corp,dc=axonwall,dc=local');

      const status = getLdapStatus(undefined, 'test-app');
      expect(status.enabled).toBe(true);
      expect(status.serviceAccount).toBe('cn=svc-eluvix,ou=services,dc=corp,dc=axonwall,dc=local');
    });

    it('respects environment overrides over file configurations', () => {
      process.env.ELUVIX_LDAP_ENABLED = 'true';
      process.env.ELUVIX_LDAP_URL = 'ldaps://ldap.enterprise.local:636';
      process.env.ELUVIX_LDAP_BASE_DN = 'dc=enterprise,dc=local';
      process.env.ELUVIX_LDAP_ADMIN_GROUPS = 'superadmins,enterprise-ai-admins';

      const resolved = resolveLdapConfig(undefined, 'test-app');
      expect(resolved.enabled).toBe(true);
      expect(resolved.url).toBe('ldaps://ldap.enterprise.local:636');
      expect(resolved.baseDn).toBe('dc=enterprise,dc=local');
      expect(resolved.adminGroups).toEqual(['superadmins', 'enterprise-ai-admins']);
    });
  });

  describe('Unified Credential Authentication & Break-Glass Recovery', () => {
    it('authenticates local administrator via ADMIN_PASSWORD when LDAP is disabled', async () => {
      process.env.ADMIN_PASSWORD = 'local-admin-break-glass-pw';
      getOrCreateAuthConfig('test-app');

      const res = await authenticateEluvixCredentials('', 'local-admin-break-glass-pw', 'test-app');
      expect(res.authenticated).toBe(true);
      expect(res.userId).toBe('default');
      expect(res.role).toBe('admin');
      expect(res.authSource).toBe('local');

      const badPass = await authenticateEluvixCredentials('admin', 'wrong-password', 'test-app');
      expect(badPass.authenticated).toBe(false);
    });

    it('allows break-glass recovery when LDAP is enabled and allowLocalBreakGlass is true', async () => {
      process.env.ADMIN_PASSWORD = 'break-glass-rescue-pw';
      process.env.ELUVIX_LDAP_ENABLED = 'true';
      process.env.ELUVIX_LDAP_ALLOW_BREAK_GLASS = 'true';
      getOrCreateAuthConfig('test-app');

      const res = await authenticateEluvixCredentials('admin', 'break-glass-rescue-pw', 'test-app');
      expect(res.authenticated).toBe(true);
      expect(res.userId).toBe('default');
      expect(res.role).toBe('admin');
      expect(res.authSource).toBe('local');
    });

    it('rejects break-glass recovery when allowLocalBreakGlass is explicitly false', async () => {
      process.env.ADMIN_PASSWORD = 'break-glass-rescue-pw';
      process.env.ELUVIX_LDAP_ENABLED = 'true';
      process.env.ELUVIX_LDAP_ALLOW_BREAK_GLASS = 'false';
      getOrCreateAuthConfig('test-app');

      const res = await authenticateEluvixCredentials('admin', 'break-glass-rescue-pw', 'test-app');
      expect(res.authenticated).toBe(false);
      expect(res.error).toContain('disabled by policy');
    });
  });

  describe('Bearer Token Resolution & Per-User API Keys', () => {
    it('resolves admin bearer token with role admin', () => {
      process.env.ADMIN_PASSWORD = 'admin-secret-token';
      getOrCreateAuthConfig('test-app');

      const resolved = resolveBearerToken('admin-secret-token', undefined, 'test-app');
      expect(resolved.valid).toBe(true);
      expect(resolved.isAdmin).toBe(true);
      expect(resolved.role).toBe('admin');
      expect(resolved.userId).toBe('default');
    });

    it('resolves named API key with bound userId and role', () => {
      getOrCreateAuthConfig('test-app');
      const key = createNamedApiKey(
        {
          label: 'Data Science Alice Key',
          userId: 'ldap:alice',
          role: 'operator',
        },
        'test-app'
      );

      const resolved = resolveBearerToken(key.key, undefined, 'test-app');
      expect(resolved.valid).toBe(true);
      expect(resolved.isAdmin).toBe(false);
      expect(resolved.role).toBe('operator');
      expect(resolved.userId).toBe('ldap:alice');
      expect(resolved.keyLabel).toBe('Data Science Alice Key');
    });
  });
});
