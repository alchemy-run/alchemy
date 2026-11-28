import type { InputProps } from "alchemy/Input";
import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";
import { viteFrameworkOptions, type ViteProps } from "./Vite.ts";

/** The framework-integration package that drives the Effect UI build. */
export const EFFECT_UI_FRAMEWORK_SPECIFIER = "@alchemy.run/frontend-frameworks/effect-ui";

/** The AWS Lambda deploy target for the Effect UI build (`server: "function"`). */
export const EFFECT_UI_AWS_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/effect-ui/aws";

/** The Node deploy target for the Lambda Web Function server (the default). */
export const EFFECT_UI_WEB_TARGET_SPECIFIER = "@alchemy.run/frontend-frameworks/effect-ui/node";

/** Configuration for an Effect UI website on AWS. */
export type EffectUIProps = FrameworkSiteProps<
  Pick<ViteProps, "vite" | "config" | "spa" | "errorPage"> & {
    /**
     * Deployment topology, declared before building. `"server"` deploys the
     * handler `HtmlServerVite.plugin` emits with `serverOutDir`; `"static"`
     * deploys only prerendered pages. Omit for a browser-only SPA. A server
     * build requires an explicit choice.
     */
    output?: "server" | "static";
  }
>;

/**
 * Deploy an [Effect UI](https://ui.effect.website) app to AWS: assets in S3
 * behind a CloudFront distribution. Browser-only apps route on the client,
 * so `spa` defaults on. With `output: "server"`, the handler
 * `HtmlServerVite.plugin` generates runs on a Lambda Web Function (or a
 * Lambda Function with `server: "function"`); prerendered pages and assets
 * stay in S3.
 *
 * `HtmlServerVite.plugin` in your project's own `vite.config.*` owns
 * rendering and prerendering: set its `serverOutDir` for SSR, or list
 * `prerender` paths in the server entry for static pages. The build runs
 * through `@alchemy.run/frontend-frameworks/effect-ui`, which must be
 * installed in your project. Input files are content-hashed so unchanged
 * projects skip the build and deploy entirely.
 *
 * During `alchemy dev` the site is the project's own Vite dev server, which
 * `HtmlServerVite` renders pages in, and no AWS resources are created.
 * `Alchemy.remote()` opts back into the full deployment.
 *
 * ### Creating Effect UI Sites
 * **Example:** Browser-only SPA
 * ```typescript
 * const site = yield* AWS.Website.EffectUI("Web");
 * ```
 *
 * **Example:** Project in a Subdirectory
 * ```typescript
 * const site = yield* AWS.Website.EffectUI("Web", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * ### Server Rendering
 * Set `output: "server"` when `HtmlServerVite.plugin` has a `serverOutDir`.
 * Prerendered routes are served from S3; every other request reaches the
 * server.
 *
 * **Example:** vite.config.ts for a server-rendered app
 * ```typescript
 * import { plugin as htmlServer } from "@effect/ui/html/HtmlServerVite";
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   build: { outDir: "dist/client" },
 *   plugins: [
 *     htmlServer({
 *       entry: "/src/entry.server.ts",
 *       serverOutDir: "dist/server",
 *     }),
 *   ],
 * });
 * ```
 *
 * **Example:** SSR with Prerendered Routes
 * ```typescript
 * const site = yield* AWS.Website.EffectUI("Web", {
 *   output: "server",
 *   env: { API_BASE: "https://api.example.com" },
 * });
 * ```
 *
 * **Example:** SSR on a Lambda Function
 * ```typescript
 * const site = yield* AWS.Website.EffectUI("Web", {
 *   output: "server",
 *   server: "function",
 *   memorySize: 2048,
 * });
 * ```
 *
 * ### Static Generation
 * `output: "static"` deploys only the prerendered pages; no server is
 * created.
 *
 * **Example:** Prerendered Pages Without a Server
 * ```typescript
 * const site = yield* AWS.Website.EffectUI("Docs", {
 *   output: "static",
 *   errorPage: "404.html",
 * });
 * ```
 *
 * ### Deep Links
 * A deep link like `/counter/42` arrives at the edge as a request for a
 * file that does not exist. A browser-only app serves the shell instead of
 * a 404. An app that ships a real 404 page opts out with `errorPage` — the
 * two are mutually exclusive.
 *
 * **Example:** Serving a Real 404 Page
 * ```typescript
 * const site = yield* AWS.Website.EffectUI("Web", {
 *   spa: false,
 *   errorPage: "404.html",
 * });
 * ```
 *
 * ### Custom Domains
 * **Example:** Custom Domain
 * ```typescript
 * const site = yield* AWS.Website.EffectUI("Web", {
 *   domain: {
 *     name: "app.example.com",
 *     hostedZoneId: zone.hostedZoneId,
 *   },
 * });
 * ```
 *
 * **Example:** Serve Through an Existing AWS.Website.Router
 * ```typescript
 * const router = yield* AWS.Website.Router("Router", {});
 * const site = yield* AWS.Website.EffectUI("Web", {
 *   domain: { router },
 * });
 * ```
 *
 * ### Build Configuration
 * The `vite` bag holds deploy-time overrides merged over your
 * `vite.config.*`, and `config` selects an alternate config file.
 *
 * **Example:** Deploy-Time Base Path Override
 * ```typescript
 * const site = yield* AWS.Website.EffectUI("Web", {
 *   vite: { base: "/app/" },
 * });
 * ```
 *
 * @resource
 */
export const EffectUI = (id: string, props: InputProps<EffectUIProps, "server"> = {}) => {
  const p = props as EffectUIProps;
  return makeFrameworkSite(id, props, {
    name: "Effect UI",
    framework: EFFECT_UI_FRAMEWORK_SPECIFIER,
    target: EFFECT_UI_AWS_TARGET_SPECIFIER,
    webTarget: EFFECT_UI_WEB_TARGET_SPECIFIER,
    options: { ...viteFrameworkOptions(p), output: p.output ?? "spa" },
    // Browser-only and prerendered builds are assets-only. Browser-only
    // apps route on the client, so `spa` defaults on unless an
    // `errorPage` is set (the two are mutually exclusive downstream).
    static:
      p.output === "server"
        ? undefined
        : {
            spa: p.spa ?? (p.output === undefined && p.errorPage === undefined),
            errorPage: p.errorPage,
          },
  }).pipe(Namespace.push(id));
};
