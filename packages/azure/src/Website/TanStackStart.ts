import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the TanStack Start build. */
export const TANSTACK_START_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/tanstack-start";

/** The Azure Functions deploy target for the TanStack Start build. */
export const TANSTACK_START_AZURE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/tanstack-start/azure";

export interface TanStackStartProps extends FrameworkSiteProps {}

/**
 * Deploy a [TanStack Start](https://tanstack.com/start) application to
 * Azure without Docker or an App Service plan. Server-side rendering,
 * server functions, and server routes run on a Flex Consumption Function
 * (scale to zero), the client assets go to the static website endpoint of
 * an Azure Storage account, and Azure Front Door sends pages to the
 * Function and the asset paths (`/assets/*`, `/robots.txt`, …) to Blob
 * Storage.
 *
 * The build runs through
 * `@alchemy.run/frontend-frameworks/tanstack-start` with the
 * `@alchemy.run/frontend-frameworks/tanstack-start/azure` deploy target —
 * install the package in your project, alongside `@tanstack/react-start`
 * (or `@tanstack/solid-start`) and `vite`. Your `vite.config.ts` needs no
 * adapter wiring: TanStack Start is pure Vite, so the integration drives
 * the project's own `vite build`, forces the SSR bundle to be
 * self-contained, and the target wraps its fetch handler as an Azure
 * Functions Fetch handler. Each asset is uploaded with a `Cache-Control`
 * header (hashed assets are immutable) and a redeploy purges the replaced
 * paths from Front Door.
 *
 * Front Door Standard costs a monthly base fee per profile: pass
 * `frontDoor: { profile }` to share one profile across sites. A new Front
 * Door endpoint takes 10-20 minutes to serve everywhere. During
 * `alchemy dev` the site is TanStack Start's own Vite dev server and no
 * Azure resources are created.
 *
 * ### Creating TanStack Start Sites
 * **Example:** Basic TanStack Start App
 * ```typescript
 * const site = yield* Azure.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 * });
 * // site.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const site = yield* Azure.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** App Settings
 * ```typescript
 * const site = yield* Azure.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 *   env: {
 *     API_BASE: "https://api.example.com",
 *   },
 * });
 * ```
 *
 * **Example:** Read An App Setting From A Server Function
 * ```typescript
 * // src/routes/index.tsx
 * const getApiBase = createServerFn({ method: "GET" }).handler(() => ({
 *   apiBase: process.env.API_BASE,
 * }));
 * ```
 *
 * **Example:** Function Size
 * ```typescript
 * const site = yield* Azure.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 *   instanceMemoryMB: 512,
 *   maximumInstanceCount: 40,
 * });
 * ```
 *
 * ### Local Development
 * **Example:** TanStack Start Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` runs TanStack Start's Vite dev server: site.url is the
 * // local server (HMR included); no Azure resources are created.
 * const site = yield* Azure.Website.TanStackStart("Web", { rootDir: "./app" });
 * ```
 *
 * @resource
 * @product Website
 */
export const TanStackStart = (id: string, props: TanStackStartProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "TanStackStart",
    framework: TANSTACK_START_FRAMEWORK_SPECIFIER,
    target: TANSTACK_START_AZURE_TARGET_SPECIFIER,
  }).pipe(Namespace.push(id));
