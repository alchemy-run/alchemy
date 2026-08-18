/** @type {import("next").NextConfig} */
const nextConfig = {
  // The effectful fixtures pull alchemy's TypeScript sources into the
  // project graph (src/site*.ts); type-checking that graph with the
  // fixture's tsconfig is not this fixture's job — the workspace
  // type-checks it. Skip Next's build-time tsc pass.
  typescript: { ignoreBuildErrors: true },
  // next.config routing surface, asserted by the smoke tests.
  async redirects() {
    return [{ source: "/old-home", destination: "/", permanent: true }];
  },
  async rewrites() {
    return [{ source: "/rewritten-hello", destination: "/api/hello" }];
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "x-fixture-config-header", value: "from-next-config" },
        ],
      },
    ];
  },
};

export default nextConfig;
