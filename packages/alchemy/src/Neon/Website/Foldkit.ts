import { Vite, type ViteProps } from "./Vite.ts";

/** Configuration for a client-only Foldkit website. */
export type FoldkitProps = ViteProps & {};

/**
 * Deploy a Foldkit Vite application to Neon Functions with SPA routing.
 * This integration serves the client build; it does not run Foldkit SSR.
 * The project's Foldkit Vite plugin drives the build and provides live
 * reload during development without creating cloud resources.
 *
 * ### Creating a Website
 * **Example:** Foldkit application
 * ```typescript
 * const site = yield* Neon.Website.Foldkit("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Multi-Page Routing
 * **Example:** Override the default SPA fallback
 * ```typescript
 * const site = yield* Neon.Website.Foldkit("Web", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Foldkit = (id: string, props: FoldkitProps = {}) =>
  Vite(id, {
    ...props,
    assets: { notFoundHandling: "single-page-application", ...props.assets },
  });
