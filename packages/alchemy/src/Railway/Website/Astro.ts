import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Astro build. */
export const ASTRO_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/astro";

/** The Node container deploy target for the Astro build. */
export const ASTRO_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/astro/node";

export interface AstroProps extends FrameworkSiteProps {
  /**
   * Serializable Astro config merged OVER the project's own
   * `astro.config.*` (which loads natively). `adapter` is owned by the Node
   * deploy target and may not be set here.
   */
  astro?: {
    /** The full URL the site deploys to (`Astro.site`). */
    site?: string;
    /** Base path the site deploys under. */
    base?: string;
    /**
     * Astro output target. `"server"` renders pages on demand in the
     * container; individual pages opt into prerendering with
     * `export const prerender = true`. `"static"` prerenders every page at
     * build time and deploys assets-only (no framework handler).
     * @default "server"
     */
    output?: "server" | "static";
    /** Source directory, relative to `rootDir`. @default "./src" */
    srcDir?: string;
    /** Public (static passthrough) directory. @default "./public" */
    publicDir?: string;
    /** Build output directory. @default "./dist" */
    outDir?: string;
    /** Trailing-slash handling for routes. */
    trailingSlash?: "always" | "never" | "ignore";
  };
  /**
   * Serve the built error page (e.g. astro's `404.html`) for requests that
   * match no file. Only applies to `output: "static"` sites — a
   * server-backed site forwards misses to the handler instead.
   */
  errorPage?: string;
  /**
   * Answer misses with the index page (200) instead of a 404. Only applies
   * to `output: "static"` sites.
   */
  spa?: boolean;
}

/**
 * Deploy an [Astro](https://astro.build) application to Railway: the Node
 * SSR bundle (assets first, then the Astro fetch handler) on one
 * `Railway.Service`. Pages render on demand by default
 * (`output: "server"`); pages that `export const prerender = true` are
 * prerendered at build time and served as static files. With
 * `astro: { output: "static" }` every page is prerendered and the deploy
 * is assets-only.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/astro` with the
 * `@alchemy.run/frontend-frameworks/astro/node` deploy target (a Node
 * adapter is injected — your `astro.config.*` must not declare one).
 *
 * During `alchemy dev` the site is Astro's own dev server and no cloud
 * resources are created. `Alchemy.remote()` opts back into the live
 * Service path.
 *
 * @section Creating Astro Sites
 * @example Basic Astro App
 * ```typescript
 * const site = yield* Railway.Website.Astro("Web", {
 *   rootDir: "./app",
 *   registry: "ghcr.io/acme",
 * });
 * ```
 *
 * @section Static Sites
 * @example Fully Static Astro Site
 * ```typescript
 * const site = yield* Railway.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   astro: { output: "static" },
 *   errorPage: "404.html",
 *   registry: "ghcr.io/acme",
 * });
 * ```
 *
 * @section Server Configuration
 * @example Process Environment
 * ```typescript
 * const site = yield* Railway.Website.Astro("Web", {
 *   rootDir: "./app",
 *   env: {
 *     API_BASE: "https://api.example.com",
 *   },
 *   registry: "ghcr.io/acme",
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Astro = (id: string, props: AstroProps = {}) => {
  const output = props.astro?.output ?? "server";
  return makeFrameworkSite(id, props, {
    name: "Astro",
    framework: ASTRO_FRAMEWORK_SPECIFIER,
    target: ASTRO_NODE_TARGET_SPECIFIER,
    options: { astro: { ...props.astro, output } },
    static:
      output === "static"
        ? { spa: props.spa, errorPage: props.errorPage }
        : undefined,
  }).pipe(Namespace.push(id));
};
