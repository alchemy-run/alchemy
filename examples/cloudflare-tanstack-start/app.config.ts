import { defineConfig } from "@tanstack/react-start/config";
import path from "node:path";
import tsConfigPaths from "vite-tsconfig-paths";
import { cloudflareWorkersDevEnvironmentShim } from "../../alchemy/src/cloudflare";

const external = ["node:*", "cloudflare:workers"];

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
    resolve: {
      alias: {
        react: path.resolve("./node_modules/react"),
        "react-dom": path.resolve("./node_modules/react-dom"),
      },
    },
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
