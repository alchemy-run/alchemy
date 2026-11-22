import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the React Router build. */
export const REACT_ROUTER_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/react-router";

/** The Azure Functions deploy target for the React Router build. */
export const REACT_ROUTER_AZURE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/react-router/azure";

export interface ReactRouterProps extends FrameworkSiteProps {}

/**
 * Deploy a [React Router](https://reactrouter.com) v7 app (framework mode)
 * to Azure without Docker or an App Service plan. The server build's
 * loaders, actions, and page renders run on a Flex Consumption Function
 * (scale to zero), the client assets go to the static website endpoint of
 * an Azure Storage account, and Azure Front Door sends pages to the
 * Function and the asset paths (`/assets/*`, `/favicon.ico`, …) to Blob
 * Storage.
 *
 * The build runs through
 * `@alchemy.run/frontend-frameworks/react-router` with the
 * `@alchemy.run/frontend-frameworks/react-router/azure` deploy target —
 * install the package in your project, alongside `@react-router/dev`,
 * `react-router`, and `vite`. Your `vite.config.ts` needs no adapter
 * wiring: the integration wraps React Router's `ServerBuild` manifest with
 * `createRequestHandler`, and the target turns it into an Azure Functions
 * Fetch handler. Each asset is uploaded with a `Cache-Control` header and
 * a redeploy purges the replaced paths from Front Door.
 *
 * React Server Components (React Router's `unstable` RSC plugin) and
 * multi-environment builds are not supported yet — the build fails with an
 * actionable error when more than one server entry is emitted.
 *
 * Front Door Standard costs a monthly base fee per profile: pass
 * `frontDoor: { profile }` to share one profile across sites. A new Front
 * Door endpoint takes 10-20 minutes to serve everywhere. During
 * `alchemy dev` the site is React Router's own Vite dev server and no
 * Azure resources are created.
 *
 * ### Creating React Router Sites
 * **Example:** Basic React Router App
 * ```typescript
 * const site = yield* Azure.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 * });
 * // site.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const site = yield* Azure.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** App Settings
 * ```typescript
 * const site = yield* Azure.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 *   env: {
 *     API_BASE: "https://api.example.com",
 *   },
 * });
 * ```
 *
 * **Example:** Read An App Setting From A Loader
 * ```typescript
 * // app/routes/home.tsx
 * export function loader() {
 *   return { apiBase: process.env.API_BASE ?? "unset" };
 * }
 * ```
 *
 * ### Local Development
 * **Example:** React Router Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` runs React Router's Vite dev server: site.url is the
 * // local server (HMR included); no Azure resources are created.
 * const site = yield* Azure.Website.ReactRouter("Web", { rootDir: "./app" });
 * ```
 *
 * @resource
 * @product Website
 */
export const ReactRouter = (id: string, props: ReactRouterProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "ReactRouter",
    framework: REACT_ROUTER_FRAMEWORK_SPECIFIER,
    target: REACT_ROUTER_AZURE_TARGET_SPECIFIER,
  }).pipe(Namespace.push(id));
