import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";
import type { ViteProps } from "./Vite.ts";

/** The framework-integration package that drives the Foldkit build. */
export const FOLDKIT_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/foldkit";

/** The Node deploy target for the Foldkit build. */
export const FOLDKIT_NODE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/foldkit/node";

export interface FoldkitProps extends FrameworkSiteProps {
  /** Serializable overrides merged over the project's `vite.config.*`. */
  vite?: ViteProps["vite"];
  /**
   * Deployment topology, declared before building. `"server"` runs
   * Foldkit's generated request handler on App Service for SSR and hybrid
   * routes; `"static"` publishes only the prerendered pages. Omit for a
   * browser-only SPA. A server build requires an explicit choice.
   */
  output?: "server" | "static";
}

/**
 * Deploy a [Foldkit](https://foldkit.dev) app to Azure without Docker.
 *
 * A browser-only app (the default) and a prerendered app
 * (`output: "static"`) are uploaded to the static website endpoint of an
 * Azure Storage account. A browser-only app routes on the client, so a
 * deep link like `/counter/42` loads the app shell. With
 * `output: "server"`, Foldkit's generated fetch handler runs on an App
 * Service web app with the Node.js runtime, and the same process serves
 * the client assets and prerendered pages.
 *
 * The Foldkit Vite plugin in your project's own `vite.config.*` owns
 * rendering and prerendering — enable `ssr.build` there for SSR or SSG.
 * The build runs through `@alchemy.run/frontend-frameworks/foldkit`, which
 * must be installed in your project. Input files are content-hashed so
 * unchanged projects skip the build and the upload.
 *
 * During `alchemy dev` the site is Foldkit's own Vite dev server (HMR and
 * devtools included) and no Azure resources are created.
 * `Alchemy.remote()` opts back into the full deployment.
 *
 * ### Creating Foldkit Sites
 * **Example:** Browser-only SPA on a storage static website
 * ```typescript
 * const site = yield* Azure.Website.Foldkit("Web");
 * // site.url → "https://{account}.z13.web.core.windows.net"
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
 * The storage endpoint answers a deep link with the app shell and a `404`
 * status. Put Azure Front Door in front of the site to answer it with a
 * `200` status (Front Door rewrites extensionless paths to `/index.html`).
 * An app that ships a real 404 page opts out of the SPA fallback with
 * `assets.notFoundHandling`.
 *
 * **Example:** SPA Behind Front Door
 * ```typescript
 * const site = yield* Azure.Website.Foldkit("Web", {
 *   frontDoor: true,
 * });
 * ```
 *
 * **Example:** Serving a Real 404 Page
 * ```typescript
 * const site = yield* Azure.Website.Foldkit("Web", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * ### Static Generation
 * `output: "static"` publishes only the prerendered pages; no server is
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
 * Set `output: "server"` when `ssr.build` produces a server handler.
 *
 * **Example:** SSR on App Service
 * ```typescript
 * const site = yield* Azure.Website.Foldkit("Web", {
 *   output: "server",
 *   env: { API_BASE: "https://api.example.com" },
 *   sku: "B1",
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
    target: FOLDKIT_NODE_TARGET_SPECIFIER,
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
