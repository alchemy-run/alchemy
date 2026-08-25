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
 * Deploy a [Waku](https://waku.gg) application to a Hetzner Cloud Server:
 * the RSC server as a systemd unit on port 3000, static assets (SSG
 * pages included) baked into the unit. Prerendered pages are served
 * extensionless (`/about` not `/about/`).
 *
 *
 * ### Creating Waku Sites
 * **Example:** Basic Waku App
 * ```typescript
 * const site = yield* Hetzner.Website.Waku("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Hetzner.Website.Waku("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 *   zone,
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
    htmlHandling: "drop-trailing-slash",
  }).pipe(Namespace.push(id));
