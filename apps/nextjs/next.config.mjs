/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: ['@eluvix/router-core', 'better-sqlite3'],
  },
  async rewrites() {
    return [
      {
        source: '/v1/:path*',
        destination: '/api/v1/:path*',
      },
    ];
  },
};

export default nextConfig;
