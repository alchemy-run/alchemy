import { frameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Vocs build. */
export const VOCS_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vocs";

/** The Node container deploy target for the Vocs build. */
export const VOCS_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vocs/node";

export interface VocsProps extends FrameworkSiteProps {
  /**
   * Vocs build output directory, relative to {@link FrameworkSiteProps.rootDir}.
   * Set this when `vocs.config.*` customizes `outDir`.
   * @default "dist"
   */
  outDir?: string;
}

/**
 * Deploy a [Vocs](https://vocs.dev) documentation site to Fly. Vocs docs
 * are prerendered static HTML; the node target drops server modules and
 * the Service serves extensionless pages (`/about` → `about/index.html`).
 *
 *
 * ### Creating Vocs Sites
 * **Example:** Vocs documentation site
 * ```typescript
 * const docs = yield* Fly.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 * });
 * ```
 *
 * **Example:** Custom output directory
 * ```typescript
 * const docs = yield* Fly.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 *   outDir: "build",
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Vocs = (id: string, props: VocsProps = {}) =>
  frameworkSite(id, props, {
    name: "Vocs",
    framework: VOCS_FRAMEWORK_SPECIFIER,
    target: VOCS_NODE_TARGET_SPECIFIER,
    options: props.outDir !== undefined ? { outDir: props.outDir } : undefined,
    static: {},
    htmlHandling: "drop-trailing-slash",
  });
