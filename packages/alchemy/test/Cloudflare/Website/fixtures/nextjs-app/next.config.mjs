/** @type {import("next").NextConfig} */
const nextConfig = {
  // The effectful fixtures pull alchemy's TypeScript sources into the
  // project graph (src/site*.ts); type-checking that graph with the
  // fixture's tsconfig is not this fixture's job — the workspace
  // type-checks it. Skip Next's build-time tsc pass.
  typescript: { ignoreBuildErrors: true },
  // The alchemy graph reaches the local-runtime modules
  // (`Cloudflare/LocalRuntime.ts` → `@alchemy.run/cloudflare-runtime` →
  // `workerd`), and the workerd npm package resolves a native binary
  // turbopack cannot parse. Alias it to an inert stub — nothing on the
  // explicit-tier request path ever invokes the local workerd host (that is
  // engine/sidecar machinery). `serverExternalPackages` cannot express
  // this: workspace-symlinked packages are treated as app code.
  turbopack: {
    resolveAlias: {
      workerd: "./stubs/empty.mjs",
    },
  },
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
