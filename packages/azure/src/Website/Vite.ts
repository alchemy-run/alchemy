import * as Namespace from "alchemy/Namespace";
import {
  makeFrameworkSite,
  staticConfigFromAssets,
  type FrameworkSiteProps,
} from "./FrameworkSite.ts";

/** The framework-integration package that drives the Vite build. */
export const VITE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vite";

/** The Node deploy target for the Vite build. */
export const VITE_NODE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/vite/node";

const viteOptions = (props: ViteProps) =>
  props.vite !== undefined && (props.vite.outDir !== undefined || props.vite.base !== undefined)
    ? { vite: props.vite }
    : undefined;

export interface ViteProps extends FrameworkSiteProps {
  /**
   * Serializable Vite config merged OVER the project's own `vite.config.*`.
   */
  vite?: {
    outDir?: string;
    base?: string;
  };
}

/**
 * Deploy a plain [Vite](https://vite.dev) application to Azure: the
 * `vite build` output is uploaded to the static website endpoint of an
 * Azure Storage account and served through Azure Front Door, with no
 * Docker image and no server. For client-only projects — React/Vue/Solid
 * SPAs, `index.html` multi-page apps — whose entire deployable output is
 * static assets.
 *
 * Each file is uploaded with a `Cache-Control` header (HTML is never
 * cached, hashed assets are immutable), and a redeploy purges the paths of
 * replaced and deleted files from Front Door. Front Door answers a
 * single-page application's deep links with the index page and a `200`
 * status.
 *
 * Front Door Standard is on by default and costs a monthly base fee per
 * profile: pass `frontDoor: { profile }` to share one profile across
 * sites, or `frontDoor: false` to serve straight from the storage
 * endpoint (deep links then answer `404` with the index page). A new Front
 * Door endpoint takes 10-20 minutes to serve everywhere.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/vite` with the
 * `@alchemy.run/frontend-frameworks/vite/node` deploy target — the package
 * must be installed in your project. During `alchemy dev` the site is
 * Vite's own dev server and no cloud resources are created.
 *
 *
 * ### Creating Vite Sites
 * **Example:** Basic Vite SPA
 * ```typescript
 * const site = yield* Azure.Website.Vite("Web");
 * ```
 *
 * **Example:** Project in a Subdirectory
 * ```typescript
 * const site = yield* Azure.Website.Vite("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Existing Storage Account
 * ```typescript
 * const storageAccount = yield* Azure.Storage.StorageAccount("Files");
 * const site = yield* Azure.Website.Vite("Web", { storageAccount });
 * ```
 *
 * ### Multi-Page Sites
 * **Example:** Per-Route HTML Pages with a 404 Page
 * ```typescript
 * const site = yield* Azure.Website.Vite("Docs", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * ### Front Door
 * **Example:** Share one Front Door profile across sites
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("Edge");
 * const web = yield* Azure.Website.Vite("Web", { frontDoor: { profile } });
 * const docs = yield* Azure.Website.Vite("Docs", {
 *   rootDir: "./docs",
 *   frontDoor: { profile },
 * });
 * ```
 *
 * **Example:** Serve from the storage endpoint without Front Door
 * ```typescript
 * const site = yield* Azure.Website.Vite("Preview", { frontDoor: false });
 * // site.url → "https://{account}.z13.web.core.windows.net"
 * ```
 *
 * ### Build Configuration
 * **Example:** Custom Output Directory and Base Path
 * ```typescript
 * const site = yield* Azure.Website.Vite("Docs", {
 *   vite: { outDir: "build", base: "/docs/" },
 * });
 * ```
 *
 * ### Local Development
 * **Example:** Vite Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` starts `vite` programmatically: site.url is the local
 * // dev server (HMR included); no Azure resources are created.
 * const site = yield* Azure.Website.Vite("Web");
 * ```
 *
 * @resource
 * @product Website
 */
export const Vite = (id: string, props: ViteProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Vite",
    framework: VITE_FRAMEWORK_SPECIFIER,
    target: VITE_NODE_TARGET_SPECIFIER,
    options: {
      ...viteOptions(props),
      notFoundHandling: "spa",
      htmlHandling: props.assets?.htmlHandling,
    },
    static: staticConfigFromAssets(props.assets, {
      notFoundHandling: "single-page-application",
    }),
  }).pipe(Namespace.push(id));
