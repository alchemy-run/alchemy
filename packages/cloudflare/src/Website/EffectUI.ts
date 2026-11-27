import type { InputProps } from "alchemy/Input";
import { effectClass } from "alchemy/Util/effect";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type NormalizedBindings,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
} from "../Workers/Worker.ts";
import type { FrameworkWebsiteProps } from "./FrameworkWebsite.ts";

const EFFECT_UI_SOURCE_PROVIDER = "@alchemy.run/frontend-frameworks/effect-ui/source";

export interface EffectUIProps<
  Bindings extends WorkerBindingProps = {},
> extends FrameworkWebsiteProps<Bindings> {
  /**
   * Custom Worker entry for a browser-only app. Relative paths resolve from
   * {@link rootDir}; the Worker can serve client assets through `ASSETS`.
   * Cannot be combined with `HtmlServerVite.plugin`, which generates the
   * Worker from the app's server entry.
   */
  main?: string;
  /**
   * Overrides static asset routing defaults. Browser-only apps, including
   * any app with a custom {@link main}, use
   * `notFoundHandling: "single-page-application"` in dev and on deploy, so
   * a page load of a deep link gets the app shell. When Effect UI renders
   * pages (`HtmlServerVite.plugin` with `serverOutDir`), matching assets are
   * served and unmatched requests reach its handler. Explicit options take
   * precedence over these defaults.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from an [Effect UI](https://ui.effect.website)
 * app.
 *
 * Builds the project's Vite configuration and deploys its client assets
 * and the server handler `HtmlServerVite.plugin` generates. Configure
 * rendering in the app's `vite.config.ts`; Alchemy derives asset routing
 * from it.
 *
 * Requires `@alchemy.run/frontend-frameworks` in the project.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * ### Deploying an Effect UI App
 * The same declaration supports browser-only, server-rendered, and
 * prerendered apps.
 *
 * **Example:** Effect UI app
 * ```typescript
 * const site = yield* Cloudflare.Website.EffectUI("Website");
 * ```
 *
 * **Example:** Effect UI project in a subdirectory
 * ```typescript
 * const site = yield* Cloudflare.Website.EffectUI("Website", {
 *   rootDir: "apps/web",
 * });
 * ```
 *
 * ### Server Rendering
 * Add `HtmlServerVite.plugin` with a `serverOutDir` to render pages in the
 * Worker. The server entry exports the app's `HttpRouter` Layer as its
 * default export, and `prerender` lists the pages built ahead of time,
 * which are served as assets. Server code reads the bindings in `env`
 * from `cloudflare:workers`, imported when a request arrives: the build
 * imports the server entry in Node to prerender, where that module doesn't
 * exist.
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
 * **Example:** src/entry.server.ts
 * ```typescript
 * /// <reference types="@effect/ui/html/HtmlServerViteDocument" />
 * import { layerHttp } from "@effect/ui/html/HtmlServerHttp";
 * import { document } from "virtual:@effect/ui/document";
 * import { App } from "./App.ts";
 * import { AppRoute } from "./routes.ts";
 *
 * export default layerHttp(App, { routes: AppRoute, document });
 *
 * export const prerender = ["/about", "/404"];
 * ```
 *
 * ### Static Generation
 * Without `serverOutDir`, the build keeps only the prerendered pages and
 * the site deploys as assets, with no Worker code.
 *
 * **Example:** Prerendered pages without a server
 * ```typescript
 * import { plugin as htmlServer } from "@effect/ui/html/HtmlServerVite";
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   plugins: [htmlServer({ entry: "/src/entry.server.ts" })],
 * });
 * ```
 *
 * ### Asset Routing
 * Use `assets` to override the rendering mode's defaults (see
 * {@link EffectUIProps.assets}).
 *
 * **Example:** Browser-only app with a custom 404 page
 * ```typescript
 * const site = yield* Cloudflare.Website.EffectUI("Website", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * ### Custom Worker Entry
 * For a browser-only app with API routes or other Worker handlers, set
 * `main` and route those requests through the Worker. Bindings in `env`
 * are available to the Worker, not to browser code.
 *
 * **Example:** Custom Worker with a KV binding
 * ```typescript
 * const notes = yield* Cloudflare.KV.Namespace("Notes");
 *
 * const site = yield* Cloudflare.Website.EffectUI("Website", {
 *   main: "src/worker.ts",
 *   env: { NOTES: notes },
 *   assets: { runWorkerFirst: ["/api/*"] },
 * });
 * ```
 *
 * ### Custom Rebuild Scope
 * Narrow the files hashed for rebuilds while retaining the Vite config
 * and lockfile as build inputs.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.EffectUI("Website", {
 *   memo: {
 *     include: [
 *       "src/**",
 *       "public/**",
 *       "index.html",
 *       "vite.config.ts",
 *       "package.json",
 *     ],
 *     lockfile: true,
 *   },
 * });
 * ```
 *
 * ### Class Form
 * Use the class form when other resources need to reference the Worker.
 *
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.EffectUI<Website>()("Website") {}
 *
 * const site = yield* Website;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 */
export const EffectUI: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<EffectUIProps<Bindings>>
        | Effect.Effect<InputProps<EffectUIProps<Bindings>>, never, Req>,
    ): Effect.Effect<Self, never, Req | Providers> & {
      new (): Worker<{
        [binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>]: NormalizedBindings<
          Bindings,
          WorkerAssetsConfig
        >[binding];
      }>;
    };
  };
  <const Bindings extends WorkerBindingProps = {}, Req = never>(
    id: string,
    propsEff?:
      | InputProps<EffectUIProps<Bindings>>
      | Effect.Effect<InputProps<EffectUIProps<Bindings>>, never, Req>,
  ): Effect.Effect<
    Worker<{
      [binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>]: NormalizedBindings<
        Bindings,
        WorkerAssetsConfig
      >[binding];
    }>,
    never,
    Req | Providers
  >;
} = (<const Bindings extends WorkerBindingProps = {}, Req = never>(
  id?: string,
  propsEff?:
    | InputProps<EffectUIProps<Bindings>>
    | Effect.Effect<InputProps<EffectUIProps<Bindings>>, never, Req>,
) =>
  id === undefined
    ? <const Bindings extends WorkerBindingProps = {}, Req = never>(
        id: string,
        propsEff?:
          | InputProps<EffectUIProps<Bindings>>
          | Effect.Effect<InputProps<EffectUIProps<Bindings>>, never, Req>,
      ) => effectClass(EffectUI(id, propsEff))
    : Worker(
        id,
        Effect.map(Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff), (props) => ({
          ...props,
          main: null,
          source: {
            provider: EFFECT_UI_SOURCE_PROVIDER,
            devMode: "server",
            rootDir: props?.rootDir,
            options: { main: props?.main, memo: props?.memo },
          },
        })),
      )) as any;
