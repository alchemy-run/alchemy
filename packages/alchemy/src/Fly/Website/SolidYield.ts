import { Vite, type ViteProps } from "./Vite.ts";

export interface SolidYieldProps extends ViteProps {}

/**
 * Deploy a [solid-yield](https://github.com/devagrawal09/solid-yield) app to Fly. solid-yield apps are
 * client-rendered Solid 2 Vite projects, so this is {@link Vite} with SPA fallback
 * to `index.html` so deep links boot the app.
 *
 *
 * ### Creating solid-yield Sites
 * **Example:** solid-yield app
 * ```typescript
 * const site = yield* Fly.Website.SolidYield("Web");
 * ```
 *
 * **Example:** Project in a subdirectory
 * ```typescript
 * const site = yield* Fly.Website.SolidYield("Web", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * ### Single-Page Application Routing
 * **Example:** Serving a real 404 page
 * ```typescript
 * const site = yield* Fly.Website.SolidYield("Web", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const SolidYield = (id: string, props: SolidYieldProps = {}) =>
  Vite(id, {
    ...props,
    assets: {
      notFoundHandling: "single-page-application",
      ...props.assets,
    },
  });
