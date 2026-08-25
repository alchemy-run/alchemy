import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Waku build. */
export const WAKU_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/waku";

/** The Node container deploy target for the Waku build. */
export const WAKU_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/waku/node";

export interface WakuProps extends FrameworkSiteProps {
  /**
   * Waku config overrides (`srcDir`, `distDir`, `basePath`, `vite`, ...)
   * merged over the project's own `waku.config.ts`. `unstable_adapter` is
   * owned by the Node deploy target and may not be set here.
   */
  waku?: Record<string, unknown>;
  /**
   * Waku source directory, relative to {@link rootDir}.
   */
  srcDir?: string;
  /**
   * Waku build output directory, relative to {@link rootDir}.
   */
  distDir?: string;
  /**
   * Base path the app is served under.
   */
  basePath?: string;
}

/**
 * Deploy a [Waku](https://waku.gg) application to Railway: the RSC server
 * plus SSG pages on one `Railway.Service`. The Node deploy target selects
 * waku's `node` adapter; do not set `unstable_adapter`. SSG pages are
 * served extensionless (`/about`).
 *
 * During `alchemy dev` the site is Waku's own dev server and no cloud
 * resources are created. `Alchemy.remote()` opts back into the live
 * Service path.
 *
 * @section Creating Waku Sites
 * @example Basic Waku App
 * ```typescript
 * const site = yield* Railway.Website.Waku("Web", {
 *   rootDir: "./app",
 *   registry: "ghcr.io/acme",
 * });
 * ```
 *
 * @section Server Configuration
 * @example Process Environment
 * ```typescript
 * const site = yield* Railway.Website.Waku("Web", {
 *   rootDir: "./app",
 *   env: {
 *     API_BASE: "https://api.example.com",
 *   },
 *   registry: "ghcr.io/acme",
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Waku = (id: string, props: WakuProps = {}) => {
  const waku = {
    ...props.waku,
    ...(props.srcDir !== undefined ? { srcDir: props.srcDir } : {}),
    ...(props.distDir !== undefined ? { distDir: props.distDir } : {}),
    ...(props.basePath !== undefined ? { basePath: props.basePath } : {}),
  };
  return makeFrameworkSite(id, props, {
    name: "Waku",
    framework: WAKU_FRAMEWORK_SPECIFIER,
    target: WAKU_NODE_TARGET_SPECIFIER,
    options: Object.keys(waku).length > 0 ? { waku } : undefined,
  }).pipe(Namespace.push(id));
};
