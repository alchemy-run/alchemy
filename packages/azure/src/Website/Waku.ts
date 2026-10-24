import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Waku build. */
export const WAKU_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/waku";

/** The Node deploy target for the Waku build. */
export const WAKU_NODE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/waku/node";

const wakuOptions = (props: WakuProps) =>
  props.waku !== undefined ? { waku: props.waku } : undefined;

export interface WakuProps extends FrameworkSiteProps {
  /**
   * Serializable Waku config merged OVER the project's own
   * `waku.config.*`.
   */
  waku?: {
    srcDir?: string;
    distDir?: string;
    basePath?: string;
  };
}

/**
 * Deploy a [Waku](https://waku.gg) application to Azure App Service:
 * the RSC server on a Linux web app with the Node.js runtime (no Docker), static assets (SSG
 * pages included) served by the same process. Prerendered pages are served
 * extensionless (`/about` not `/about/`).
 *
 *
 * ### Creating Waku Sites
 * **Example:** Basic Waku App
 * ```typescript
 * const site = yield* Azure.Website.Waku("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Behind Azure Front Door
 * ```typescript
 * const site = yield* Azure.Website.Waku("Web", {
 *   rootDir: "./app",
 *   frontDoor: true,
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
