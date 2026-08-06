import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit()],
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
  // A Foldkit app is client-only, so the `ssr` environment has no entry of
  // its own. Declaring one here is what gives the deployment a Worker to
  // run in front of the assets — `Website.Foldkit`'s `main` option points
  // at this module.
  environments: {
    ssr: {
      build: {
        rollupOptions: {
          input: "./src/worker.ts",
        },
      },
    },
  },
});
