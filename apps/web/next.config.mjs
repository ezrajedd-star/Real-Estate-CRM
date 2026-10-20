// @ts-check

const API_INTERNAL_URL = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  transpilePackages: ['@crm/ui'],
  // The browser only ever talks to this origin; /api/v1 is proxied to the API (BFF), so the
  // session cookie is first-party, SameSite=Strict, and never readable by JavaScript.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_INTERNAL_URL}/api/v1/:path*` }];
  },
};

export default nextConfig;
