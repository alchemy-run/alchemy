/** @type {import("next").NextConfig} */
const nextConfig = {
  turbopack: {
    resolveAlias: {
      // The value-form backend import (app/page.tsx → app/backend.ts)
      // carries alchemy's plan-only IaC half into the server-component
      // graph; `workerd` resolves its native binary at module scope,
      // which Turbopack cannot parse. Alias it to an inert stub — the
      // same treatment alchemy's vite-based tiers apply automatically.
      workerd: "./stubs/workerd.mjs",
      // Same story: the local Images simulator lazy-imports sharp; Next
      // externalizes it by default and OpenNext's esbuild pass then can't
      // resolve the externals shim. Never called inside the Worker.
      sharp: "./stubs/sharp.mjs",
    },
  },
};

export default nextConfig;
