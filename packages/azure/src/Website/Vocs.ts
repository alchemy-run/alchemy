import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The framework-integration module that drives the Vocs build: Vocs' own dev
 * server, and a build for Azure Functions.
 */
export const VOCS_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vocs/azure";

/** The Azure Functions deploy target for the Vocs build. */
export const VOCS_AZURE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/vocs/azure";

export interface VocsProps extends FrameworkSiteProps {
  /**
   * Vocs build output directory, relative to {@link rootDir}. Set this when
   * `vocs.config.*` customizes `outDir` so generated output stays outside the
   * rebuild hash.
   * @default "dist"
   */
  outDir?: string;
}

/**
 * Deploy a [Vocs](https://vocs.dev) documentation site to Azure: the Vocs
 * (Waku RSC) server on a Flex Consumption `Azure.Functions.Function` that
 * scales to zero, and the client assets (`/assets/*`, `public/`,
 * `llms.txt`) in a storage account's `$web` container. Azure Front Door
 * Standard sends the assets to Blob Storage, cached at the edge, and every
 * other path (pages, RSC payloads, trailing-slash redirects) to the
 * Function. No App Service plan and no containers.
 *
 * Front Door is required (a server build cannot use `frontDoor: false`)
 * and costs a monthly base fee per profile: pass `frontDoor: { profile }` to
 * share one profile across sites. A new Front Door endpoint takes 10-20
 * minutes to serve everywhere.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/vocs/azure`,
 * which must be installed in your project. During `alchemy dev` the site is
 * Vocs' own dev server and no cloud resources are created.
 *
 *
 * ### Creating Vocs Sites
 * **Example:** Vocs Documentation Site
 * ```typescript
 * const docs = yield* Azure.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 * });
 * // docs.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Custom Output Directory
 * ```typescript
 * const docs = yield* Azure.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 *   outDir: "build",
 * });
 * ```
 *
 * ### Front Door
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const docs = yield* Azure.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 *   frontDoor: { profile },
 * });
 * const web = yield* Azure.Website.Waku("Web", { frontDoor: { profile } });
 * ```
 *
 * ### Server Function
 * **Example:** Size the server Function
 * ```typescript
 * const docs = yield* Azure.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 *   location: "eastus",
 *   instanceMemoryMB: 512,
 *   maximumInstanceCount: 40,
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Vocs = (id: string, props: VocsProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Vocs",
    framework: VOCS_FRAMEWORK_SPECIFIER,
    target: VOCS_AZURE_TARGET_SPECIFIER,
    options: props.outDir !== undefined ? { outDir: props.outDir } : undefined,
    htmlHandling: "drop-trailing-slash",
  }).pipe(Namespace.push(id));
