import * as Namespace from "alchemy/Namespace";
import {
  makeFrameworkSite,
  staticConfigFromAssets,
  type FrameworkSiteProps,
} from "./FrameworkSite.ts";

/** The framework-integration package that drives the Astro build. */
export const ASTRO_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/astro";

/** The Node deploy target for the Astro build. */
export const ASTRO_NODE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/astro/node";

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
     * assets-only to a storage static website (no server).
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
}

/**
 * Deploy an [Astro](https://astro.build) application to Azure
 * App Service: the Node adapter bundle on a Linux web app with the Node.js runtime (no Docker), static
 * assets served by the same process. Pages render on demand by default
 * (`output: "server"`); `astro: { output: "static" }` prerenders every
 * page and uploads it to the static website endpoint of a storage account.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/astro` with the
 * `@alchemy.run/frontend-frameworks/astro/node` deploy target. Your
 * `astro.config.*` must not declare an adapter.
 *
 *
 * ### Creating Astro Sites
 * **Example:** Basic Astro App
 * ```typescript
 * const site = yield* Azure.Website.Astro("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Behind Azure Front Door
 * ```typescript
 * const site = yield* Azure.Website.Astro("Web", {
 *   rootDir: "./app",
 *   frontDoor: true,
 * });
 * ```
 *
 * ### Static Sites
 * **Example:** Fully Static Astro Site
 * ```typescript
 * const site = yield* Azure.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   astro: { output: "static" },
 *   assets: { notFoundHandling: "404-page" },
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
    static: output === "static" ? staticConfigFromAssets(props.assets) : undefined,
  }).pipe(Namespace.push(id));
};
