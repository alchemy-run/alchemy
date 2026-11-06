import * as Namespace from "alchemy/Namespace";
import {
  makeFrameworkSite,
  staticConfigFromAssets,
  type FrameworkSiteProps,
} from "./FrameworkSite.ts";

/** The framework-integration package that drives the Vite build. */
export const VITE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vite";

/** The Node container deploy target for the Vite build. */
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
 * Deploy a plain [Vite](https://vite.dev) application to an Archil sandbox:
 * `vite build` output served by a static-file program on port 3000. For
 * client-only projects — React/Vue/Solid SPAs,
 * `index.html` multi-page apps — whose entire deployable output is
 * static assets.
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
 * const site = yield* Archil.Website.Vite("Web");
 * ```
 *
 * **Example:** Project in a Subdirectory
 * ```typescript
 * const site = yield* Archil.Website.Vite("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** An Existing Sandbox
 * ```typescript
 * const box = yield* Archil.Sandbox("Box", { vcpuCount: 2 });
 * const site = yield* Archil.Website.Vite("Web", { sandbox: box });
 * ```
 *
 * ### Multi-Page Sites
 * **Example:** Per-Route HTML Pages with a 404 Page
 * ```typescript
 * const site = yield* Archil.Website.Vite("Docs", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * ### Build Configuration
 * **Example:** Custom Output Directory and Base Path
 * ```typescript
 * const site = yield* Archil.Website.Vite("Docs", {
 *   outDir: "build",
 *   base: "/docs/",
 * });
 * ```
 *
 * ### Local Development
 * **Example:** Vite Dev Server Under `alchemy dev`
 * ```typescript
 * // `alchemy dev` starts `vite` programmatically: site.url is the local
 * // dev server (HMR included); no sandbox is created.
 * const site = yield* Archil.Website.Vite("Web");
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
