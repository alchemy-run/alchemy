import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The framework-integration module that drives vinext's Vite build and is
 * also its Azure Functions deploy target.
 */
export const VINEXT_AZURE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vinext/azure";

export interface VinextProps extends FrameworkSiteProps {}

/**
 * Deploy a [vinext](https://vinext.dev) App Router application to Azure
 * without Docker or an App Service plan. vinext's Vite build renders on a
 * Flex Consumption Function (scale to zero), the client assets go to the
 * static website endpoint of an Azure Storage account, and Azure Front
 * Door sends pages and route handlers to the Function and the asset paths
 * (`/_next/static/*`, `/favicon.ico`, …) to Blob Storage.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/vinext/azure` —
 * install the package in your project, alongside `vinext`, `react`,
 * `react-dom`, `react-server-dom-webpack`, and `vite`. The target wraps
 * vinext's App Router fetch handler (`dist/server/index.js`) as an Azure
 * Functions Fetch handler and bundles React into the server, so the
 * Function needs no `node_modules`. Pages Router builds are not supported:
 * the build fails without an App Router entry.
 *
 * Front Door Standard costs a monthly base fee per profile: pass
 * `frontDoor: { profile }` to share one profile across sites. A new Front
 * Door endpoint takes 10-20 minutes to serve everywhere. During
 * `alchemy dev` the site is `vinext dev` and no Azure resources are
 * created; `Alchemy.remote()` opts back into the live deployment.
 *
 * ### Creating vinext Sites
 * **Example:** Basic vinext App
 * ```typescript
 * const site = yield* Azure.Website.Vinext("Web", {
 *   rootDir: "./app",
 * });
 * // site.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const site = yield* Azure.Website.Vinext("Web", {
 *   rootDir: "./app",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** App Settings Read By A Route Handler
 * ```typescript
 * const site = yield* Azure.Website.Vinext("Web", {
 *   rootDir: "./app",
 *   env: { GREETING: "Hello from vinext on Azure!" },
 * });
 * // app/api/hello/route.ts
 * // export const GET = () => Response.json({ greeting: process.env.GREETING });
 * ```
 *
 * **Example:** Redis data cache
 * ISR and `"use cache"` default to the Function's in-process memory, so
 * each instance keeps its own cache. Set `env.REDIS_URL` for a shared
 * Redis store; the adapter is injected automatically.
 * ```typescript
 * const site = yield* Azure.Website.Vinext("Web", {
 *   rootDir: "./app",
 *   env: {
 *     REDIS_URL: "rediss://:password@cache.redis.cache.windows.net:6380",
 *   },
 * });
 * ```
 *
 * ### Local Development
 * **Example:** vinext Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` runs `vinext dev`: site.url is the local server (HMR
 * // included); no Azure resources are created.
 * const site = yield* Azure.Website.Vinext("Web", { rootDir: "./app" });
 * ```
 *
 * @resource
 * @product Website
 */
export const Vinext = (id: string, props: VinextProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Vinext",
    framework: VINEXT_AZURE_FRAMEWORK_SPECIFIER,
    target: VINEXT_AZURE_FRAMEWORK_SPECIFIER,
    // `/_next/static/*` comes from Blob Storage; `/_next/image` renders.
    nestedAssetDirectories: ["_next"],
  }).pipe(Namespace.push(id));
