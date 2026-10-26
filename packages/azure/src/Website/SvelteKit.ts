import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the SvelteKit build. */
export const SVELTEKIT_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/sveltekit";

/** The Azure Functions deploy target for the SvelteKit build. */
export const SVELTEKIT_AZURE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/sveltekit/azure";

export interface SvelteKitProps extends FrameworkSiteProps {
  /**
   * SvelteKit configuration passed to the `sveltekit(config)` Vite plugin.
   * The `adapter` field is injected by the Azure deploy target and may not
   * be set here. Must be JSON-serializable (it persists in state).
   */
  kit?: Record<string, unknown>;
}

/**
 * Deploy a [SvelteKit](https://svelte.dev/docs/kit) application to Azure
 * without Docker or an App Service plan. Kit's server (`load` functions,
 * `+server.ts` endpoints, form actions) runs on a Flex Consumption
 * `Azure.Functions.Function` that scales to zero. The client assets and
 * prerendered pages go to the static website endpoint of an Azure Storage
 * account. Azure Front Door Standard sends the asset paths (`/_app/*`,
 * `static/` files) to Blob Storage and every other path to the Function.
 *
 * Kit answers `404` for a prerendered route (`export const prerender =
 * true`), so the Function fetches that route's HTML file (`about.html` for
 * `/about`) from Blob Storage through Front Door.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/sveltekit` with
 * the `@alchemy.run/frontend-frameworks/sveltekit/azure` deploy target.
 * Install the package in your project alongside `@sveltejs/kit`,
 * `@sveltejs/vite-plugin-svelte`, `svelte`, and `vite`. Your
 * `vite.config.ts` loads natively and declares no adapter. Each file is
 * uploaded with a `Cache-Control` header (HTML is never cached, hashed
 * assets are immutable), and a redeploy purges the paths of changed files
 * from Front Door.
 *
 * Front Door Standard costs a monthly base fee per profile: pass
 * `frontDoor: { profile }` to share one profile across sites. A new Front
 * Door endpoint takes 10-20 minutes to serve everywhere. During
 * `alchemy dev` the site is kit's own Vite dev server and no Azure
 * resources are created.
 *
 * ### Creating SvelteKit Sites
 * **Example:** Basic SvelteKit App
 * ```typescript
 * const site = yield* Azure.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 * });
 * // site.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const site = yield* Azure.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** App Settings and Function Size
 * ```typescript
 * const site = yield* Azure.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 *   env: { API_BASE: "https://api.example.com" },
 *   instanceMemoryMB: 512,
 *   maximumInstanceCount: 40,
 * });
 * ```
 *
 * **Example:** Read An App Setting In A Server Load
 * ```typescript
 * // src/routes/+page.server.ts
 * export const load = () => ({
 *   apiBase: process.env.API_BASE,
 * });
 * ```
 *
 * ### Kit Options
 * **Example:** Override Kit Options At Deploy Time
 * ```typescript
 * const site = yield* Azure.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 *   kit: { prerender: { handleHttpError: "warn" } },
 * });
 * ```
 *
 * ### Local Development
 * **Example:** Kit Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` runs kit's Vite dev server: site.url is the local
 * // server (HMR included); no Azure resources are created.
 * const site = yield* Azure.Website.SvelteKit("Web", { rootDir: "./app" });
 * ```
 *
 * @resource
 * @product Website
 */
export const SvelteKit = (id: string, props: SvelteKitProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "SvelteKit",
    framework: SVELTEKIT_FRAMEWORK_SPECIFIER,
    target: SVELTEKIT_AZURE_TARGET_SPECIFIER,
    options: props.kit ? { kit: props.kit } : undefined,
  }).pipe(Namespace.push(id));
