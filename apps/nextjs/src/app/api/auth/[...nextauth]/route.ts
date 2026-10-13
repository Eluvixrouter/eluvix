import NextAuth from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { getOrCreateAuthConfig } from "@eluvix/router-core";

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

        if (credentials.password === expectedPassword) {
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
        if (parsed.origin === baseUrl || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
          return url;
        }
      } catch {}
      return baseUrl;
    }
  },
  secret: process.env.NEXTAUTH_SECRET || authConfig.nextAuthSecret
});

export { handler as GET, handler as POST };
