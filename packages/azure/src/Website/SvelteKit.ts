import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the SvelteKit build. */
export const SVELTEKIT_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/sveltekit";

/** The Node deploy target for the SvelteKit build. */
export const SVELTEKIT_NODE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/sveltekit/node";

export interface SvelteKitProps extends FrameworkSiteProps {
  /**
   * SvelteKit configuration passed to the `sveltekit(config)` Vite plugin.
   * The `adapter` field is injected by the Node deploy target and may not
   * be set here. Must be JSON-serializable (it persists in state).
   */
  kit?: Record<string, unknown>;
}

/**
 * Deploy a SvelteKit application to Azure App Service: kit's SSR
 * server on a Linux web app with the Node.js runtime (no Docker), static assets (prerendered
 * pages included) served by the same process.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/sveltekit` with
 * the `@alchemy.run/frontend-frameworks/sveltekit/node` deploy target.
 *
 *
 * ### Creating SvelteKit Sites
 * **Example:** Basic SvelteKit App
 * ```typescript
 * const site = yield* Azure.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Behind Azure Front Door
 * ```typescript
 * const site = yield* Azure.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 *   frontDoor: true,
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const SvelteKit = (id: string, props: SvelteKitProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "SvelteKit",
    framework: SVELTEKIT_FRAMEWORK_SPECIFIER,
    target: SVELTEKIT_NODE_TARGET_SPECIFIER,
    options: props.kit ? { kit: props.kit } : undefined,
  }).pipe(Namespace.push(id));
