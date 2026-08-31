import { randomUUID } from "node:crypto";

import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

// The deployment this build belongs to. The server stamps it on the rendered
// root and the client carries the same value, so hydration can refuse a page
// from a different deployment before adopting its DOM. A hydratable render
// fails without one, so a build must always have it: CI supplies a real
// per-deployment value and a local build falls back to a fresh one rather
// than a constant, which would make a stale page look current.
//
// NOTE: the fallback is stored back into the environment because Vite reads
// this file once per environment it builds — a value minted fresh on each
// read would give the browser bundle and the server bundle different ids,
// and hydration would refuse every page of the deployment that just shipped.
process.env.FOLDKIT_BUILD_ID ||= `local-${randomUUID()}`;
const buildId = process.env.FOLDKIT_BUILD_ID;

export default defineConfig({
  // NOTE: the plugin's `ssr: { serverEntry }` option is not set. Its dev-time
  // rendering stands down under `alchemy dev` anyway (the `ssr` environment
  // is workerd, so the plugin defers, saying so once at startup), and it is
  // redundant here: requests reach `src/worker.ts`, which renders through
  // the same entry.
  plugins: [foldkit({ buildId })],
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
});
