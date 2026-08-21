import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The SPA is its own vite project rooted HERE (alchemy.run.ts passes
// `rootDir: "ui"` to Cloudflare.Website.Vite — an inline root always
// overrides a config-file `root`, so the config lives at the root it
// means). Built at deploy and served as Worker assets; ui/edge.ts is
// the worker entry forwarding /api and /attach to the backend.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // workspace package — Vite must resolve the React-only entry
      // (not the AI barrel) so `react` stays out of the Worker bundle
      "alchemy/AI/React": fileURLToPath(
        new URL(
          "../../../packages/alchemy/src/AI/React.ts",
          import.meta.url,
        ),
      ),
    },
  },
});
