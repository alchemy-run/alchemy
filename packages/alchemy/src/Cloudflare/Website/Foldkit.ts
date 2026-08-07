import * as Effect from "effect/Effect";
import type { InputProps } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { effectClass } from "../../Util/effect.ts";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type NormalizedBindings,
  type ViteOptions,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

export interface FoldkitProps<Bindings extends WorkerBindingProps = {}>
  extends
    Omit<
      WorkerProps<Bindings>,
      "vite" | "main" | "assets" | "source" | "script" | "bundle"
    >,
    // `viteEnvironments` is deliberately dropped: Foldkit builds a `client`
    // environment (plus `ssr` only when `main` names a custom Worker entry),
    // never the multi-environment RSC split that option exists to describe.
    Omit<ViteOptions, "viteEnvironments"> {
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   *
   * Foldkit apps route on the client, so `notFoundHandling` defaults to
   * `"single-page-application"` — a request for a path with no matching
   * file serves `index.html` and the app's own router takes over. Set it
   * explicitly to override; anything you pass merges over the default.
   */
  assets?: AssetsConfig;
}

/**
 * Foldkit routes on the client, so an unmatched path is a route, not a
 * missing file — the SPA fallback is the default.
 *
 * `Input<AssetsConfig>` admits a whole-object `Output`/`Effect`/`Config`
 * as well as a plain object with per-field inputs. Spreading the former
 * would take it apart and lose the reference, so only a plain object is
 * merged into; anything else is passed through and owns the config
 * outright.
 */
const withSpaFallback = (assets: unknown): unknown => {
  const spa = { notFoundHandling: "single-page-application" as const };
  if (assets === undefined) {
    return spa;
  }
  if (
    typeof assets !== "object" ||
    assets === null ||
    Output.isOutput(assets) ||
    Effect.isEffect(assets)
  ) {
    return assets;
  }
  return { ...spa, ...assets };
};

