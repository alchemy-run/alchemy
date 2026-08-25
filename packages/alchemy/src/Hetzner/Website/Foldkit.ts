import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";
import {
  VITE_FRAMEWORK_SPECIFIER,
  VITE_NODE_TARGET_SPECIFIER,
} from "./Vite.ts";

export interface FoldkitProps extends FrameworkSiteProps {
  /**
   * Serializable Vite config merged OVER the project's own `vite.config.*`.
   */
  vite?: {
    /** Build output directory, relative to `rootDir`. */
    outDir?: string;
    /** Public base path the site deploys under (vite's `base`). */
    base?: string;
  };
}

/**
 * Deploy a [Foldkit](https://foldkit.dev) app to a Hetzner Cloud Server.
 *
 * Foldkit apps are client-only Vite projects, so this composite is the
 * Vite site with SPA fallback to `index.html` (deep links boot the app
 * and the Foldkit router takes over).
 *
 * @resource
 * @product Website
 *
 * @section Creating Foldkit Sites
 * @example Foldkit App
 * ```typescript
 * const site = yield* Hetzner.Website.Foldkit("Website");
 * ```
 *
 * @example Project in a Subdirectory
 * ```typescript
 * const site = yield* Hetzner.Website.Foldkit("Website", {
 *   rootDir: "applications/web",
 * });
 * ```
 */
export const Foldkit = (id: string, props: FoldkitProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Foldkit",
    framework: VITE_FRAMEWORK_SPECIFIER,
    target: VITE_NODE_TARGET_SPECIFIER,
    options: props.vite !== undefined ? { vite: props.vite } : undefined,
    static: { spa: true },
  }).pipe(Namespace.push(id));
