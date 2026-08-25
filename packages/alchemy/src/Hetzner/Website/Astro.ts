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
   * `astro.config.*` (which loads natively). `adapter` is owned by the
   * Node deploy target and may not be set here.
   */
  astro?: {
    /** The full URL the site deploys to (`Astro.site`). */
    site?: string;
    /** Base path the site deploys under. */
    base?: string;
    /**
     * Astro output target. `"server"` renders pages on demand;
     * `"static"` prerenders every page at build time and deploys
     * assets-only (no SSR unit).
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
   * match no file. Only applies to `output: "static"` sites.
   */
  errorPage?: string;
  /**
   * Answer misses with the index page (200) instead of a 404. Only
   * applies to `output: "static"` sites.
   */
  spa?: boolean;
}

/**
 * Deploy an [Astro](https://astro.build) application to a Hetzner Cloud
 * Server: the Node adapter bundle as a systemd unit on port 3000, static
 * assets baked into the unit. Pages render on demand by default
 * (`output: "server"`); `astro: { output: "static" }` prerenders every
 * page and deploys assets-only.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/astro` with the
 * `@alchemy.run/frontend-frameworks/astro/node` deploy target. Your
 * `astro.config.*` must not declare an adapter.
 *
 *
 * ### Creating Astro Sites
 * **Example:** Basic Astro App
 * ```typescript
 * const site = yield* Hetzner.Website.Astro("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Hetzner.Website.Astro("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 *   zone,
 * });
 * ```
 *
 * ### Static Sites
 * **Example:** Fully Static Astro Site
 * ```typescript
 * const site = yield* Hetzner.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   astro: { output: "static" },
 *   errorPage: "404.html",
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
