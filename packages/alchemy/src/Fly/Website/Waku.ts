import { frameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

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
   * Waku source directory, relative to {@link FrameworkSiteProps.rootDir}.
   */
  srcDir?: string;
  /**
   * Waku build output directory, relative to {@link FrameworkSiteProps.rootDir}.
   */
  distDir?: string;
  /**
   * Base path the app is served under.
   */
  basePath?: string;
}

/**
 * Deploy a [Waku](https://waku.gg) application to Fly: the RSC server on a
 * Machine, static assets (SSG pages included) baked into the image.
 * Prerendered pages are served extensionless (`/about`).
 *
 *
 * ### Creating Waku Sites
 * **Example:** Basic Waku App
 * ```typescript
 * const site = yield* Fly.Website.Waku("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* Fly.Website.Waku("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
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
  return frameworkSite(id, props, {
    name: "Waku",
    framework: WAKU_FRAMEWORK_SPECIFIER,
    target: WAKU_NODE_TARGET_SPECIFIER,
    options: Object.keys(waku).length > 0 ? { waku } : undefined,
    htmlHandling: "drop-trailing-slash",
  });
};
