import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Waku build. */
export const WAKU_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/waku";

/** The Node container deploy target for the Waku build. */
export const WAKU_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/waku/node";

const wakuOptions = (props: WakuProps) => {
  const waku = {
    ...(props.srcDir !== undefined ? { srcDir: props.srcDir } : {}),
    ...(props.distDir !== undefined ? { distDir: props.distDir } : {}),
    ...(props.basePath !== undefined ? { basePath: props.basePath } : {}),
  };
  return Object.keys(waku).length > 0 ? { waku } : undefined;
};

export interface WakuProps extends FrameworkSiteProps {
  /**
   * Waku source directory, relative to {@link rootDir}. Setting this
   * overrides a `srcDir` in the project's `waku.config.*`.
   * @default the project's `waku.config.*` value, or waku's own default (`"src"`)
   */
  srcDir?: string;
  /**
   * Waku build output directory, relative to {@link rootDir}. The server
   * bundle is read from `<distDir>/server` and the client assets from
   * `<distDir>/public`. Setting this overrides a `distDir` in the
   * project's `waku.config.*` — if your config file customizes `distDir`,
   * mirror it here (or exclude it via `memo`) so the build output doesn't
   * pollute the rebuild hash.
   * @default the project's `waku.config.*` value, or waku's own default (`"dist"`)
   */
  distDir?: string;
  /**
   * Base path the app is served under. Setting this overrides a
   * `basePath` in the project's `waku.config.*`.
   * @default the project's `waku.config.*` value, or waku's own default (`"/"`)
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
 * ### Creating Waku Sites
 * **Example:** Basic Waku App
 * ```typescript
 * const site = yield* Railway.Website.Waku("Web", {
 *   rootDir: "./app",
 *   registry: "ghcr.io/acme",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Process Environment
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
export const Waku = (id: string, props: WakuProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Waku",
    framework: WAKU_FRAMEWORK_SPECIFIER,
    target: WAKU_NODE_TARGET_SPECIFIER,
    options: wakuOptions(props),
  }).pipe(Namespace.push(id));
