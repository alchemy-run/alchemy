import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the Nuxt build. */
export const NUXT_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/nuxt";

/** The Node deploy target for the Nuxt build. */
export const NUXT_NODE_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/nuxt/node";

export interface NuxtProps extends FrameworkSiteProps {
  /**
   * Nuxt config overrides merged over the project's own `nuxt.config.ts`
   * (highest-priority layer). `nitro.preset` is owned by the Node deploy
   * target and may not be set here.
   */
  nuxt?: Record<string, unknown>;
}

/**
 * Deploy a Nuxt application to Azure App Service: the nitro Node
 * server on a Linux web app with the Node.js runtime (no Docker), static
 * assets served by the same process.
 *
 * The build runs through `@alchemy.run/frontend-frameworks/nuxt` with the
 * `@alchemy.run/frontend-frameworks/nuxt/node` deploy target (`nitro.preset`
 * `"node"`).
 *
 *
 * ### Creating Nuxt Sites
 * **Example:** Basic Nuxt App
 * ```typescript
 * const site = yield* Azure.Website.Nuxt("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * **Example:** Behind Azure Front Door
 * ```typescript
 * const site = yield* Azure.Website.Nuxt("Web", {
 *   rootDir: "./app",
 *   frontDoor: true,
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Nuxt = (id: string, props: NuxtProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Nuxt",
    framework: NUXT_FRAMEWORK_SPECIFIER,
    target: NUXT_NODE_TARGET_SPECIFIER,
    options: props.nuxt ? { nuxt: props.nuxt } : undefined,
  }).pipe(Namespace.push(id));
