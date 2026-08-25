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
}

/**
 * Deploy a [Waku](https://waku.gg) application to a Hetzner Cloud Server:
 * the RSC server as a systemd unit on port 3000, static assets (SSG
 * pages included) baked into the unit. Prerendered pages are served
 * extensionless (`/about` not `/about/`).
 *
 * @resource
 * @product Website
 *
 * @section Creating Waku Sites
 * @example Basic Waku App
 * ```typescript
 * const site = yield* Hetzner.Website.Waku("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * @example Custom Domain
 * ```typescript
 * const site = yield* Hetzner.Website.Waku("Web", {
 *   rootDir: "./app",
 *   domain: "app.example.com",
 *   zone,
 * });
 * ```
 */
export const Waku = (id: string, props: WakuProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Waku",
    framework: WAKU_FRAMEWORK_SPECIFIER,
    target: WAKU_NODE_TARGET_SPECIFIER,
    options: props.waku ? { waku: props.waku } : undefined,
  }).pipe(Namespace.push(id));
