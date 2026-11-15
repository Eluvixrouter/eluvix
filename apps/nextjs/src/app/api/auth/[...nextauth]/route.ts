import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { authenticateEluvixCredentials, getOrCreateAuthConfig } from "@eluvix/router-core";
import {
  getLoginThrottleKey,
  loginLockoutRemainingMs,
  recordLoginFailure,
  recordLoginSuccess
} from "@/lib/login-throttle";
import { migrateLegacyCredential } from "@/lib/legacy-credential";

import crypto from "node:crypto";

function secureCompare(a: string, b: string): boolean {
  try {
    const enc = new TextEncoder();
    const hashA = crypto.createHash("sha256").update(enc.encode(a)).digest();
    const hashB = crypto.createHash("sha256").update(enc.encode(b)).digest();
    return crypto.timingSafeEqual(hashA, hashB);
  } catch {
    return false;
  }
}

const authConfig = getOrCreateAuthConfig();

const handler = NextAuth({
  providers: [
    CredentialsProvider({
      id: "credentials",
      name: "Eluvix & Axonwall Directory",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials, req) {
        if (!credentials?.password || typeof credentials.password !== 'string') return null;

        // Per-IP throttling (audit L-3): a locked-out IP gets no password
        // check at all, so lockout windows cannot be used as an oracle.
        const throttleKey = getLoginThrottleKey(req as any);
        const lockoutRemaining = loginLockoutRemainingMs(throttleKey);
        if (lockoutRemaining > 0) {
          console.warn(
            `[Auth] Login attempt rejected during throttle lockout (key ${throttleKey}, ${Math.ceil(lockoutRemaining / 1000)}s remaining).`
          );
          return null;
        }

        const res = await authenticateEluvixCredentials(
          credentials.username,
          credentials.password
        );

        if (res.authenticated && res.userId) {
          recordLoginSuccess(throttleKey);

          // Legacy Enclavix credential (audit L-4, decision D6): new main's
          // authenticateEluvixCredentials already *accepts* the legacy
          // password, but the migration half of D6 — writing it into the
          // current auth.json and retiring the legacy files — still lives
          // here. Migrate only for local break-glass logins whose password
          // matches the legacy credential and not the current admin one.
          const legacyPassword = process.env.LEGACY_ADMIN_PASSWORD;
          const currentAuth = getOrCreateAuthConfig();
          const currentPassword =
            process.env.ADMIN_PASSWORD || currentAuth.adminPassword;
          if (
            res.authSource === 'local' &&
            legacyPassword &&
            secureCompare(credentials.password, legacyPassword) &&
            !(currentPassword && secureCompare(credentials.password, currentPassword))
          ) {
            console.warn(
              '[Auth] Login succeeded with the DEPRECATED legacy Enclavix credential. Migrating it to the current auth config...'
            );
            const migration = migrateLegacyCredential(legacyPassword);
            console.warn(`[Auth] Legacy credential migration: ${migration.detail}`);
          }

          return {
            id: res.userId,
            name: res.displayName || res.username || "Admin",
            email: res.email,
            username: res.username || "admin",
            role: res.role || "admin",
            groups: res.groups || [],
            authSource: res.authSource || "local",
          } as any;
        }

        const { failures, lockoutMs } = recordLoginFailure(throttleKey);
        if (lockoutMs > 0) {
          console.warn(
            `[Auth] Login failure #${failures} for key ${throttleKey}; throttling further attempts for ${Math.ceil(lockoutMs / 1000)}s.`
          );
        }
        return null;
      }
    })
  ],
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: "jwt"
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = (user as any).id || (user as any).userId;
        token.username = (user as any).username;
        token.role = (user as any).role || "admin";
        token.groups = (user as any).groups || [];
        token.authSource = (user as any).authSource || "local";
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        (session.user as any).id = token.userId || token.sub;
        (session.user as any).userId = token.userId || token.sub;
        (session.user as any).username = token.username;
        (session.user as any).role = token.role || "admin";
        (session.user as any).groups = token.groups || [];
        (session.user as any).authSource = token.authSource || "local";
      }
      return session;
    },
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) {
        return new URL(url, baseUrl).toString();
      }
      try {
        const parsed = new URL(url);
        const baseParsed = new URL(baseUrl);
        if (parsed.origin === baseParsed.origin) {
          return url;
        }
      } catch {}
      return baseUrl;
    }
  },
  secret: process.env.NEXTAUTH_SECRET || authConfig.nextAuthSecret
});

export { handler as GET, handler as POST };
