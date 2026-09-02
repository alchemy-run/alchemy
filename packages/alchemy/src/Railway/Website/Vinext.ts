import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The vinext Node framework module (it is its own deploy target — not
 * the Cloudflare Worker source).
 */
export const VINEXT_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vinext/node";

/** The Node container deploy target for the vinext build. */
export const VINEXT_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vinext/node";

export interface VinextProps extends FrameworkSiteProps {}

/**
 * Deploy a [vinext](https://vinext.dev) application to Railway as a
 * long-running Node process: `vinext build`, then vinext's production
 * server (`startProdServer`) on `PORT` (default 3000). **Not** the
 * Cloudflare Worker path — those wrappers are workerd.
 *
 * The image `npm install`s `vinext`, `react`, `react-dom`, and
 * `react-server-dom-webpack`, and bakes `dist/` into `/app`.
 *
 * During `alchemy dev` the site is vinext's own dev server (`vinext
 * dev`) and no cloud resources are declared; `Alchemy.remote()` opts
 * back into the full live deployment.
 *
 * ### Creating vinext Sites
 * **Example:** Basic vinext App
 * ```typescript
 * const site = yield* Railway.Website.Vinext("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Process Environment
 * ```typescript
 * const site = yield* Railway.Website.Vinext("Web", {
 *   rootDir: "./app",
 *   env: {
 *     GREETING: "Hello from vinext on Railway!",
 *   },
 * });
 * ```
 *
 * **Example:** Redis data cache
 * ISR / `"use cache"` persist in Redis when you pass `REDIS_URL` and
 * register `redisAdapter()` in `vite.config.ts`. Missing `REDIS_URL`
 * (local `vinext start` / `alchemy dev`) falls back to memory.
 * ```typescript
 * const project = yield* Railway.Project("Project");
 * const redis = yield* Railway.Redis("Cache", { project });
 * const site = yield* Railway.Website.Vinext("Web", {
 *   project,
 *   env: {
 *     REDIS_URL: Railway.ref(redis, "REDIS_URL"),
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
    framework: VINEXT_FRAMEWORK_SPECIFIER,
    target: VINEXT_NODE_TARGET_SPECIFIER,
    install: ["vinext", "react", "react-dom", "react-server-dom-webpack"],
  }).pipe(Namespace.push(id));
