import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Vite build. */
export const VITE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vite";

/** The AWS deploy target for the Vite build. */
export const VITE_AWS_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vite/aws";

export interface ViteProps extends Omit<FrameworkSiteProps, "server"> {
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
 * Deploy a plain [Vite](https://vite.dev) application to AWS: static assets
 * (the `vite build` output) in S3 behind a CloudFront distribution. For
 * client-only projects — React/Vue/Solid SPAs, `index.html` multi-page
 * apps — whose entire deployable output is static assets.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/vite` with the
 * `@alchemy.run/frontend-frameworks/vite/aws` deploy target — the package
 * must be installed in your project. Your project's own `vite.config.*`
 * (plugins included) drives the build; input files are content-hashed so
 * unchanged projects skip the build and deploy entirely.
 *
 * During `alchemy dev` the site is Vite's own dev server (native HMR) and
 * no cloud resources are created — the site's `url` is the dev server's
 * local address. `Alchemy.remote()` opts back into the full deployment.
 *
 * SSR frameworks that wrap Vite deploy through their own composites
 * ({@link Astro | AWS.Website.Astro}, {@link SvelteKit | AWS.Website.SvelteKit},
 * {@link Octane | AWS.Website.Octane}, ...) — this composite never creates
 * a server function.
 *
 * ### Creating Vite Sites
 * **Example:** Basic Vite SPA
 * ```typescript
 * const site = yield* AWS.Website.Vite("Web");
 * ```
 *
 * **Example:** Project in a Subdirectory
 * ```typescript
 * const site = yield* AWS.Website.Vite("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.Vite("Web", {
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * ### Multi-Page Sites
 * **Example:** Per-Route HTML Pages with a 404 Page
 * ```typescript
 * const site = yield* AWS.Website.Vite("Docs", {
 *   spa: false,
 *   errorPage: "404.html",
 * });
 * ```
 *
 * ### Sharing a Router
 * **Example:** Serve Through an Existing AWS.Website.Router
 * ```typescript
 * const router = yield* AWS.Website.Router("Router", {});
 * const site = yield* AWS.Website.Vite("Web", {
 *   domain: { router },
 * });
 * ```
 *
 * ### Build Configuration
 * **Example:** Custom Output Directory and Base Path
 * ```typescript
 * const site = yield* AWS.Website.Vite("Docs", {
 *   vite: {
 *     outDir: "build",
 *     base: "/docs/",
 *   },
 * });
 * ```
 *
 * ### Local Development
 * **Example:** Vite Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` starts `vite` programmatically: site.url is the local
 * // dev server (HMR included); no bucket or distribution is created.
 * const site = yield* AWS.Website.Vite("Web");
 * ```
 *
 * @resource
 */
export const Vite = (id: string, props: ViteProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Vite",
    framework: VITE_FRAMEWORK_SPECIFIER,
    target: VITE_AWS_TARGET_SPECIFIER,
    options: props.vite !== undefined ? { vite: props.vite } : undefined,
    // Plain Vite is assets-only: every page is client-rendered from the
    // uploaded bundle, so the deploy never creates a server function.
    // `spa` defaults on (Vite apps are typically SPAs) but yields to an
    // explicit `errorPage` — the two are mutually exclusive downstream.
    static: {
      spa: props.spa ?? (props.errorPage === undefined ? true : undefined),
      errorPage: props.errorPage,
    },
  }).pipe(Namespace.push(id));
