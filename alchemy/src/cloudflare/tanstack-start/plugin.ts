import type { GetPlatformProxyOptions } from "wrangler";
import { dedent } from "../../util/dedent.ts";

/**
 * TanStackStart server functions and middleware run in Node.js intead of Miniflare when using `vite dev`.
 *
 * This plugin polyfills the cloudflare:workers module & includes `process.env` during the dev server phase.
 *
 * @see https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack/#using-cloudflare-bindings
 */
export default function alchemy(options: GetPlatformProxyOptions = {}) {
  return {
    name: "cloudflare-workers-dev-shim",
    apply: "serve", // dev‑only
    enforce: "pre",
    resolveId(id: string) {
      if (id === "cloudflare:workers") return id; // tell Vite we handled it
    },
    load(id: string) {
      if (id === "cloudflare:workers") {
        return dedent`
          import { getCloudflareEnvProxy } from "alchemy/cloudflare";
          export const env = await getCloudflareEnvProxy(${JSON.stringify(
            options,
          )});
        `;
      }
    },
  } as const;
}
