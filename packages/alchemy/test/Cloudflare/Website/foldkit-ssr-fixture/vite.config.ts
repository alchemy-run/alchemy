import { randomUUID } from "node:crypto";

import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

// Stored back into the environment because Vite reads this file once per
// environment it builds: the browser bundle and the server bundle must
// carry the same id or hydration refuses every page.
process.env.FOLDKIT_BUILD_ID ||= `fixture-${randomUUID()}`;
const buildId = process.env.FOLDKIT_BUILD_ID;

export default defineConfig({
  plugins: [
    foldkit({
      buildId,
      ssr: {
        serverEntry: "/src/entry.server.ts",
        // One `vite build` emits the browser bundle, `dist/server/fetch.js`
        // and `foldkit.build.json`, and prerenders whatever
        // `src/prerender.ts` lists.
        build: { prerender: true },
      },
    }),
  ],
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
});
