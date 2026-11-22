import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Waku build. */
export const WAKU_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/waku";

/** The Azure Functions deploy target for the Waku build. */
export const WAKU_AZURE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/waku/azure";

const wakuOptions = (props: WakuProps) =>
  props.waku !== undefined ? { waku: props.waku } : undefined;

export interface WakuProps extends FrameworkSiteProps {
  /**
   * Serializable Waku config merged OVER the project's own
   * `waku.config.*`.
   */
  waku?: {
    srcDir?: string;
    distDir?: string;
    basePath?: string;
  };
}

/**
 * Deploy a [Waku](https://waku.gg) application to Azure: the React Server
 * Components server on a Flex Consumption `Azure.Functions.Function` that
 * scales to zero, and the client assets (`/assets/*`, `public/`,
 * prerendered HTML) in a storage account's `$web` container. Azure Front
 * Door Standard sends the assets to Blob Storage, cached at the edge, and
 * every other path (dynamic and prerendered pages, RSC payloads, API
 * routes) to the Function. No App Service plan and no containers.
 *
 * The Function reads `env` as app settings, so `getEnv("NAME")` in a
 * dynamic page or API route sees the value at request time.
 *
 * Front Door is required (a server build cannot use `frontDoor: false`)
 * and costs a monthly base fee per profile: pass `frontDoor: { profile }` to
 * share one profile across sites. A new Front Door endpoint takes 10-20
 * minutes to serve everywhere.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/waku` with the
 * `@alchemy.run/frontend-frameworks/waku/azure` deploy target, which must
 * be installed in your project. During `alchemy dev` the site is Waku's own
 * dev server and no cloud resources are created.
 *
 *
 * ### Creating Waku Sites
 * **Example:** Basic Waku App
 * ```typescript
 * const site = yield* Azure.Website.Waku("Web", {
 *   rootDir: "./app",
 * });
 * // site.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Server Environment
 * ```typescript
 * const site = yield* Azure.Website.Waku("Web", {
 *   env: { GREETING: "Hello from Azure" },
 * });
 * // src/pages/index.tsx: const greeting = getEnv("GREETING");
 * ```
 *
 * **Example:** Waku Config Overrides
 * ```typescript
 * const site = yield* Azure.Website.Waku("Web", {
 *   waku: { srcDir: "app", distDir: "build" },
 * });
 * ```
 *
 * ### Front Door
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const web = yield* Azure.Website.Waku("Web", { frontDoor: { profile } });
 * const docs = yield* Azure.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * ### Server Function
 * **Example:** Size the server Function
 * ```typescript
 * const site = yield* Azure.Website.Waku("Web", {
 *   location: "eastus",
 *   instanceMemoryMB: 4096,
 *   maximumInstanceCount: 200,
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Waku = (id: string, props: WakuProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Waku",
    framework: WAKU_FRAMEWORK_SPECIFIER,
    target: WAKU_AZURE_TARGET_SPECIFIER,
    options: wakuOptions(props),
    htmlHandling: "drop-trailing-slash",
  }).pipe(Namespace.push(id));
