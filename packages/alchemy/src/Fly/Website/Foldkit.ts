import { Vite, type ViteProps } from "./Vite.ts";

export interface FoldkitProps extends ViteProps {}

/**
 * Deploy a [Foldkit](https://foldkit.dev) app to Fly. Foldkit apps are
 * client-only Vite projects, so this is {@link Vite} with SPA fallback
 * to `index.html` so deep links boot the app.
 *
 * @resource
 * @product Website
 *
 * @section Creating Foldkit Sites
 * @example Foldkit app
 * ```typescript
 * const site = yield* Fly.Website.Foldkit("Web");
 * ```
 *
 * @example Project in a subdirectory
 * ```typescript
 * const site = yield* Fly.Website.Foldkit("Web", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * @section Single-Page Application Routing
 * @example Serving a real 404 page
 * ```typescript
 * const site = yield* Fly.Website.Foldkit("Web", {
 *   spa: false,
 *   errorPage: "404.html",
 * });
 * ```
 */
export const Foldkit = (id: string, props: FoldkitProps = {}) =>
  Vite(id, {
    ...props,
    spa: props.spa ?? (props.errorPage === undefined ? true : undefined),
  });
