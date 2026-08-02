import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Built by `Local.Vite` / Worker assets at deploy and served from the
// same origin as /api — no dev server, no proxy.
export default defineConfig({
  root: "ui",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./ui", import.meta.url)),
      // workspace package — Vite must resolve the React-only entry
      // (not the AI barrel) so `react` stays out of the Worker bundle
      "alchemy/AI/React": fileURLToPath(
        new URL("../../packages/alchemy/src/AI/React.ts", import.meta.url),
      ),
    },
  },
});
