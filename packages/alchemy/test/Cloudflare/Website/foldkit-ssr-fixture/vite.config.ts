import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    foldkit({
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
