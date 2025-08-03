import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import alchemyDevEnvironmentShim from "alchemy/cloudflare/tanstack-start";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  build: {
    target: "esnext",
    rollupOptions: {
      external: ["node:async_hooks", "cloudflare:workers"],
    },
  },
  plugins: [
    alchemyDevEnvironmentShim(),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart({
      target: "cloudflare-module",
      customViteReactPlugin: true,
    }),
    viteReact(),
  ],
});
