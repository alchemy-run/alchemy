import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Built by `Local.Vite` at deploy and served from the org server
// itself (asset-first, same port as /api) — no dev server, no proxy.
export default defineConfig({
  root: "ui",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./ui", import.meta.url)),
    },
  },
});
