import type { ConfigError } from "effect/Config";
import * as Effect from "effect/Effect";
import type { InputProps } from "../../Input.ts";
import type { Named, Tag } from "../../Named.ts";
import type { MakeShape, PlatformServices } from "../../Platform.ts";
import type { Rpc } from "../../Rpc.ts";
import { effectClass } from "../../Util/effect.ts";
import type { Container } from "../Containers/Container.ts";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type NormalizedBindings,
  type ViteOptions,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
  type WorkerServices,
  type WorkerTypeId,
} from "../Workers/Worker.ts";
import { validateImplAnchor, type WebsiteShape } from "./Effectful.ts";

export interface ViteProps<Bindings extends WorkerBindingProps = {}>
  extends Omit<WorkerProps<Bindings>, "vite" | "main" | "assets">, ViteOptions {
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a Vite project.
 *
 * `Vite` uses the Cloudflare Vite plugin to build both the server bundle
 * and client assets in a single `vite build` invocation — no manual
 * `main` entrypoint, build command, output directory, or Wrangler
 * configuration required.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 *
 * @section Deploying a Static Site
 * For a pure static site (no SSR), a single call is all you need.
 * Vite builds the project and Alchemy deploys the output as a
 * Cloudflare Worker with static assets.
 *
 * @example Static Vite site
 * ```typescript
 * const site = yield* Cloudflare.Website.Vite("Website");
 * ```
 *
 * @section SSR Frameworks
 * SSR frameworks like TanStack Start or SolidStart work with a single
 * call — the `nodejs_compat` compatibility flag is enabled by default
 * so the server bundle can use Node.js APIs.
 *
 * @example TanStack Start
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("TanStackStart");
 * ```
 *
 * @example SolidStart with worker-first routing
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("SolidStart", {
 *   assets: { runWorkerFirst: true },
 * });
 * ```
 *
 * @example React Router
 * React Router's server build (`virtual:react-router/server-build`) is a
 * build manifest with no default export, so it cannot be deployed as the
 * Worker entry directly. Point `main` at a module that wraps it with
 * `createRequestHandler` (React Router's Cloudflare template ships this
 * as `workers/app.ts`):
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("ReactRouter", {
 *   main: "workers/app.ts",
 * });
 * ```
 *
 * @section React Server Components
 * Frameworks that emit more than one server environment (e.g. React
 * Server Components, which split into an `rsc` environment and an `ssr`
 * environment) need `viteEnvironments` to declare which environment
 * produces the deployed Worker entry and which additional server
 * environments to bundle alongside it. The `client` environment is
 * always deployed as static assets.
 *
 * @example React Router with RSC
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("ReactRouterRSC", {
 *   viteEnvironments: {
 *     entry: "rsc",
 *     children: ["ssr"],
 *   },
 * });
 * ```
 *
 * @section Custom Worker Entry
 * By default the deployed Worker entry is the server bundle the
 * framework produces. When the Worker must export more than the
 * framework's fetch handler — Durable Object classes, additional
 * handlers — point `main` at your own module that wraps the framework
 * handler and re-exports the extras. `main` takes precedence over any
 * entry configured in the Vite config.
 *
 * @example Custom entry hosting Durable Objects
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("App", {
 *   main: "worker/index.ts",
 *   viteEnvironments: {
 *     entry: "rsc",
 *     children: ["ssr"],
 *   },
 * });
 * ```
 *
 * @section Single-Page Applications
 * For SPAs (React, Vue, etc.), configure asset handling so all
 * routes fall back to `index.html`.
 *
 * @example Vue SPA
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("Vue", {
 *   assets: {
 *     htmlHandling: "auto-trailing-slash",
 *     notFoundHandling: "single-page-application",
 *   },
 * });
 * ```
 *
 * @example Foldkit
 * [Foldkit](https://foldkit.dev) apps are client-only Vite projects, so a
 * single call deploys them — the Foldkit Vite plugin in the app's own
 * `vite.config.ts` composes with the injected Cloudflare plugin. Enable
 * `single-page-application` not-found handling so deep links boot the app:
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("Foldkit", {
 *   assets: {
 *     notFoundHandling: "single-page-application",
 *   },
 * });
 * ```
 *
 * @example Octane SPA
 * A client-only [OctaneJS](https://octanejs.dev) app (no `octane.config.ts`
 * routes) is a plain Vite SPA — the `octane()` compiler plugin in the app's
 * own `vite.config.ts` composes with the injected Cloudflare plugin:
 * ```typescript
 * const app = yield* Cloudflare.Website.Vite("Octane", {
 *   assets: {
 *     notFoundHandling: "single-page-application",
 *   },
 * });
 * ```
 * Fullstack Octane apps (routes + SSR in `octane.config.ts`) run their own
 * two-pass build through Octane's Cloudflare adapter — deploy those with
 * `Cloudflare.Website.Octane` instead.
 *
 * @section Serving on a Zone Route with a Path Prefix
 * Cloudflare matches static assets against the full request pathname,
 * so a site attached to a route like `example.com/docs*` only serves
 * assets whose uploaded paths carry the `/docs` prefix. Set Vite's
 * `base` in your `vite.config.ts` — the emitted HTML references its
 * assets under the prefix, and Alchemy keys the uploaded asset manifest
 * with the same resolved `base` so the two always agree.
 *
 * @example vite.config.ts
 * ```typescript
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   base: "/docs/",
 * });
 * ```
 *
 * @example alchemy.run.ts
 * ```typescript
 * const docs = yield* Cloudflare.Website.Vite("Docs", {
 *   routes: [{ pattern: "example.com/docs*", zoneName: "example.com" }],
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether
 * a rebuild is needed. Use `memo` to narrow the scope when your
 * project has large directories that don't affect the build output.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Vite("Docs", {
 *   memo: {
 *     include: ["src/**", "content/**", "package.json"],
 *   },
 * });
 * ```
 *
 * @example Rebuilding when a sibling workspace package changes
 * The default scope only hashes files under the project root (plus the
 * nearest lockfile), so edits to a sibling workspace package the app
 * imports do not retrigger the build on their own. Add the sibling's
 * sources with a `../` include glob — and keep `lockfile: true`, since
 * providing `include` otherwise drops the lockfile from the hash:
 * ```typescript
 * const site = yield* Cloudflare.Website.Vite("Web", {
 *   rootDir: "apps/web",
 *   memo: {
 *     include: ["**\/*", "../../packages/env/src/**"],
 *     lockfile: true,
 *   },
 * });
 * ```
 *
 * @section Effectful Website
 * Pass an Effect program as the third argument and ONE Worker serves the
 * Vite app **and** your effect-native handlers. The program's capability
 * bindings (KV, R2, D1, ...) are collected at plan time exactly like an
 * effect Worker's; at build time alchemy generates a wrapper entry that
 * routes by `server.routes` (default `["/api/*"]`): inside the routes
 * the effect fetch is authoritative — an `HttpRouter` miss renders as
 * its own 404, never delegation — and outside them the asset layer /
 * framework handler serves without ever invoking the effect. Hand a
 * path back to the framework with an exclusion glob
 * (`routes: ["/api/*", "!/api/foo"]` — exclusions win). Durable
 * Object classes and queue/scheduled/cron handlers declared by the
 * program ride the same wrapper. With SPA not-found handling, the routes
 * are auto-compiled into `assets.runWorkerFirst` so a static shell can
 * never shadow the API.
 *
 * The program must live in a dedicated module whose default export is
 * the class, anchored by `main: import.meta.url` (exactly like
 * `Cloudflare.Worker`). Use **narrow subpath imports** in that module
 * (`alchemy/Cloudflare/KV`, `alchemy/Cloudflare/Website`, ...) — in dev
 * the vite module runner evaluates the site module's whole import graph
 * inside workerd, and the `alchemy/Cloudflare` provider barrel would
 * drag the entire IaC engine along with it.
 *
 * @example Effectful Vite site (src/site.ts)
 * ```typescript
 * import * as KV from "alchemy/Cloudflare/KV";
 * import * as Website from "alchemy/Cloudflare/Website";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export const Users = KV.Namespace("Users");
 *
 * export default class Site extends Website.Vite<Site>()(
 *   "Site",
 *   {
 *     main: import.meta.url,
 *     assets: { notFoundHandling: "single-page-application" },
 *     server: { routes: ["/api/*"] },
 *   },
 *   Effect.gen(function* () {
 *     const users = yield* KV.ReadWriteNamespace(yield* Users);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const url = new URL(request.url, "http://localhost");
 *         if (url.pathname === "/api/user") {
 *           const value = yield* users.get("current").pipe(Effect.orDie);
 *           return yield* HttpServerResponse.json({ value });
 *         }
 *         // the effect owns /api/* — unknown paths get its own 404
 *         return yield* HttpServerResponse.json(
 *           { error: "not found" },
 *           { status: 404 },
 *         );
 *       }),
 *     };
 *   }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
 * ) {}
 * ```
 *
 * @section Class Form
 * Calling `Vite` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both
 * an `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * @example Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.Vite<Website>()("Website") {}
 *
 * const site = yield* Website;
 * ```
 */
export const Vite: {
  <Self>(): {
    <
      const Id extends string,
      Shape extends WebsiteShape,
      const Bindings extends WorkerBindingProps = {},
      Req extends
        | WorkerServices
        | Container.Application<any>
        | PlatformServices
        | Tag = never,
      PropsReq = never,
    >(
      id: Id,
      props:
        | InputProps<ViteProps<Bindings> & { main: string }>
        | Effect.Effect<
            InputProps<ViteProps<Bindings> & { main: string }>,
            ConfigError,
            PropsReq
          >,
      impl: Effect.Effect<Shape, ConfigError, Req>,
    ): Effect.Effect<
      Worker<{
        [binding in keyof NormalizedBindings<
          Bindings,
          WorkerAssetsConfig
        >]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
      }> &
        Rpc<Self>,
      never,
      Extract<Req, Container.Application<any>> | Providers | PropsReq
    > &
      Named<Id> & {
        new (): MakeShape<Shape, WebsiteShape> & Named<Id> & Tag<WorkerTypeId>;
      };
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<ViteProps<Bindings>>
        | Effect.Effect<InputProps<ViteProps<Bindings>>, never, Req>,
    ): Effect.Effect<Self, never, Req | Providers> & {
      new (): Worker<{
        [binding in keyof NormalizedBindings<
          Bindings,
          WorkerAssetsConfig
        >]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
      }>;
    };
  };
  <
    const Id extends string,
    Shape extends WebsiteShape,
    const Bindings extends WorkerBindingProps = {},
    Req extends WorkerServices | Container.Application<any> | PlatformServices =
      never,
  >(
    id: Id,
    props: InputProps<ViteProps<Bindings> & { main: string }>,
    impl: Effect.Effect<Shape, ConfigError, Req>,
  ): Effect.Effect<
    Worker<{
      [binding in keyof NormalizedBindings<
        Bindings,
        WorkerAssetsConfig
      >]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
    }> &
      Rpc<Shape>,
    never,
    Extract<Req, Container.Application<any>> | Providers
  > &
    Named<Id>;
  <const Bindings extends WorkerBindingProps = {}, Req = never>(
    id: string,
    propsEff?:
      | InputProps<ViteProps<Bindings>>
      | Effect.Effect<InputProps<ViteProps<Bindings>>, never, Req>,
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
} = ((id?: any, propsEff?: any, impl?: any) =>
  id === undefined
    ? (id: string, propsEff: any, impl?: any) =>
        impl === undefined
          ? effectClass(Vite(id, propsEff))
          : Vite(id, propsEff, impl)
    : impl === undefined
      ? Worker(
          id,
          Effect.map(
            Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
            (props) => ({
              ...props,
              main: undefined!,
              vite: {
                main: props?.main,
                rootDir: props?.rootDir,
                memo: props?.memo,
                viteEnvironments: props?.viteEnvironments,
              },
            }),
          ),
        )
      : (Worker as any)(
          id,
          Effect.gen(function* () {
            const props: any =
              (Effect.isEffect(propsEff) ? yield* propsEff : propsEff) ?? {};
            const main = yield* validateImplAnchor(id, "Vite", props.main);
            return {
              ...props,
              // With an impl, `main` anchors the Effect program's module
              // (`main: import.meta.url`); the deployed entry is the
              // generated wrapper, so the vite custom-entry seam is not
              // forwarded.
              main,
              // The vite pipeline is alchemy-owned — auto-inject tier.
              // `server: { takeover: false }` downgrades to "external" in
              // the engine's collect-only stamp.
              runtimeDelivery: "wrapper",
              vite: {
                rootDir: props.rootDir,
                memo: props.memo,
                viteEnvironments: props.viteEnvironments,
              },
            };
          }),
          impl,
        )) as any;