/**
 * A Cloudflare Worker deployed from a [Foldkit](https://foldkit.dev) app.
 *
 * Foldkit is an Elm-architecture frontend framework built on Effect. Its
 * apps are client-only Vite projects — the Foldkit Vite plugin adds HMR
 * with state preservation and devtools wiring, but emits no server
 * runtime — so `Foldkit` drives the project's own `vite build` through
 * the injected Cloudflare Vite plugin and deploys the client output as
 * static assets. No Wrangler configuration, build command, or output
 * directory required.
 *
 * The app's own `vite.config.ts` still loads natively, so `foldkit()`
 * (and Tailwind, and any other plugins) compose with the injected
 * Cloudflare plugin. Input files are content-hashed (respecting
 * `.gitignore` by default) so unchanged projects skip the build and
 * deploy entirely.
 *
 * This is `Cloudflare.Website.Vite` with Foldkit's defaults applied:
 * client-side routing is assumed, so `assets.notFoundHandling` is
 * `"single-page-application"` unless you say otherwise.
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 *
 * @section Deploying a Foldkit App
 * A single call builds and deploys the app. Deep links work out of the
 * box — the SPA fallback serves `index.html` so the Foldkit router can
 * boot on any path.
 *
 * @example Foldkit app
 * ```typescript
 * const app = yield* Cloudflare.Website.Foldkit("Website");
 * ```
 *
 * @example Foldkit app in a subdirectory
 * ```typescript
 * const app = yield* Cloudflare.Website.Foldkit("Website", {
 *   rootDir: "applications/web",
 * });
 * ```
 *
 * @section Custom Domains
 * @example Serving on a custom domain
 * ```typescript
 * const app = yield* Cloudflare.Website.Foldkit("Website", {
 *   rootDir: "applications/web",
 *   workersDev: { enabled: false, previewsEnabled: false },
 *   domain: {
 *     name: "example.com",
 *     aliases: ["example.dev"],
 *   },
 * });
 * ```
 *
 * @section Custom Worker Entry
 * A Foldkit app deploys as pure assets by default — no Worker code runs
 * on a request. Point `main` at your own module when the deployment must
 * do something at the edge: serve an API route, wrap the assets in error
 * reporting, or export Durable Object classes. The module builds through
 * the Vite `ssr` environment and becomes the deployed Worker entry, with
 * the client build still served as assets through its `ASSETS` binding.
 *
 * @example src/worker.ts
 * ```typescript
 * type Env = {
 *   ASSETS: { fetch(request: Request): Promise<Response> };
 *   TICKER: KVNamespace;
 * };
 *
 * export default {
 *   async fetch(request: Request, env: Env): Promise<Response> {
 *     const url = new URL(request.url);
 *
 *     if (url.pathname === "/api/ticker") {
 *       const body = await env.TICKER.get("ticker:clubs");
 *       return new Response(body, {
 *         headers: { "content-type": "application/json" },
 *       });
 *     }
 *
 *     return env.ASSETS.fetch(request);
 *   },
 * };
 * ```
 *
 * @example alchemy.run.ts
 * ```typescript
 * const ticker = yield* Cloudflare.KV.Namespace("Ticker");
 *
 * const app = yield* Cloudflare.Website.Foldkit("Platform", {
 *   rootDir: "applications/platform",
 *   main: "src/worker.ts",
 *   env: { TICKER: ticker },
 * });
 * ```
 *
 * @section Bindings
 * Values passed via `env` are bound to the Worker, so they are reachable
 * from a custom `main` entry (and from cron handlers). They are *not*
 * visible to browser code — a Foldkit app runs on the client, so anything
 * it needs must be fetched from a route the Worker serves.
 *
 * @example Binding a KV namespace and a secret
 * ```typescript
 * const cache = yield* Cloudflare.KV.Namespace("Cache");
 *
 * const app = yield* Cloudflare.Website.Foldkit("Website", {
 *   main: "src/worker.ts",
 *   env: {
 *     CACHE: cache,
 *     API_KEY: Alchemy.secret("API_KEY"),
 *   },
 * });
 * ```
 *
 * @section Asset Routing
 * The SPA fallback is the default. Override `assets` to change it — for
 * example a Foldkit app that ships real 404 content rather than routing
 * unknown paths in the client:
 *
 * @example Serving a real 404 page
 * ```typescript
 * const app = yield* Cloudflare.Website.Foldkit("Website", {
 *   assets: {
 *     notFoundHandling: "404-page",
 *   },
 * });
 * ```
 *
 * @example Running the Worker before assets
 * ```typescript
 * const app = yield* Cloudflare.Website.Foldkit("Website", {
 *   main: "src/worker.ts",
 *   assets: {
 *     runWorkerFirst: true,
 *   },
 * });
 * ```
 *
 * @section Dev
 * `alchemy dev` runs the app's own Vite dev server, so Foldkit's HMR with
 * state preservation and its devtools wiring work unchanged. Bindings are
 * live, so a custom `main` entry sees real KV namespaces and secrets.
 *
 * @example Pinning the dev server's address
 * ```typescript
 * const app = yield* Cloudflare.Website.Foldkit("Website", {
 *   dev: { host: "127.0.0.1", port: 5180, strictPort: true },
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, every non-gitignored file under `rootDir` is hashed (plus
 * the nearest lockfile) to decide whether a rebuild is needed. Use `memo`
 * to narrow the scope when the app lives in a large repository.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const app = yield* Cloudflare.Website.Foldkit("Website", {
 *   memo: {
 *     include: ["src/**", "public/**", "index.html", "package.json", "vite.config.ts"],
 *   },
 * });
 * ```
 *
 * @example Rebuilding when a sibling workspace package changes
 * The default scope only hashes files under the project root, so edits to
 * a sibling workspace package the app imports do not retrigger the build
 * on their own. Add the sibling's sources with a `../` include glob — and
 * keep `lockfile: true`, since providing `include` otherwise drops the
 * lockfile from the hash:
 * ```typescript
 * const app = yield* Cloudflare.Website.Foldkit("Web", {
 *   rootDir: "applications/web",
 *   memo: {
 *     include: ["**\/*", "../../libraries/domain/src/**"],
 *     lockfile: true,
 *   },
 * });
 * ```
 *
 * @section Class Form
 * Calling `Foldkit` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * @example Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.Foldkit<Website>()("Website") {}
 *
 * const app = yield* Website;
 * ```
 */
export const Foldkit: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<FoldkitProps<Bindings>>
        | Effect.Effect<InputProps<FoldkitProps<Bindings>>, never, Req>,
    ): Effect.Effect<Self, never, Req | Providers> & {
      new (): Worker<{
        [binding in keyof NormalizedBindings<
          Bindings,
          WorkerAssetsConfig
        >]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
      }>;
    };
  };
  <const Bindings extends WorkerBindingProps = {}, Req = never>(
    id: string,
    propsEff?:
      | InputProps<FoldkitProps<Bindings>>
      | Effect.Effect<InputProps<FoldkitProps<Bindings>>, never, Req>,
  ): Effect.Effect<
    Worker<{
      [binding in keyof NormalizedBindings<
        Bindings,
        WorkerAssetsConfig
      >]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
    }>,
    never,
    Req | Providers
  >;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(Foldkit(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            main: undefined!,
            assets: withSpaFallback(props?.assets),
            vite: {
              main: props?.main,
              rootDir: props?.rootDir,
              memo: props?.memo,
            },
          }),
        ),
      )) as any;
