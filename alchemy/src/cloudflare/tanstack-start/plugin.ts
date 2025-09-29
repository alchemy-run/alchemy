import type { PluginConfig } from "@cloudflare/vite-plugin";
import alchemyVite from "../vite/plugin.ts";

/**
 * TanStackStart server functions and middleware run in Node.js intead of Miniflare when using `vite dev`.
 *
 * This plugin polyfills the cloudflare:workers module & includes `process.env` during the dev server phase.
 *
 * @see https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/#using-cloudflare-bindings
 */
export default function alchemy(options: PluginConfig = {}) {
  return alchemyVite({
    viteEnvironment: { name: "ssr" },
    ...options,
  });
}
