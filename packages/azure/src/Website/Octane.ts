import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Octane build. */
export const OCTANE_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/octane";

/** The Node deploy target for the Octane build. */
export const OCTANE_NODE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/octane/node";

export interface OctaneProps extends FrameworkSiteProps {}

/**
 * Deploy an [OctaneJS](https://octanejs.dev) application to Azure
 * App Service: Octane's SSR server on a Linux web app with the Node.js runtime (no Docker),
 * static assets served by the same process.
 *
 * `Azure.Website.Octane` selects hosting and automatically wraps Octane's
 * default native Node output. Keep compiler and route settings in
 * `octane.config.ts` without an adapter. The legacy Node marker adapter
 * remains optional for existing projects.
 *
 * ### Creating Octane Sites
 * **Example:** Basic Octane App
 * ```typescript
 * const site = yield* Azure.Website.Octane("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Behind Azure Front Door
 * ```typescript
 * const site = yield* Azure.Website.Octane("Web", {
 *   rootDir: "./app",
 *   frontDoor: true,
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Octane = (id: string, props: OctaneProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Octane",
    framework: OCTANE_FRAMEWORK_SPECIFIER,
    target: OCTANE_NODE_TARGET_SPECIFIER,
  }).pipe(Namespace.push(id));
