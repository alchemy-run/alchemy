import { Vite, type ViteProps } from "./Vite.ts";

export interface FoldkitProps extends ViteProps {}

/**
 * Deploy a [Foldkit](https://foldkit.dev) app to Railway: a Vite SPA with
 * unmatched paths falling back to `index.html` so deep links boot the
 * Foldkit router. Same Node static-file Service as {@link Vite}.
 *
 * Foldkit apps are client-only Vite projects — the Foldkit Vite plugin in
 * the app's `vite.config.ts` composes with the project's own Vite build.
 *
 * During `alchemy dev` the site is Vite's own dev server and no cloud
 * resources are created. `Alchemy.remote()` opts back into the live
 * Service path.
 *
 * ### Deploying a Foldkit App
 * **Example:** Foldkit app
 * ```typescript
 * const site = yield* Railway.Website.Foldkit("Website", {
 *   registry: "ghcr.io/acme",
 * });
 * ```
 *
 * **Example:** Foldkit project in a subdirectory
 * ```typescript
 * const site = yield* Railway.Website.Foldkit("Website", {
 *   rootDir: "applications/web",
 *   registry: "ghcr.io/acme",
 * });
 * ```
 *
 * ### Single-Page Application Routing
 * **Example:** Serving a real 404 page
 * ```typescript
 * const site = yield* Railway.Website.Foldkit("Website", {
 *   spa: false,
 *   errorPage: "404.html",
 *   registry: "ghcr.io/acme",
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Foldkit = (id: string, props: FoldkitProps = {}) =>
  Vite(id, {
    ...props,
    spa: props.spa ?? (props.errorPage === undefined ? true : undefined),
  });
