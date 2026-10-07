import { Vite, type ViteProps } from "./Vite.ts";

export interface SolidYieldProps extends ViteProps {}

/**
 * Deploy a [solid-yield](https://github.com/devagrawal09/solid-yield) app to a Hetzner Cloud Server.
 *
 * solid-yield apps are client-rendered Solid 2 Vite projects, so this composite is the
 * Vite site with SPA fallback to `index.html` (deep links boot the app
 * and the client router takes over).
 *
 *
 * ### Creating solid-yield Sites
 * **Example:** solid-yield App
 * ```typescript
 * const site = yield* Hetzner.Website.SolidYield("Website");
 * ```
 *
 * **Example:** Project in a Subdirectory
 * ```typescript
 * const site = yield* Hetzner.Website.SolidYield("Website", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * ### Single-Page Application Routing
 * **Example:** Serving a real 404 page
 * ```typescript
 * const site = yield* Hetzner.Website.SolidYield("Website", {
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
