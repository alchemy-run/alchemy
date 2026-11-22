import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Octane build. */
export const OCTANE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/octane";

/** The Azure Functions deploy target for the Octane build. */
export const OCTANE_AZURE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/octane/azure";

export interface OctaneProps extends FrameworkSiteProps {}

/**
 * Deploy an [OctaneJS](https://octanejs.dev) application to Azure without
 * Docker or an App Service plan. Octane's fetch handler runs on a Flex
 * Consumption Function (scale to zero), the client assets go to the static
 * website endpoint of an Azure Storage account, and Azure Front Door sends
 * pages and server routes to the Function and the asset paths to Blob
 * Storage.
 *
 * `Azure.Website.Octane` wraps Octane's default native Node output with
 * the `@alchemy.run/frontend-frameworks/octane/azure` target. Keep
 * compiler and route settings in `octane.config.ts` without an adapter.
 * Each asset is uploaded with a `Cache-Control` header (hashed assets are
 * immutable) and a redeploy purges the replaced paths from Front Door.
 *
 * Front Door Standard costs a monthly base fee per profile: pass
 * `frontDoor: { profile }` to share one profile across sites. A new Front
 * Door endpoint takes 10-20 minutes to serve everywhere. During
 * `alchemy dev` the site is Octane's own Vite dev server and no Azure
 * resources are created.
 *
 * ### Creating Octane Sites
 * **Example:** Basic Octane App
 * ```typescript
 * const site = yield* Azure.Website.Octane("Web", {
 *   rootDir: "./app",
 * });
 * // site.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const site = yield* Azure.Website.Octane("Web", {
 *   rootDir: "./app",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** App settings and Function size
 * ```typescript
 * const site = yield* Azure.Website.Octane("Web", {
 *   rootDir: "./app",
 *   env: { API_BASE: "https://api.example.com" },
 *   instanceMemoryMB: 512,
 *   maximumInstanceCount: 40,
 * });
 * ```
 *
 * ### Local Development
 * **Example:** Octane Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` runs Octane's Vite dev server: site.url is the local
 * // server (HMR included); no Azure resources are created.
 * const site = yield* Azure.Website.Octane("Web", { rootDir: "./app" });
 * ```
 *
 * @resource
 * @product Website
 */
export const Octane = (id: string, props: OctaneProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Octane",
    framework: OCTANE_FRAMEWORK_SPECIFIER,
    target: OCTANE_AZURE_TARGET_SPECIFIER,
  }).pipe(Namespace.push(id));
