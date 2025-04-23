import path from "node:path";
import type { Assets } from "./assets";
import type { Bindings } from "./bindings";
import { Website, type WebsiteProps } from "./website";
import type { Worker } from "./worker";

export interface RedwoodProps<B extends Bindings> extends WebsiteProps<B> {}

// don't allow the ASSETS to be overridden
export type Redwood<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

/**
 * Deploy a RedwoodJS application to Cloudflare Pages with automatically configured defaults.
 *
 * This resource handles the deployment of RedwoodJS applications with optimized settings for
 * Cloudflare Workers, including proper build commands and compatibility flags.
 *
 * @example
 * // Deploy a basic RedwoodJS application with default settings
 * const redwoodApp = await Redwood("my-redwood-app");
 *
 * @example
 * // Deploy with a database binding
 * import { D1Database } from "../cloudflare/d1-database";
 *
 * const database = await D1Database("redwood-db");
 *
 * const redwoodApp = await Redwood("redwood-with-db", {
 *   bindings: {
 *     DB: database
 *   }
 * });
 *
 * @example
 * // Deploy with custom build command and environment variables
 * const redwoodApp = await Redwood("custom-redwood", {
 *   command: "bun run test && RWSDK_DEPLOY=1 bun run build:production",
 *   bindings: {
 *     API_KEY: alchemy.secret("api-key-secret")
 *   },
 *   vars: {
 *     NODE_ENV: "production",
 *     APP_ENV: "staging"
 *   }
 * });
 *
 * @example
 * // Deploy with custom paths and additional compatibility flags
 * const redwoodApp = await Redwood("redwood-custom-paths", {
 *   main: "custom/worker.js",
 *   assets: "custom/static",
 *   compatibilityFlags: ["nodejs_compat", "fetch_refused_to_set_cookies"]
 * });
 *
 * @example
 * // Deploy with custom bundle configuration
 * const redwoodApp = await Redwood("redwood-custom-bundle", {
 *   bundle: {
 *     options: {
 *       external: ["node:events", "node:stream", "node:crypto"],
 *       format: "esm"
 *     }
 *   }
 * });
 *
 * @param id - Unique identifier for the RedwoodJS application
 * @param props - Configuration properties for the RedwoodJS deployment
 * @returns A Cloudflare Worker resource representing the deployed RedwoodJS application
 */
export async function Redwood<B extends Bindings>(
  id: string,
  props?: Partial<RedwoodProps<B>>
): Promise<Redwood<B>> {
  return Website(id, {
    ...props,
    command: props?.command ?? "bun run clean && RWSDK_DEPLOY=1 bun run build",
    wrangler: props?.wrangler ?? true,
    main: props?.main ?? path.join("src", "worker.tsx"),
    assets: props?.assets ?? path.join("dist", "client"),
    compatibilityFlags: ["nodejs_compat", ...(props?.compatibilityFlags ?? [])],
    compatibilityDate: props?.compatibilityDate ?? "2025-04-02",
    bundle: {
      ...props?.bundle,
      options: {
        ...props?.bundle?.options,
        external: [
          "node:events",
          "node:stream",
          ...(props?.bundle?.options?.external ?? []),
        ],
      },
    },
  });
}
