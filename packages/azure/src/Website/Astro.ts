import * as Namespace from "alchemy/Namespace";
import {
  makeFrameworkSite,
  staticConfigFromAssets,
  type FrameworkSiteProps,
} from "./FrameworkSite.ts";

/** The framework-integration package that drives the Astro build. */
export const ASTRO_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/astro";

/** The Azure Functions deploy target for the Astro build. */
export const ASTRO_AZURE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/astro/azure";

export interface AstroProps extends FrameworkSiteProps {
  /**
   * Serializable Astro config merged OVER the project's own
   * `astro.config.*` (which loads natively). `adapter` is owned by the
   * Azure deploy target and may not be set here.
   */
  astro?: {
    /** The full URL the site deploys to (`Astro.site`). */
    site?: string;
    /** Base path the site deploys under. */
    base?: string;
    /**
     * Astro output target. `"server"` renders pages on demand on an Azure
     * Function; `"static"` prerenders every page at build time and deploys
     * assets-only to a storage static website (no Function).
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
 * Deploy an [Astro](https://astro.build) application to Azure without
 * Docker or an App Service plan. Azure Front Door Standard serves the site:
 * the client directory (`/_astro/*`, `public/` files, prerendered pages)
 * comes from the static website endpoint of an Azure Storage account, and
 * every other path renders on demand on a Flex Consumption
 * `Azure.Functions.Function` that scales to zero.
 *
 * Pages render on demand by default (`output: "server"`).
 * `astro: { output: "static" }` prerenders every page and deploys the
 * client directory only (no Function). Each file is uploaded with a
 * `Cache-Control` header (HTML is never cached, hashed assets are
 * immutable), and a redeploy purges the paths of changed files from Front
 * Door. A new Front Door endpoint takes 10-20 minutes to serve everywhere.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/astro` with the
 * `@alchemy.run/frontend-frameworks/astro/azure` deploy target — the
 * package must be installed in your project. Your `astro.config.*` must
 * not declare an adapter. During `alchemy dev` the site is Astro's own dev
 * server and no Azure resources are created.
 *
 * ### Creating Astro Sites
 * **Example:** Server-rendered Astro App
 * ```typescript
 * const site = yield* Azure.Website.Astro("Web", {
 *   rootDir: "./app",
 * });
 * // site.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Server Environment and Function Size
 * ```typescript
 * const site = yield* Azure.Website.Astro("Web", {
 *   env: { API_BASE: "https://api.example.com" },
 *   instanceMemoryMB: 4096,
 *   maximumInstanceCount: 40,
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
 * **Example:** Static Site Without Front Door
 * ```typescript
 * const site = yield* Azure.Website.Astro("Preview", {
 *   astro: { output: "static" },
 *   frontDoor: false,
 * });
 * // site.url → "https://{account}.z13.web.core.windows.net"
 * ```
 *
 * ### Front Door
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const web = yield* Azure.Website.Astro("Web", { frontDoor: { profile } });
 * const docs = yield* Azure.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   astro: { output: "static" },
 *   frontDoor: { profile },
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
    target: ASTRO_AZURE_TARGET_SPECIFIER,
    options: { astro: { ...props.astro, output } },
    static: output === "static" ? staticConfigFromAssets(props.assets) : undefined,
  }).pipe(Namespace.push(id));
};
