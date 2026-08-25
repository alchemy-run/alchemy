import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Foldkit (Vite) build. */
export const FOLDKIT_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vite";

/** The Node container deploy target for the Foldkit build. */
export const FOLDKIT_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vite/node";

export interface FoldkitProps extends FrameworkSiteProps {
  /**
   * Serializable Vite config merged OVER the project's own `vite.config.*`.
   */
  vite?: {
    /**
     * Build output directory, relative to `rootDir`.
     * @default the project config's `build.outDir` (vite's default: "dist")
     */
    outDir?: string;
    /** Public base path the site deploys under (vite's `base`). */
    base?: string;
  };
  /**
   * Serve the built error page (e.g. `404.html`) with a real `404` status
   * instead of the default SPA fallback to `index.html`.
   */
  errorPage?: string;
}

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
 *   errorPage: "404.html",
 *   registry: "ghcr.io/acme",
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Foldkit = (id: string, props: FoldkitProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Foldkit",
    framework: FOLDKIT_FRAMEWORK_SPECIFIER,
    target: FOLDKIT_NODE_TARGET_SPECIFIER,
    options: props.vite !== undefined ? { vite: props.vite } : undefined,
    static: {
      spa: props.errorPage === undefined ? true : undefined,
      errorPage: props.errorPage,
    },
  }).pipe(Namespace.push(id));
