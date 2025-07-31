import type { Assets } from "./assets.js";
import type { Bindings } from "./bindings.js";
import { Vite, type ViteProps } from "./vite.ts";
import type { Worker } from "./worker.ts";

export interface OrangeProps<B extends Bindings> extends ViteProps<B> {}

// don't allow the ASSETS to be overriden
export type Orange<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

/**
 * Deploys an Orange application to Cloudflare Workers.
 *
 * This resource simplifies deploying Orange applications by assuming the build
 * command, main entrypoint, and assets directory based on the `create-orange`
 * template CLI.
 *
 * It wraps the underlying `Website` resource.
 *
 * @example
 * // Deploy a basic Orange application with default settings
 * const orangeApp = await Orange("my-orange-app");
 *
 * @example
 * // Deploy with a database binding
 * const database = await D1Database("orange-db");
 * const orangeApp = await Orange("orange-with-db", {
 *   bindings: { DB: database }
 * });
 *
 * @param id - Unique identifier for the Orange resource
 * @param props - Configuration properties for the Orange resource
 * @returns A Cloudflare Worker resource representing the deployed Orange application
 */
export async function Orange<B extends Bindings>(
  id: string,
  props: Partial<OrangeProps<B>> = {},
): Promise<Orange<B>> {
  return await Vite(id, {
    ...props,
    noBundle: props.noBundle ?? true,
    entrypoint: props.entrypoint ?? "dist/ssr/entry.server.js",
    assets: props.assets ?? "dist/client",
    compatibilityFlags: ["nodejs_compat", ...(props?.compatibilityFlags ?? [])],
    wrangler: {
      path: "wrangler.jsonc",
      main: "app/entry.server.ts",
      secrets: false,
      ...props.wrangler,
    },
  });
}
