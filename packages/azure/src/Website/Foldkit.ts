import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";
import type { ViteProps } from "./Vite.ts";

/** The framework-integration package that drives the Foldkit build. */
export const FOLDKIT_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/foldkit";

/** The Azure Functions deploy target for the Foldkit build. */
export const FOLDKIT_AZURE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/foldkit/azure";

export interface FoldkitProps extends FrameworkSiteProps {
  /** Serializable overrides merged over the project's `vite.config.*`. */
  vite?: ViteProps["vite"];
  /**
   * Deployment topology, declared before building. `"server"` runs
   * Foldkit's generated request handler on a Flex Consumption Azure
   * Function for SSR and hybrid routes; `"static"` publishes only the
   * prerendered pages. Omit for a browser-only SPA. A server build requires
   * an explicit choice.
   */
  output?: "server" | "static";
}

/**
 * Deploy a [Foldkit](https://foldkit.dev) app to Azure without Docker or
 * an App Service plan. Azure Front Door Standard serves the site from the
 * static website endpoint of an Azure Storage account.
 *
 * A browser-only app (the default) and a prerendered app
 * (`output: "static"`) deploy their client directory only. A browser-only
 * app routes on the client: Front Door rewrites extensionless paths such as
 * `/counter/42` to `/index.html`, so deep links load the app shell with a
 * `200` status. With `output: "server"`, Foldkit's generated request
 * handler runs on a Flex Consumption `Azure.Functions.Function` that scales
 * to zero: Front Door sends the client directory's paths (`/assets/*`,
 * `public/` files) to Blob Storage and every other path to the Function.
 *
 * The Foldkit Vite plugin in your project's own `vite.config.*` owns
 * rendering and prerendering — enable `ssr.build` there for SSR or SSG.
 * The build runs through `@alchemy.run/frontend-frameworks/foldkit` with
 * the `@alchemy.run/frontend-frameworks/foldkit/azure` deploy target — the
 * package must be installed in your project. Input files are
 * content-hashed so unchanged projects skip the build and the upload; a
 * redeploy purges the paths of changed files from Front Door. A new Front
 * Door endpoint takes 10-20 minutes to serve everywhere.
 *
 * During `alchemy dev` the site is Foldkit's own Vite dev server (HMR and
 * devtools included) and no Azure resources are created.
 * `Alchemy.remote()` opts back into the full deployment.
 *
 * ### Creating Foldkit Sites
 * **Example:** Browser-only SPA behind Front Door
 * ```typescript
 * const site = yield* Azure.Website.Foldkit("Web");
 * // site.url → "https://{endpoint}.z01.azurefd.net"
 * ```
 *
 * **Example:** Project in a Subdirectory
 * ```typescript
 * const site = yield* Azure.Website.Foldkit("Web", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * ### Deep Links
 * Front Door answers a browser-only app's deep links with the app shell
 * and a `200` status. An app that ships a real 404 page opts out of the
 * SPA fallback with `assets.notFoundHandling`. `frontDoor: false` serves
 * straight from the storage endpoint, which answers a deep link with the
 * app shell and a `404` status.
 *
 * **Example:** Serving a Real 404 Page
 * ```typescript
 * const site = yield* Azure.Website.Foldkit("Web", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * **Example:** Storage Endpoint Without Front Door
 * ```typescript
 * const site = yield* Azure.Website.Foldkit("Preview", { frontDoor: false });
 * // site.url → "https://{account}.z13.web.core.windows.net"
 * ```
 *
 * ### Static Generation
 * `output: "static"` publishes only the prerendered pages; no Function is
 * created.
 *
 * **Example:** Prerendered Pages Without a Server
 * ```typescript
 * const site = yield* Azure.Website.Foldkit("Docs", {
 *   output: "static",
 * });
 * ```
 *
 * ### Server Rendering
 * Set `output: "server"` when `ssr.build` produces a server handler. A
 * server build needs Front Door.
 *
 * **Example:** SSR on an Azure Function
 * ```typescript
 * const site = yield* Azure.Website.Foldkit("Web", {
 *   output: "server",
 *   env: { API_BASE: "https://api.example.com" },
 *   instanceMemoryMB: 2048,
 * });
 * ```
 *
 * ### Front Door
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const web = yield* Azure.Website.Foldkit("Web", {
 *   output: "server",
 *   frontDoor: { profile },
 * });
 * const docs = yield* Azure.Website.Foldkit("Docs", {
 *   rootDir: "./docs",
 *   output: "static",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Foldkit = (id: string, props: FoldkitProps = {}) => {
  const handling = props.assets?.notFoundHandling;
  const errorPage = handling === "404-page" ? "404.html" : undefined;
  return makeFrameworkSite(id, props, {
    name: "Foldkit",
    framework: FOLDKIT_FRAMEWORK_SPECIFIER,
    target: FOLDKIT_AZURE_TARGET_SPECIFIER,
    options: {
      vite: props.vite,
      output: props.output ?? "spa",
      notFoundHandling: handling === "single-page-application" ? "spa" : handling,
      htmlHandling: props.assets?.htmlHandling,
    },
    // Browser-only and prerendered builds are assets-only. Browser-only
    // apps route on the client, so the SPA fallback is on unless the app
    // asks for a 404 page.
    static:
      props.output === "server"
        ? undefined
        : {
            spa:
              handling === "single-page-application" ||
              (handling === undefined && props.output === undefined),
            errorPage,
          },
  }).pipe(Namespace.push(id));
};
