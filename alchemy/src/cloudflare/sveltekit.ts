import path from "node:path";
import type { Assets } from "./assets.ts";
import type { Bindings } from "./bindings.ts";
import { Website, type WebsiteProps } from "./website.ts";
import type { Worker } from "./worker.ts";

export interface SvelteKitProps<B extends Bindings> extends WebsiteProps<B> {}

// don't allow the ASSETS to be overriden
export type SvelteKit<B extends Bindings> = B extends { ASSETS: any }
  ? never
  : Worker<B & { ASSETS: Assets }>;

/**
 * Deploy a SvelteKit application to Cloudflare Workers with automatically configured defaults.
 *
 * This resource handles the deployment of SvelteKit applications with optimized settings for
 * Cloudflare Workers, including proper build commands and compatibility flags. It expects
 * the SvelteKit app to be configured with the @sveltejs/adapter-cloudflare adapter.
 *
 * @example
 * // Deploy a basic SvelteKit application with default settings
 * const svelteApp = await SvelteKit("my-svelte-app");
 *
 * @example
 * // Deploy with a database binding and KV storage
 * import { D1Database, KVNamespace } from "alchemy/cloudflare";
 *
 * const database = await D1Database("svelte-db");
 * const sessions = await KVNamespace("sessions");
 *
 * const svelteApp = await SvelteKit("svelte-with-bindings", {
 *   bindings: {
 *     DB: database,
 *     SESSIONS: sessions
 *   }
 * });
 *
 * @example
 * // Deploy with custom build command and assets directory
 * const customSvelteApp = await SvelteKit("custom-svelte", {
 *   command: "npm run build:cloudflare",
 *   assets: "./static"
 * });
 *
 * @param id - Unique identifier for the SvelteKit application
 * @param props - Configuration properties for the SvelteKit deployment
 * @returns A Cloudflare Worker resource representing the deployed SvelteKit application
 */
export async function SvelteKit<B extends Bindings>(
  id: string,
  props?: Partial<SvelteKitProps<B>>,
): Promise<SvelteKit<B>> {
  return Website(id, {
    ...props,
    // Default build command for SvelteKit
    command: props?.command ?? "bun run build",
    // Use the correct entry point that SvelteKit adapter generates
    main: path.join(".svelte-kit/cloudflare/_worker.js"),
    // The cloudflare directory which contains all static assets
    assets: props?.assets ?? "./.svelte-kit/cloudflare",
    // SvelteKit with Cloudflare adapter needs nodejs_compat
    compatibilityFlags: ["nodejs_compat", ...(props?.compatibilityFlags ?? [])],
  });
} 