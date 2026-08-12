import cloudflare from "@alchemy.run/cloudflare-runtime/vite";
import { defineConfig } from "vite";

// `Cloudflare.Website.Vite` declares an `ssr` environment but doesn't set a
// worker entry by default. For non-framework projects (no React/Vue
// plugin to inject one), Vite 8 errors out with "rollupOptions.input
// should not be an html file when building for SSR". We point the SSR
// build at our minimal worker entry so the cloudflare-vite-plugin can
// wrap it into the worker bundle.
export default defineConfig({
  // Deliberately UNGUARDED (no ALCHEMY_CLOUDFLARE_VITE_INJECTED ternary):
  // the plugin an app declares for standalone `vite build`/`vite dev` must
  // stand down by itself when alchemy injects its orchestrated instance —
  // this fixture pins that self-deduplication end to end (a second active
  // instance would boot a bindings-less workerd and fail these suites).
  plugins: [cloudflare({ main: "./src/worker.ts" })],
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
