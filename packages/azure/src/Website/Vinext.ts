import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The framework-integration module that drives vinext's Vite build plus
 * vinext's Node `startProdServer` serve entry.
 */
export const VINEXT_NODE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vinext/node";

export interface VinextProps extends FrameworkSiteProps {}

/**
 * Deploy a [vinext](https://vinext.dev) application to Azure
 * App Service: vinext's Vite build then a long-running `startProdServer` Node.js process on a Linux App Service web app (no Docker). Does **not** use the Cloudflare Worker entry
 * (`vinext/server/fetch-handler`).
 *
 * The `dist/` output is zip-deployed with the server. `vinext`,
 * `react`, `react-dom`, and `react-server-dom-webpack` are installed by
 * App Service's remote build rather than bundled.
 *
 * During `alchemy dev` the site is `vinext dev` and no cloud resources
 * are declared; `Alchemy.remote()` opts back into the live deployment.
 *
 * ### Creating vinext Sites
 * **Example:** Basic vinext App
 * ```typescript
 * const site = yield* Azure.Website.Vinext("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Behind Azure Front Door
 * ```typescript
 * const site = yield* Azure.Website.Vinext("Web", {
 *   rootDir: "./app",
 *   frontDoor: true,
 * });
 * ```
 *
 * **Example:** Redis data cache
 * ISR / `"use cache"` default to in-process memory. Set `env.REDIS_URL` on
 * this resource for a durable Redis store; the adapter is injected automatically.
 * ```typescript
 * const site = yield* Azure.Website.Vinext("Web", {
 *   env: {
 *     REDIS_URL: "redis://cache.internal:6379",
 *   },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Vinext = (id: string, props: VinextProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Vinext",
    framework: VINEXT_NODE_FRAMEWORK_SPECIFIER,
    target: VINEXT_NODE_FRAMEWORK_SPECIFIER,
    install: ["vinext", "react", "react-dom", "react-server-dom-webpack"],
  }).pipe(Namespace.push(id));
