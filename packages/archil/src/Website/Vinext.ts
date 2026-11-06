import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The framework-integration module that drives vinext's Vite build plus
 * vinext's Node `startProdServer` serve entry.
 */
export const VINEXT_NODE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vinext/node";

export interface VinextProps extends FrameworkSiteProps {}

/**
 * Deploy a [vinext](https://vinext.dev) application to an Archil sandbox:
 * vinext's Vite build then a long-running `startProdServer` program
 * on port 3000. Does **not** use the Cloudflare Worker entry
 * (`vinext/server/fetch-handler`).
 *
 * The `dist/` output is packed into the program's files. `vinext`,
 * `react`, `react-dom`, and `react-server-dom-webpack` are installed next to the
 * program with `npm install` rather than bundled.
 *
 * During `alchemy dev` the site is `vinext dev` and no cloud resources
 * are declared; `Alchemy.remote()` opts back into the live sandbox.
 *
 * ### Creating vinext Sites
 * **Example:** Basic vinext App
 * ```typescript
 * const site = yield* Archil.Website.Vinext("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Redis data cache
 * ISR / `"use cache"` default to in-process memory. Set `env.REDIS_URL` on
 * this resource for a durable Redis store; the adapter is injected automatically.
 * ```typescript
 * const site = yield* Archil.Website.Vinext("Web", {
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
