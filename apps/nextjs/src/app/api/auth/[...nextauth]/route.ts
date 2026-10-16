import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { getOrCreateAuthConfig } from "@eluvix/router-core";

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
      name: "Admin Password",
      credentials: {
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials) {
        if (!credentials?.password) return null;
        
        const currentAuth = getOrCreateAuthConfig();
        const expectedPassword = process.env.ADMIN_PASSWORD || currentAuth.adminPassword;

        if (expectedPassword && typeof credentials.password === 'string' && secureCompare(credentials.password, expectedPassword)) {
          return { id: "1", name: "Admin" };
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
