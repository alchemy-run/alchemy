import { Vite, type ViteProps } from "./Vite.ts";

export interface SolidYieldProps extends ViteProps {}

/**
 * Deploy a [solid-yield](https://github.com/devagrawal09/solid-yield) app to Railway: a Vite SPA with
 * unmatched paths falling back to `index.html` so deep links boot the
 * client router. Same Node static-file Service as {@link Vite}.
 *
 * solid-yield apps are client-rendered Solid 2 Vite projects — the solid-yield and Solid Vite plugins in
 * the app's `vite.config.ts` compose with the project's own Vite build.
 *
 * During `alchemy dev` the site is Vite's own dev server and no cloud
 * resources are created. `Alchemy.remote()` opts back into the live
 * Service path.
 *
 * ### Deploying a solid-yield App
 * **Example:** solid-yield app
 * ```typescript
 * const site = yield* Railway.Website.SolidYield("Website");
 * ```
 *
 * **Example:** solid-yield project in a subdirectory
 * ```typescript
 * const site = yield* Railway.Website.SolidYield("Website", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * ### Single-Page Application Routing
 * **Example:** Serving a real 404 page
 * ```typescript
 * const site = yield* Railway.Website.SolidYield("Website", {
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
