import { frameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Vite build. */
export const VITE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vite";

/** The Node container deploy target for the Vite build. */
export const VITE_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vite/node";

export interface ViteProps extends FrameworkSiteProps {
  /**
   * Serializable Vite config merged OVER the project's own `vite.config.*`
   * (which loads natively, plugins included).
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
   * Answer misses with the index page (200) instead of a 404, so
   * client-side routes deep-link correctly. Plain Vite apps are typically
   * single-page applications, so this defaults on; set `false` for
   * multi-page (`index.html`-per-route) projects. Mutually exclusive with
   * {@link errorPage}.
   * @default true unless `errorPage` is set
   */
  spa?: boolean;
  /**
   * Serve the built error page (e.g. `404.html`) with a real `404` status
   * for requests that match no uploaded file. Mutually exclusive with
   * {@link spa}.
   */
  errorPage?: string;
}

/**
 * Deploy a plain [Vite](https://vite.dev) application to Fly: a Service
 * serving the `vite build` output from a tiny static-file server. For
 * client-only projects — React/Vue/Solid SPAs, `index.html` multi-page
 * apps — whose entire deployable output is static assets.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/vite` with the
 * `@alchemy.run/frontend-frameworks/vite/node` deploy target — the package
 * must be installed in your project. Your project's own `vite.config.*`
 * (plugins included) drives the build.
 *
 * During `alchemy dev` the site is Vite's own dev server (native HMR) and
 * no cloud resources are created — the site's `url` is the dev server's
 * local address. `Alchemy.remote()` opts back into the full deployment.
 *
 *
 * ### Creating Vite Sites
 * **Example:** Basic Vite SPA
 * ```typescript
 * const site = yield* Fly.Website.Vite("Web");
 * ```
 *
 * **Example:** Project in a Subdirectory
 * ```typescript
 * const site = yield* Fly.Website.Vite("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Existing App
 * ```typescript
 * const site = yield* Fly.Website.Vite("Web", { app: Site });
 * ```
 *
 * ### Multi-Page Sites
 * **Example:** Per-Route HTML Pages with a 404 Page
 * ```typescript
 * const site = yield* Fly.Website.Vite("Docs", {
 *   spa: false,
 *   errorPage: "404.html",
 * });
 * ```
 *
 * ### Custom Domain
 * **Example:** ACME on an existing hostname
 * ```typescript
 * const site = yield* Fly.Website.Vite("Web", {
 *   domain: "app.example.com",
 * });
 * ```
 *
 * ### Local Development
 * **Example:** Vite Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` starts `vite` programmatically: site.url is the local
 * // dev server (HMR included); no Fly App or Service is created.
 * const site = yield* Fly.Website.Vite("Web");
 * ```
 *
 * @resource
 * @product Website
 */
export const Vite = (id: string, props: ViteProps = {}) =>
  frameworkSite(id, props, {
    name: "Vite",
    framework: VITE_FRAMEWORK_SPECIFIER,
    target: VITE_NODE_TARGET_SPECIFIER,
    options: props.vite !== undefined ? { vite: props.vite } : undefined,
    static: {
      spa: props.spa ?? (props.errorPage === undefined ? true : undefined),
      errorPage: props.errorPage,
    },
  });
