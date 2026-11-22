import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The framework-integration module that drives `next build` for Azure
 * Functions: Next's standalone server behind a Fetch entry. Not OpenNext.
 */
export const NEXTJS_AZURE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/nextjs/azure";

export interface NextjsProps extends FrameworkSiteProps {}

/**
 * Deploy a [Next.js](https://nextjs.org) application to Azure without
 * Docker or an App Service plan. Azure Front Door Standard serves the site:
 * `/_next/static/*` and the `public/` files come from the static website
 * endpoint of an Azure Storage account, and every other path (pages, route
 * handlers, server actions, `/_next/image`) runs on a Flex Consumption
 * `Azure.Functions.Function` that scales to zero.
 *
 * The build runs `next build` with Next's standalone output (no change to
 * `next.config.*`; a config that sets `output: "export"` fails). The
 * standalone server directory, with its traced `node_modules`, ships in the
 * Function package as-is, and Next starts in production mode on the first
 * request. Each asset is uploaded with a `Cache-Control` header (HTML is
 * never cached, hashed files are immutable), and a redeploy purges the
 * paths of changed files from Front Door. A new Front Door endpoint takes
 * 10-20 minutes to serve everywhere.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/nextjs/azure` —
 * the package must be installed in your project. During `alchemy dev` the
 * site is `next dev` and no Azure resources are created; `Alchemy.remote()`
 * opts back into the live deployment.
 *
 * ### Creating Next.js Sites
 * **Example:** Server-rendered Next.js App
 * ```typescript
 * const site = yield* Azure.Website.Nextjs("Web", {
 *   rootDir: "./app",
 * });
 * // site.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Server Environment and Function Size
 * ```typescript
 * const site = yield* Azure.Website.Nextjs("Web", {
 *   rootDir: "./app",
 *   env: { API_URL: api.url },
 *   instanceMemoryMB: 4096,
 *   maximumInstanceCount: 40,
 * });
 * ```
 *
 * ### Sharing Front Door
 * **Example:** Add the Site to an Existing Front Door Profile
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const site = yield* Azure.Website.Nextjs("Web", {
 *   rootDir: "./app",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Nextjs = (id: string, props: NextjsProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Next.js",
    framework: NEXTJS_AZURE_FRAMEWORK_SPECIFIER,
    target: NEXTJS_AZURE_FRAMEWORK_SPECIFIER,
    serverDirectory: true,
    nestedAssetDirectories: ["_next"],
  }).pipe(Namespace.push(id));
