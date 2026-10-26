import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the SolidStart build. */
export const SOLIDSTART_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/solidstart";

/** The Azure Functions deploy target for the SolidStart build. */
export const SOLIDSTART_AZURE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/solidstart/azure";

export interface SolidStartProps extends FrameworkSiteProps {
  /**
   * Nitro options forwarded into the nitro plugin the integration appends
   * (prerendering, route rules, storage, ...). `preset` is owned by the
   * Azure deploy target and may not be set here. JSON-serializable values
   * only — no functions or plugin instances.
   *
   * This is a prop (rather than project config) because the integration
   * owns the nitro plugin instance: a `nitroV2Plugin()` in your project's
   * `vite.config.*` is rejected, so this prop is the one home for nitro
   * options — and it accepts values derived from other resources' Outputs,
   * which a config file cannot.
   */
  nitro?: Record<string, unknown>;
}

/**
 * Deploy a [SolidStart](https://start.solidjs.com) application to Azure
 * without Docker or an App Service plan. The nitro server (SSR pages, API
 * routes, server functions) runs on a Flex Consumption
 * `Azure.Functions.Function` that scales to zero. The client assets and
 * prerendered pages (`.output/public`) go to the static website endpoint
 * of an Azure Storage account. Azure Front Door Standard sends the asset
 * paths (`/_build/*`, `public/` files) to Blob Storage and every other path
 * to the Function.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/solidstart`
 * with the `@alchemy.run/frontend-frameworks/solidstart/azure` deploy
 * target. Install the package in your project alongside `@solidjs/start`
 * and `@solidjs/vite-plugin-nitro-2`. Your `vite.config.ts` needs no
 * adapter wiring: the integration drives the project's own `vite build`
 * and appends its own nitro plugin instance. Each file is uploaded with a
 * `Cache-Control` header (HTML is never cached, hashed assets are
 * immutable), and a redeploy purges the paths of changed files from Front
 * Door.
 *
 * Front Door Standard costs a monthly base fee per profile: pass
 * `frontDoor: { profile }` to share one profile across sites. A new Front
 * Door endpoint takes 10-20 minutes to serve everywhere. During
 * `alchemy dev` the site is SolidStart's own Vite dev server and no Azure
 * resources are created.
 *
 * ### Creating SolidStart Sites
 * **Example:** Basic SolidStart App
 * ```typescript
 * const site = yield* Azure.Website.SolidStart("Web", {
 *   rootDir: "./app",
 * });
 * // site.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const site = yield* Azure.Website.SolidStart("Web", {
 *   rootDir: "./app",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** App Settings and Function Size
 * ```typescript
 * const site = yield* Azure.Website.SolidStart("Web", {
 *   rootDir: "./app",
 *   env: { API_BASE: "https://api.example.com" },
 *   instanceMemoryMB: 512,
 *   maximumInstanceCount: 40,
 * });
 * ```
 *
 * ### Prerendering
 * The integration owns the nitro plugin instance (a `nitroV2Plugin()` in
 * your `vite.config.*` is rejected), so nitro options — prerendering
 * included — go on the `nitro` prop. Prerendered pages are uploaded with
 * the client assets. Front Door serves `/about/` from Blob Storage; a
 * request for `/about` reaches the Function, which renders the same page.
 *
 * **Example:** Prerender Routes
 * ```typescript
 * const site = yield* Azure.Website.SolidStart("Web", {
 *   rootDir: "./app",
 *   nitro: { prerender: { routes: ["/", "/about"] } },
 * });
 * ```
 *
 * ### Local Development
 * **Example:** SolidStart Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` runs SolidStart's Vite dev server: site.url is the
 * // local server (HMR included); no Azure resources are created.
 * const site = yield* Azure.Website.SolidStart("Web", { rootDir: "./app" });
 * ```
 *
 * @resource
 * @product Website
 */
export const SolidStart = (id: string, props: SolidStartProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "SolidStart",
    framework: SOLIDSTART_FRAMEWORK_SPECIFIER,
    target: SOLIDSTART_AZURE_TARGET_SPECIFIER,
    options: { nitro: props.nitro },
  }).pipe(Namespace.push(id));
