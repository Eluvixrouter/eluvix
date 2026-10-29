import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { authenticateEluvixCredentials, getOrCreateAuthConfig } from "@eluvix/router-core";

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
      async authorize(credentials) {
        if (!credentials?.password) return null;
        
        const res = await authenticateEluvixCredentials(
          credentials.username,
          credentials.password
        );

        if (res.authenticated && res.userId) {
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
