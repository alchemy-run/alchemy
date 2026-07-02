import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // `bun` resolves alchemy (and its UI modules) straight from src/*.ts so
    // UI providers are bundled from source without a lib build.
    conditions: ["bun", ...defaultClientConditions],
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.ALCHEMY_DASHBOARD_API ?? "http://127.0.0.1:4444",
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 2500,
  },
});
