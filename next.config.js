/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Linting runs in CI / `npm run lint`, not during the production build. The
  // VM (e2-micro, 1 GB RAM) is memory-tight, so we skip the extra ESLint pass
  // that `next build` would otherwise run now that an ESLint config exists.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Types are checked in CI / `npm run build` locally (`tsc --noEmit`). The VM
  // (e2-micro, 1 GB RAM) OOMs running the in-build type-checker, so skip it
  // there — the compile itself is what the production server needs.
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    // Keep heavy/native packages out of the server-component bundling step:
    // Prisma, plus the knowledge-base parsers (pdfjs is large and DOM-ish).
    serverComponentsExternalPackages: [
      '@prisma/client',
      'prisma',
      'pdf-parse',
      'pdfjs-dist',
      'mammoth',
    ],
  },
  // The two hand-built vertical pages are now /solutions/[vertical] rows.
  // 308s, not deletions: these two URLs carry the only search ranking this
  // domain has, and they are printed on collateral that is already out there.
  // Both are permanent — the old paths are never coming back, so telling search
  // engines to move the ranking across is the entire point.
  async redirects() {
    return [
      { source: '/ai-receptionist-for-clinics', destination: '/solutions/healthcare', permanent: true },
      { source: '/for-dental-clinics', destination: '/solutions/healthcare', permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // HSTS is honored only over HTTPS, so this is a no-op in local dev.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Nothing embeds this app in a frame (no widgets/embeds exist).
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // The app never uses camera/mic/geolocation in the browser (calls
          // are phone-based; voice preview is playback only).
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
