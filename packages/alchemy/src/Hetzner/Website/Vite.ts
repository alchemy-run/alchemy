import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

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
 * Deploy a plain [Vite](https://vite.dev) application to a Hetzner Cloud
 * Server: `vite build` output served by a static-file systemd unit on
 * port 3000. For client-only projects — React/Vue/Solid SPAs,
 * `index.html` multi-page apps — whose entire deployable output is
 * static assets.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/vite` with the
 * `@alchemy.run/frontend-frameworks/vite/node` deploy target — the package
 * must be installed in your project. During `alchemy dev` the site is
 * Vite's own dev server and no cloud resources are created.
 *
 * @resource
 * @product Website
 *
 * @section Creating Vite Sites
 * @example Basic Vite SPA
 * ```typescript
 * const site = yield* Hetzner.Website.Vite("Web");
 * ```
 *
 * @example Project in a Subdirectory
 * ```typescript
 * const site = yield* Hetzner.Website.Vite("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * @example Existing Server
 * ```typescript
 * const server = yield* Hetzner.Server("box", {
 *   serverType: "cx22",
 *   image: "ubuntu-24.04",
 *   location: "fsn1",
 * });
 * const site = yield* Hetzner.Website.Vite("Web", { server });
 * ```
 *
 * @section Multi-Page Sites
 * @example Per-Route HTML Pages with a 404 Page
 * ```typescript
 * const site = yield* Hetzner.Website.Vite("Docs", {
 *   spa: false,
 *   errorPage: "404.html",
 * });
 * ```
 *
 * @section Custom Domain
 * @example A Record on an Existing Zone
 * ```typescript
 * const site = yield* Hetzner.Website.Vite("Web", {
 *   domain: "app.example.com",
 *   zone,
 * });
 * ```
 *
 * @section Local Development
 * @example Vite Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` starts `vite` programmatically: site.url is the local
 * // dev server (HMR included); no Server or Service is created.
 * const site = yield* Hetzner.Website.Vite("Web");
 * ```
 */
export const Vite = (id: string, props: ViteProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Vite",
    framework: VITE_FRAMEWORK_SPECIFIER,
    target: VITE_NODE_TARGET_SPECIFIER,
    options: props.vite !== undefined ? { vite: props.vite } : undefined,
    static: {
      spa: props.spa ?? (props.errorPage === undefined ? true : undefined),
      errorPage: props.errorPage,
    },
  }).pipe(Namespace.push(id));
