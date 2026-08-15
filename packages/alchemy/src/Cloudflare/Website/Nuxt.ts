import type { ConfigError } from "effect/Config";
import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
import type { Named, Tag } from "../../Named.ts";
import type { MakeShape, PlatformServices } from "../../Platform.ts";
import type { Rpc } from "../../Rpc.ts";
import { effectClass } from "../../Util/effect.ts";
import type { Container } from "../Containers/Container.ts";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  DEFAULT_SERVER_ROUTES,
  Worker,
  type NormalizedBindings,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
  type WorkerServices,
  type WorkerTypeId,
} from "../Workers/Worker.ts";
import { validateImplAnchor, type WebsiteShape } from "./Effectful.ts";

/**
 * The specifier of the Nuxt source-provider module. The package must be
 * installed in the user's project — `loadSource` fails with a
 * `SourceProviderError` naming it otherwise.
 */
const NUXT_SOURCE_PROVIDER = "@alchemy.run/frontend-frameworks/nuxt/source";

export interface NuxtProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * Nuxt project root (the directory containing `nuxt.config.ts`).
   * Relative paths resolve from the process working directory.
   * @default process.cwd()
   */
  rootDir?: string;
  /**
   * Overrides the module that becomes the deployed Worker entry (nitro's
   * entry/exports seam). Relative paths resolve from {@link rootDir}.
   *
   * By default nitro's own `cloudflare_module` entry is deployed. Point
   * `main` at a custom module when the deployed Worker must export more
   * than the framework's fetch handler — e.g. Durable Object classes. The
   * custom entry wraps nitro's handler by importing it from
   * `nitropack/presets/cloudflare/runtime/cloudflare-module` and
   * re-exports the extras:
   *
   * ```typescript
   * // worker-entry.ts
   * import nitroHandler from "nitropack/presets/cloudflare/runtime/cloudflare-module";
   * export class Counter extends DurableObject {}
   * export default nitroHandler;
   * ```
   */
  main?: string;
  /**
   * Controls which files are content-hashed to decide whether a rebuild is
   * needed. By default every non-gitignored file under `rootDir` (plus the
   * nearest package-manager lockfile) is hashed; narrow the scope with
   * `include`/`exclude` globs when the project sits in a large repository.
   */
  memo?: MemoOptions;
  /**
   * Nuxt configuration overrides merged over the project's own
   * `nuxt.config.ts` (the override wins). The project's config file is
   * loaded natively — modules, layers, and all — so this is for
   * deploy-specific tweaks (`routeRules`, `runtimeConfig`, ...). Must be
   * JSON-serializable (it persists in state). Do not set `nitro.preset`
   * here — the Cloudflare deploy target owns the preset and a foreign
   * preset is a hard error.
   */
  nuxt?: Record<string, unknown>;
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a [Nuxt](https://nuxt.com) project.
 *
 * `Nuxt` builds the app programmatically through the project's own
 * `@nuxt/kit` with nitro's `cloudflare_module` preset — the project's
 * `nuxt.config.ts` loads natively, no `nitro.preset` edits, no Wrangler
 * configuration, and no build command required. The nitro server bundle
 * deploys as the Worker script; client assets and prerendered pages
 * (`.output/public`) deploy as Worker static assets.
 *
 * Requires the `@alchemy.run/frontend-frameworks` package to be installed in
 * your project; the integration is loaded from its `/nuxt` export. Input files
 * are content-hashed
 * (respecting `.gitignore` by default) so unchanged projects skip the
 * build and deploy entirely.
 *
 * The server build uses nitro's hybrid workerd Node compatibility
 * (`cloudflare.nodeCompat`), which relies on workerd's native `node:*`
 * modules — the `nodejs_compat` compatibility flag is always included in
 * the Worker's compatibility flags to match.
 *
 * On local dev: `alchemy dev` runs Nuxt's own dev server (nitro dev, SSR
 * in a Node worker thread, full HMR) with the Worker's bindings served on
 * `event.context.cloudflare` through cloudflare-runtime's platform proxy —
 * wrangler-free. Literal `env` values overlay the proxied bindings;
 * resource bindings (KV, R2, D1, ...) round-trip to the proxy's local
 * workerd instance, so dev state is live and shared. Durable Objects
 * declared via a custom `main` entry only exist in the production build
 * and are not servable in dev yet.
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 *
 * @section Deploying a Nuxt App
 * A single call builds and deploys the app — server-rendered pages, API
 * routes, prerendered pages, and client assets included.
 *
 * @example Basic Nuxt site
 * ```typescript
 * const site = yield* Cloudflare.Website.Nuxt("Website");
 * ```
 *
 * @example Nuxt project in a subdirectory
 * ```typescript
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   rootDir: "apps/web",
 * });
 * ```
 *
 * @section Bindings
 * Values passed via `env` are exposed to server routes and SSR through
 * nitro's `cloudflare_module` runtime contract:
 * `event.context.cloudflare.env` (plus `event.context.cf` and
 * `event.context.cloudflare.context.waitUntil`).
 *
 * @example Reading env from an API route
 * ```typescript
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   env: {
 *     API_KEY: Config.redacted("API_KEY"),
 *   },
 * });
 *
 * // server/api/hello.ts
 * // export default defineEventHandler((event) => ({
 * //   hasKey: event.context.cloudflare?.env?.API_KEY !== undefined,
 * // }));
 * ```
 *
 * @example Binding an R2 bucket
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("Uploads");
 *
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   env: {
 *     UPLOADS: bucket,
 *   },
 * });
 * ```
 *
 * @section Prerendering
 * Routes marked for prerendering in `routeRules` (or via
 * `nitro.prerender`) render at build time into `.output/public` and are
 * served as static assets — no Worker invocation.
 *
 * @example Prerendering a route
 * ```typescript
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   nuxt: {
 *     routeRules: {
 *       "/about": { prerender: true },
 *     },
 *   },
 * });
 * ```
 *
 * @section Custom Worker Exports (Durable Objects)
 * Nitro's entry module is the Worker's exports seam. Point `main` at your
 * own module that re-exports nitro's runtime handler (imported from
 * `nitropack/presets/cloudflare/runtime/cloudflare-module`) and adds
 * extra exports — Durable Object classes must live on the deployed
 * Worker for their namespace bindings to resolve. Every framework route
 * keeps working through the re-exported handler.
 *
 * @example Custom entry hosting a Durable Object
 * ```typescript
 * // worker-entry.ts
 * // import nitroHandler from "nitropack/presets/cloudflare/runtime/cloudflare-module";
 * // export class Counter extends DurableObject { ... }
 * // export default nitroHandler;
 *
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   main: "worker-entry.ts",
 *   env: {
 *     COUNTER: Cloudflare.DurableObject("Counter", {
 *       className: "Counter",
 *     }),
 *   },
 * });
 * ```
 *
 * @section Dev
 * `alchemy dev` runs Nuxt's own dev server (nitro dev, full HMR) with
 * `event.context.cloudflare` served wrangler-free through
 * cloudflare-runtime's platform proxy: resource bindings resolve against
 * a local workerd instance, and literal `env` values overlay them.
 *
 * @example Reading bindings in dev and production alike
 * ```typescript
 * // server/api/greeting.ts — identical code in dev and deployed
 * // export default defineEventHandler((event) => ({
 * //   greeting: event.context.cloudflare?.env?.GREETING,
 * // }));
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   env: { GREETING: "hello" },
 * });
 * ```
 *
 * @section Effectful Website (Effect program)
 * Pass an Effect program as the third argument to serve an effect-native
 * API from the same Worker as the Nuxt app — one deploy, one origin. The
 * program lives in a dedicated module whose default export is the Website
 * class, anchored by `main: import.meta.url` (exactly like
 * `Cloudflare.Worker`). At plan time the program's capability bindings
 * (KV, R2, D1, ...) are collected onto the Worker; at deploy time alchemy
 * generates a nitro entry wrapper that routes by `server.routes` (default
 * `["/api/*"]`): inside the routes the effect fetch is authoritative —
 * an `HttpRouter` miss renders as its own 404, never delegation — and
 * nitro's own runtime serves everything outside them without invoking
 * the effect. Hand a path back to nitro with an exclusion glob
 * (`routes: ["/api/*", "!/api/foo"]` — exclusions win). Durable Object
 * classes and event handlers (cron, queues) declared by the program
 * deploy on the same Worker.
 *
 * The impl's non-`fetch` methods are **RPC methods** — a typed API
 * surface for TRUSTED callers only: server routes and `useAsyncData`
 * server branches dispatch them directly in-process through the value
 * form of `createClient` from `alchemy/Client`, and sibling Workers
 * call them over Cloudflare JS-RPC service bindings. There is no public
 * HTTP wire — browser code talks to the backend through a schema you
 * own (effect `HttpApi` / `@effect/rpc`) mounted on the `fetch`
 * handler, which also serves any hand-rolled routes.
 *
 * Under `alchemy dev`, the effect fetch is auto-mounted as a nitro
 * middleware inside Nuxt's own dev server, with bindings served by the
 * local simulators; non-fetch handlers (cron, queues, Durable Objects)
 * are production-only on Nuxt for now.
 *
 * @example Effectful Nuxt site
 * ```typescript
 * // src/backend.ts — narrow subpath imports keep the IaC engine out of the
 * // framework/dev server graph; never import the `alchemy/Cloudflare`
 * // provider barrel from a site module.
 * import * as KV from "alchemy/Cloudflare/KV";
 * import * as Website from "alchemy/Cloudflare/Website";
 * import * as Effect from "effect/Effect";
 *
 * export const Users = KV.Namespace("Users");
 *
 * export default class Site extends Website.Nuxt<Site>()(
 *   "Site",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const users = yield* KV.ReadWriteNamespace(yield* Users);
 *     return {
 *       get: () => users.get("current"),
 *       save: (value: string) => users.put("current", value),
 *     };
 *   }).pipe(Effect.provide(KV.ReadWriteNamespaceBinding)),
 * ) {}
 * ```
 *
 * @example Calling it from a server route (createClient)
 * ```typescript
 * // a nitro server route — VALUE import, direct in-process dispatch
 * import { createClient } from "alchemy/Client";
 * import Backend from "../src/backend.ts";
 *
 * export default defineEventHandler(async (event) => {
 *   const backend = createClient(Backend, {
 *     headers: event.headers,
 *   });
 *   await backend.save("hello"); // direct effect invocation, no HTTP
 *   return { value: await backend.get() }; // typed end-to-end
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether a
 * rebuild is needed. Use `memo` to narrow the scope when the project
 * lives in a large repository.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Nuxt("Website", {
 *   memo: {
 *     include: ["app/**", "server/**", "public/**", "nuxt.config.ts", "package.json"],
 *   },
 * });
 * ```
 *
 * @section Limitations
 * Nitro's `isr` route rule (incremental static regeneration) is
 * implemented only by the Vercel and Netlify presets — on Cloudflare it
 * is silently ignored at build time, and the route renders on demand in
 * the Worker like any other SSR route. Use `prerender` for build-time
 * static routes, or `cache` route rules for runtime caching.
 *
 * @section Class Form
 * Calling `Nuxt` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * @example Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.Nuxt<Website>()(
 *   "Website",
 * ) {}
 *
 * const site = yield* Website;
 * ```
 */
export const Nuxt: {
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
        | InputProps<NuxtProps<Bindings> & { main: string }>
        | Effect.Effect<
            InputProps<NuxtProps<Bindings> & { main: string }>,
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
        | InputProps<NuxtProps<Bindings>>
        | Effect.Effect<InputProps<NuxtProps<Bindings>>, never, Req>,
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
    props: InputProps<NuxtProps<Bindings> & { main: string }>,
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
      | InputProps<NuxtProps<Bindings>>
      | Effect.Effect<InputProps<NuxtProps<Bindings>>, never, Req>,
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
          ? effectClass(Nuxt(id, propsEff))
          : Nuxt(id, propsEff, impl)
    : (Worker as any)(
        id,
        Effect.gen(function* () {
          const props: any =
            (Effect.isEffect(propsEff) ? yield* propsEff : propsEff) ?? {};
          // With an impl, `main` anchors the Effect program's module
          // (`main: import.meta.url`) — it is NOT the nitro custom-entry
          // seam, which the generated entry wrapper owns (auto-inject
          // tier). Without one, `main` keeps today's meaning: a
          // hand-written nitro entry forwarded to the source provider.
          const anchor =
            impl === undefined
              ? undefined
              : yield* validateImplAnchor(id, "Nuxt", props.main);
          return {
            ...props,
            // The server build uses nitro's hybrid workerd node-compat
            // (`cloudflare.nodeCompat: true`), which relies on workerd's
            // native `node:*` modules — `getCompatibility` already adds
            // `nodejs_compat` to every non-python Worker.
            // `main` is the source provider's user-entry seam (nitro's
            // entry), not the Worker's own bundling entry.
            main: anchor!,
            ...(anchor !== undefined
              ? { runtimeDelivery: "wrapper" as const }
              : undefined),
            source: {
              provider: NUXT_SOURCE_PROVIDER,
              devMode: "server",
              options: {
                rootDir: props?.rootDir,
                main: impl === undefined ? props?.main : undefined,
                memo: props?.memo,
                nuxt: props?.nuxt,
                // Effect entry takeover (impl present): the site-module
                // anchor + effect routes ride the source descriptor so the
                // provider can generate the nitro entry wrapper (deploy)
                // and the routes-scoped dev middleware (local dev, where
                // the provider only sees the resolved config surface).
                ...(anchor !== undefined
                  ? {
                      effect: {
                        main: anchor,
                        routes: props?.server?.routes ?? DEFAULT_SERVER_ROUTES,
                        // `takeover: false` opts out of automatic dev
                        // delivery — the source's dev half stands down
                        // for the explicit `alchemy/Nitro` mount tier.
                        ...(props?.server?.takeover !== undefined
                          ? { takeover: props.server.takeover }
                          : undefined),
                      },
                    }
                  : undefined),
              },
            },
          };
        }),
        impl,
      )) as any;
