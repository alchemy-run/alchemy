import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Vocs build. */
export const VOCS_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/vocs";

/** The Node container deploy target for the Vocs build. */
export const VOCS_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vocs/node";

export interface VocsProps extends FrameworkSiteProps {
  /**
   * Vocs build output directory, relative to {@link rootDir}. Set this when
   * `vocs.config.*` customizes `outDir` so generated output stays outside the
   * rebuild hash.
   * @default "dist"
   */
  outDir?: string;
}

/**
 * Deploy a [Vocs](https://vocs.dev) documentation project to a Hetzner
 * Cloud Server. Vocs prerenders static HTML; unmatched paths serve
 * extensionless pages (`/about` → `about/index.html`).
 *
 * @resource
 * @product Website
 *
 * @section Creating Vocs Sites
 * @example Vocs Documentation Site
 * ```typescript
 * const docs = yield* Hetzner.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 * });
 * ```
 *
 * @example Custom Output Directory
 * ```typescript
 * const docs = yield* Hetzner.Website.Vocs("Docs", {
 *   rootDir: "./docs",
 *   outDir: "build",
 * });
 * ```
 */
export const Vocs = (id: string, props: VocsProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Vocs",
    framework: VOCS_FRAMEWORK_SPECIFIER,
    target: VOCS_NODE_TARGET_SPECIFIER,
    options: props.outDir !== undefined ? { outDir: props.outDir } : undefined,
    htmlHandling: "drop-trailing-slash",
    static: { htmlHandling: "drop-trailing-slash" },
  }).pipe(Namespace.push(id));
