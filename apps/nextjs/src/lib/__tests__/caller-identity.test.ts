import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveCallerIdentity, resolveSessionUserId, resolveSessionIdentity } from '../caller-identity';
import * as nextAuthJwt from 'next-auth/jwt';

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(),
}));

describe('Caller Identity & Multi-User LDAP Scoping', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.ADMIN_PASSWORD;
    delete process.env.LEGACY_ADMIN_PASSWORD;
  });

  it('resolves session identity for an LDAP user with mapped role and groups', async () => {
    vi.mocked(nextAuthJwt.getToken).mockResolvedValue({
      userId: 'ldap:alice',
      username: 'alice',
      role: 'operator',
      groups: ['eluvix-operator'],
      authSource: 'ldap',
    } as any);

    const req = new Request('http://localhost:3588/api/v1/chat');
    const identity = await resolveCallerIdentity(req);

    expect(identity.ok).toBe(true);
    if (identity.ok) {
      expect(identity.via).toBe('session');
      expect(identity.userId).toBe('ldap:alice');
      expect(identity.username).toBe('alice');
      expect(identity.role).toBe('operator');
      expect(identity.groups).toEqual(['eluvix-operator']);
      expect(identity.authSource).toBe('ldap');
    }

    const sessionUserId = await resolveSessionUserId(req);
    expect(sessionUserId).toBe('ldap:alice');

    const sessionObj = await resolveSessionIdentity(req);
    expect(sessionObj?.username).toBe('alice');
    expect(sessionObj?.authSource).toBe('ldap');
  });

  it('falls back to default admin identity when session is local admin', async () => {
    vi.mocked(nextAuthJwt.getToken).mockResolvedValueOnce({
      userId: 'default',
      username: 'admin',
      role: 'admin',
      groups: ['local-admin'],
      authSource: 'local',
    } as any);

    const req = new Request('http://localhost:3588/api/v1/chat');
    const identity = await resolveCallerIdentity(req);

    expect(identity.ok).toBe(true);
    if (identity.ok) {
      expect(identity.via).toBe('session');
      expect(identity.userId).toBe('default');
      expect(identity.role).toBe('admin');
      expect(identity.authSource).toBe('local');
    }
  });

  it('resolves bearer token with admin password', async () => {
    process.env.ADMIN_PASSWORD = 'super-secret-admin-pw';

    const req = new Request('http://localhost:3588/api/v1/chat', {
      headers: {
        authorization: 'Bearer super-secret-admin-pw',
      },
    });

    const identity = await resolveCallerIdentity(req);
    expect(identity.ok).toBe(true);
    if (identity.ok) {
      expect(identity.via).toBe('admin');
      expect(identity.userId).toBe('default');
      expect(identity.role).toBe('admin');
    }
  });

  it('returns no-identity when neither session nor bearer token is provided', async () => {
    vi.mocked(nextAuthJwt.getToken).mockResolvedValueOnce(null);

    const req = new Request('http://localhost:3588/api/v1/chat');
    const identity = await resolveCallerIdentity(req);
    expect(identity.ok).toBe(false);
    if (!identity.ok) {
      expect(identity.reason).toBe('no-identity');
    }
  });
});
