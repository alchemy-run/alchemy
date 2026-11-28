import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";
import type { ViteProps } from "./Vite.ts";

/** Configuration for an Effect UI website. */
export interface EffectUIProps extends FrameworkSiteProps {
  /** Serializable overrides merged over vite.config.*. */
  vite?: ViteProps["vite"];
}

/**
 * Deploy an [Effect UI](https://ui.effect.website) application to DigitalOcean Cloud.
 * Browser-only apps use SPA routing. With `HtmlServerVite.plugin` in
 * `vite.config.ts`, prerendered pages and assets are served first; with its
 * `serverOutDir`, every other request reaches Effect UI's generated request
 * handler.
 *
 * The build uses `@alchemy.run/frontend-frameworks/effect-ui` and the
 * project's Vite configuration. No application adapter is required.
 * Native Effect UI development (server rendering included) runs without cloud resources;
 * `Alchemy.remote()` opts into a live deployment during development.
 *
 * ### Creating a Website
 * **Example:** SPA, SSR, or prerendered Effect UI application
 * ```typescript
 * const site = yield* DigitalOcean.Website.EffectUI("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Runtime environment for server-rendered pages
 * ```typescript
 * const site = yield* DigitalOcean.Website.EffectUI("Web", {
 *   rootDir: "./app",
 *   env: { API_BASE: "https://api.example.com" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const EffectUI = (id: string, props: EffectUIProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "Effect UI",
    framework: "@alchemy.run/frontend-frameworks/effect-ui",
    target: "@alchemy.run/frontend-frameworks/effect-ui/node",
    options: {
      vite: props.vite,
      notFoundHandling:
        props.assets?.notFoundHandling === "single-page-application"
          ? "spa"
          : props.assets?.notFoundHandling,
      htmlHandling: props.assets?.htmlHandling,
    },
  }).pipe(Namespace.push(id));
