import { Vite, type ViteProps } from "./Vite.ts";

/** Configuration for a client-rendered solid-yield website. */
export type SolidYieldProps = ViteProps & {};

/**
 * Deploy a solid-yield Vite application to Neon Functions with SPA routing.
 * The project's solid-yield and Solid Vite plugins drive the build; native Vite HMR runs
 * during development without creating cloud resources.
 *
 * ### Creating a Website
 * **Example:** solid-yield application
 * ```typescript
 * const site = yield* Neon.Website.SolidYield("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Multi-Page Routing
 * **Example:** Override the default SPA fallback
 * ```typescript
 * const site = yield* Neon.Website.SolidYield("Web", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const SolidYield = (id: string, props: SolidYieldProps = {}) =>
  Vite(id, {
    ...props,
    assets: { notFoundHandling: "single-page-application", ...props.assets },
  });
