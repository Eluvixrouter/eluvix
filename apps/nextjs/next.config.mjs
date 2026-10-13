/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: ['@eluvix/router-core', 'better-sqlite3'],
  },
};

export default nextConfig;
