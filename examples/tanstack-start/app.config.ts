import { defineConfig } from "@tanstack/react-start/config";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  tsr: {
    appDirectory: "src",
  },
  server: {
    preset: "cloudflare-module",
    experimental: {
      asyncContext: true,
    },
    unenv: {
      external: ["node:async_hooks"],
    },
  },
  vite: {
    plugins: [
      tsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
    ],
  },
});
