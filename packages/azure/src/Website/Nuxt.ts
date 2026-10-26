import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Nuxt build. */
export const NUXT_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/nuxt";

/** The Azure Functions deploy target for the Nuxt build. */
export const NUXT_AZURE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/nuxt/azure";

export interface NuxtProps extends FrameworkSiteProps {
  /**
   * Nuxt config overrides merged over the project's own `nuxt.config.ts`
   * (highest-priority layer). `nitro.preset` is owned by the Azure deploy
   * target and may not be set here.
   */
  nuxt?: Record<string, unknown>;
}

/**
 * Deploy a [Nuxt](https://nuxt.com) application to Azure without Docker or
 * an App Service plan. Azure Front Door Standard serves the site: the
 * client directory (`/_nuxt/*`, `public/` files, prerendered routes) comes
 * from the static website endpoint of an Azure Storage account, and every
 * other path (pages, `server/api` routes) renders on a Flex Consumption
 * `Azure.Functions.Function` that scales to zero.
 *
 * Nitro builds with its `node` preset and the Function bundles
 * `.output/server` into one Node.js module. Each asset is uploaded with a
 * `Cache-Control` header (HTML is never cached, hashed files are
 * immutable), and a redeploy purges the paths of changed files from Front
 * Door. A new Front Door endpoint takes 10-20 minutes to serve everywhere.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/nuxt` with the
 * `@alchemy.run/frontend-frameworks/nuxt/azure` deploy target — the package
 * must be installed in your project. Your `nuxt.config.ts` must not set
 * `nitro.preset`. During `alchemy dev` the site is `nuxt dev` and no Azure
 * resources are created; `Alchemy.remote()` opts back into the live
 * deployment.
 *
 * ### Creating Nuxt Sites
 * **Example:** Server-rendered Nuxt App
 * ```typescript
 * const site = yield* Azure.Website.Nuxt("Web", {
 *   rootDir: "./app",
 * });
 * // site.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Runtime Config from the Environment
 * ```typescript
 * // NUXT_PUBLIC_* app settings override `runtimeConfig.public` at run time.
 * const site = yield* Azure.Website.Nuxt("Web", {
 *   rootDir: "./app",
 *   env: { NUXT_PUBLIC_API_URL: api.url },
 * });
 * ```
 *
 * **Example:** Nuxt Config Overrides
 * ```typescript
 * const site = yield* Azure.Website.Nuxt("Web", {
 *   rootDir: "./app",
 *   nuxt: { routeRules: { "/about": { prerender: true } } },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Nuxt = (id: string, props: NuxtProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Nuxt",
    framework: NUXT_FRAMEWORK_SPECIFIER,
    target: NUXT_AZURE_TARGET_SPECIFIER,
    options: props.nuxt ? { nuxt: props.nuxt } : undefined,
  }).pipe(Namespace.push(id));
