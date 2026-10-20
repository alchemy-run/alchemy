// Mirrors `@cloudflare/vite-plugin`'s `playground/module-resolution`: a user
// alias, and an optimizeDeps-excluded package importing a virtual module.
// The `@playground/*` packages are linked into `node_modules` by the test.
import { resolve } from "node:path";
// @ts-expect-error Missing types
import testDepPlugin from "@playground/module-resolution-excludes/plugin";

export default {
  resolve: {
    alias: {
      "@alias/test": resolve(import.meta.dirname, "./src/aliasing.ts"),
    },
  },
  environments: {
    ssr: {
      optimizeDeps: {
        exclude: ["@playground/module-resolution-excludes"],
      },
    },
  },
  plugins: [testDepPlugin()],
};
