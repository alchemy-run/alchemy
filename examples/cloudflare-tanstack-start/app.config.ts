import { defineConfig } from "@tanstack/react-start/config";
import tsConfigPaths from "vite-tsconfig-paths";
import {
  cloudflareWorkersDevEnvironmentShim,
  external,
} from "../../alchemy/src/cloudflare";

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
      external,
    },
  },
  vite: {
    plugins: [
      // polyfills import { env } from "cloudflare:workers" during `vite dev` (not deployed to server)
      cloudflareWorkersDevEnvironmentShim(),
      tsConfigPaths({
        projects: ["./tsconfig.json"],
      }),
    ],
    build: {
      rollupOptions: {
        external,
      },
    },
  },
});
