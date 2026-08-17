import type { ConfigError } from "effect/Config";
import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
import type { Named, Tag } from "../../Named.ts";
import type { MakeShape, PlatformServices } from "../../Platform.ts";
import type { Rpc } from "../../Rpc.ts";
import { effectClass } from "../../Util/effect.ts";
import { workerServeBridge } from "../Workers/ServeBridge.ts";
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

export interface SvelteKitProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "source" | "script" | "bundle"
> {
  /**
   * SvelteKit project root (the directory containing `package.json` and
   * `src/routes`). Relative paths resolve from the process working
   * directory.
   * @default process.cwd()
   */
  rootDir?: string;
  /**
   * Controls which files are content-hashed to decide whether a rebuild is
   * needed. By default every non-gitignored file under `rootDir` (plus the
   * nearest package-manager lockfile) is hashed; narrow the scope with
   * `include`/`exclude` globs when the project sits in a large repository.
   */
  memo?: MemoOptions;
  /**
   * SvelteKit configuration overrides. A project-owned `vite.config.*`
   * loads natively — its `sveltekit(...)` call is the primary config
   * source — and these options are merged OVER it (the override wins).
   * Without a config file, this is the whole kit config. Construction-time
   * options (`preprocess`, `extensions`, `compilerOptions`, `vitePlugin`)
   * only apply in the no-config-file case — put them in your own
   * `sveltekit(...)` call otherwise. The `adapter` field is injected by
   * Alchemy's wrangler-free Cloudflare adapter — do not set it here. Must
   * be JSON-serializable (it persists in state).
   */
  kit?: Record<string, unknown>;
  /**
   * Options for the wrangler-free Cloudflare adapter.
   */
  adapter?: {
    /**
     * Name of the static-assets binding the generated worker serves files
     * through.
     * @default "ASSETS"
     */
    assetsBinding?: string;
    /**
     * Fallback-page generation, mirroring Workers static assets
     * `not_found_handling`: `"404-page"` writes a `404.html`,
     * `"single-page-application"` writes an app-shell `index.html`.
     * @default "none"
     */
    notFoundHandling?: "none" | "404-page" | "single-page-application";
    /**
     * With `notFoundHandling: "404-page"`: `"spa"` renders the app shell
     * as the fallback, `"plaintext"` writes a plain `Not Found` page.
     * @default "plaintext"
     */
    fallback?: "spa" | "plaintext";
  };
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a SvelteKit project.
 *
 * `SvelteKit` builds the app with SvelteKit's own Vite pipeline and a
 * wrangler-free in-memory Cloudflare adapter, then re-bundles the
 * Node-flavored server output for workerd. A project-owned
 * `vite.config.*` loads natively (its `sveltekit(...)` options apply) —
 * no `svelte.config.js` (kit v3 dropped it), no
 * `@sveltejs/adapter-cloudflare`, no Wrangler configuration required.
 * Client assets and prerendered pages are deployed as Worker static
 * assets; dynamic routes are served by the generated Worker.
 *
 * The `@alchemy.run/frontend-frameworks` package must be installed in your
 * project — its `/sveltekit` export is loaded dynamically at deploy time.
 *
 * Input files are content-hashed (respecting `.gitignore` by default) so
 * unchanged projects skip the build and deploy entirely.
 *
 * SvelteKit's server code runs under `nodejs_compat` (the server graph is
 * built for Node), so the flag is always included in the Worker's
 * compatibility flags.
 *
 * Note on local dev: `alchemy dev` runs SvelteKit's own Vite dev server
 * (Node SSR with full HMR). `platform.env` carries the Worker's real
 * Cloudflare bindings (KV, R2, D1, ...) served by the cloudflare-runtime
 * platform proxy, with literal `env` values (strings and secrets)
 * overlaid.
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 *
 * @section Deploying a SvelteKit App
 * A single call builds and deploys the app — server-rendered routes,
 * prerendered pages, and client assets included.
 *
 * @example Basic SvelteKit site
 * ```typescript
 * const site = yield* Cloudflare.Website.SvelteKit("Website");
 * ```
 *
 * @section Bindings
 * Values passed via `env` are exposed to server routes through
 * SvelteKit's `platform.env`.
 *
 * @example Reading env from a server route
 * ```typescript
 * const site = yield* Cloudflare.Website.SvelteKit("Website", {
 *   env: {
 *     API_KEY: Config.redacted("API_KEY"),
 *   },
 * });
 *
 * // src/routes/+page.server.ts
 * // export const load = ({ platform }) => ({
 * //   hasKey: platform?.env?.API_KEY !== undefined,
 * // });
 * ```
 *
 * @section Kit and Adapter Options
 * Kit options normally live in the `sveltekit(...)` call in your
 * `vite.config.ts`, which loads natively; `kit` is a deploy-time
 * override layer merged over them (the override wins). The generated
 * Cloudflare adapter is configured via `adapter`.
 *
 * @example SPA-style 404 fallback
 * ```typescript
 * const site = yield* Cloudflare.Website.SvelteKit("Website", {
 *   adapter: {
 *     notFoundHandling: "404-page",
 *     fallback: "spa",
 *   },
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
 * const site = yield* Cloudflare.Website.SvelteKit("Website", {
 *   memo: {
 *     include: ["src/**", "static/**", "package.json"],
 *   },
 * });
 * ```
 *
 * @section Effectful Website
 * Pass an Effect program as the third argument and ONE Worker serves the
 * SvelteKit app **and** your effect-native handlers. The program's
 * capability bindings (KV, R2, D1, ...) are collected at plan time
 * exactly like an effect Worker's; the generated Worker entry routes by
 * `server.routes` (default `["/api/*"]`): inside the routes the effect
 * fetch is authoritative — an `HttpRouter` miss renders as its own 404,
 * never delegation — and kit's own `respond` serves everything outside
 * them without invoking the effect. Keep a kit `+server` endpoint
 * working with an exclusion glob (`routes: ["/api/*", "!/api/foo"]` —
 * exclusions win). Under `alchemy dev`, the same dispatch mounts as a
 * middleware in front of kit's Vite dev server. An explicit
 * `alchemy/SvelteKit` mount in `hooks.server.ts` remains available
 * as an escape hatch.
 *
 * The program's non-`fetch` surface — Durable Object classes and event
 * handlers (a queue consumer registered with
 * `Queues.consumeQueueMessages`, `scheduled`, ...) — ships on the same
 * Worker in the production build via the generated worker entry; under
 * `alchemy dev` the kit dev server delivers `fetch` only, so queue
 * batches are not dispatched locally — the consumer engages on deploy.
 *
 * The impl's non-`fetch` methods are **RPC methods** — a typed API
 * surface for TRUSTED callers only: `+page.server.ts` `load` functions
 * dispatch them directly in-process through the value form of
 * `createClient` from `alchemy/Client`, and sibling Workers call them
 * over Cloudflare JS-RPC service bindings. There is no public HTTP wire
 * — browser code talks to the backend through a schema you own (effect
 * `HttpApi` / `@effect/rpc`) mounted on the `fetch` handler, which also
 * serves any hand-rolled routes.
 *
 * The program must live in a dedicated module whose default export is
 * the class, anchored by `main: import.meta.url` (exactly like
 * `Cloudflare.Worker`). Use **narrow subpath imports** in that module
 * (`alchemy/Cloudflare/KV`, `alchemy/Cloudflare/Website`, ...) — the
 * site module is re-imported inside the kit server graph, and the
 * `alchemy/Cloudflare` provider barrel would drag the entire IaC engine
 * along with it.
 *
 * @example Effectful SvelteKit site (src/backend.ts)
 * ```typescript
 * import * as KV from "alchemy/Cloudflare/KV";
 * import * as Website from "alchemy/Cloudflare/Website";
 * import * as Effect from "effect/Effect";
 *
 * export const Users = KV.Namespace("Users");
 *
 * export default class Site extends Website.SvelteKit<Site>()(
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
 * @example Calling it from a `+page.server.ts` load (createClient)
 * ```typescript
 * // +page.server.ts — VALUE import, direct in-process dispatch
 * import { createClient } from "alchemy/Client";
 * import Backend from "../src/backend.ts";
 *
 * export const load = async ({ request }) => {
 *   const backend = createClient(Backend, { headers: request.headers });
 *   await backend.save("hello"); // direct effect invocation, no HTTP
 *   return { value: await backend.get() }; // typed end-to-end
 * };
 * ```
 *
 * @section Class Form
 * Calling `SvelteKit` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * @example Declaring a Worker class
 * ```typescript
 * class Website extends Cloudflare.Website.SvelteKit<Website>()(
 *   "Website",
 * ) {}
 *
 * const site = yield* Website;
 * ```
 */
export const SvelteKit: {
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
        | InputProps<SvelteKitProps<Bindings> & { main: string }>
        | Effect.Effect<
            InputProps<SvelteKitProps<Bindings> & { main: string }>,
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
        | InputProps<SvelteKitProps<Bindings>>
        | Effect.Effect<InputProps<SvelteKitProps<Bindings>>, never, Req>,
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
    props: InputProps<SvelteKitProps<Bindings> & { main: string }>,
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
      | InputProps<SvelteKitProps<Bindings>>
      | Effect.Effect<InputProps<SvelteKitProps<Bindings>>, never, Req>,
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
          ? workerServeBridge.attach(effectClass(SvelteKit(id, propsEff)))
          : workerServeBridge.attach(SvelteKit(id, propsEff, impl))
    : (Worker as any)(
        id,
        Effect.gen(function* () {
          const props: any =
            (Effect.isEffect(propsEff) ? yield* propsEff : propsEff) ?? {};
          // With an impl, `main` anchors the Effect program's module
          // (`main: import.meta.url`) and the generated worker shim's
          // effect arm delivers the runtime half — auto-inject tier.
          const anchor =
            impl === undefined
              ? undefined
              : yield* validateImplAnchor(id, "SvelteKit", props.main);
          return {
            ...props,
            main: anchor!,
            ...(anchor !== undefined
              ? { runtimeDelivery: "wrapper" as const }
              : undefined),
            // SvelteKit's server graph is built for Node and needs
            // `nodejs_compat` — `getCompatibility` already adds it to every
            // non-python Worker.
            // The adapter's `notFoundHandling` generates the fallback pages
            // and the worker shim's 404 deferral, but the Workers assets
            // layer has its own `not_found_handling` knob — if they
            // disagree, unknown routes come back as empty-body 404s (the
            // shim defers to an assets layer still on "none"). Default the
            // assets-layer knob from the adapter so one prop configures the
            // whole story; an explicit `assets.notFoundHandling` wins.
            assets:
              props?.adapter?.notFoundHandling !== undefined &&
              props.adapter.notFoundHandling !== "none" &&
              props.assets?.notFoundHandling === undefined
                ? {
                    ...props.assets,
                    notFoundHandling: props.adapter.notFoundHandling,
                  }
                : props?.assets,
            source: {
              provider: "@alchemy.run/frontend-frameworks/sveltekit/source",
              devMode: "server",
              options: {
                rootDir: props?.rootDir,
                memo: props?.memo,
                kit: props?.kit,
                adapter: props?.adapter,
                // Wrapper-delivery carrier for DEV: the source's `dev()`
                // runs in the vite-child process, whose DevContext
                // hardcodes an external entry — the descriptor is the only
                // channel that reaches it. The build path reads the richer
                // `SourceContext.entry` (which adds DO/Workflow exports)
                // instead.
                ...(anchor !== undefined
                  ? {
                      effect: {
                        main: anchor,
                        routes: props?.server?.routes ?? [
                          ...DEFAULT_SERVER_ROUTES,
                        ],
                      },
                    }
                  : undefined),
              },
            },
          };
        }),
        impl,
      )) as any;
