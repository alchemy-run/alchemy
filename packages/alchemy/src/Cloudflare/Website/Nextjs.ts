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
  Self,
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
 * The module specifier of the Next.js source provider. Loaded with a
 * dynamic `import()`, so `@alchemy.run/frontend-frameworks` must be installed
 * in the deploying project. The provider is exposed through its `/nextjs`
 * subpath.
 */
const NEXTJS_SOURCE_PROVIDER = "@alchemy.run/frontend-frameworks/nextjs/source";

/**
 * The default compatibility date when none is provided. Matches the
 * `@alchemy.run/frontend-frameworks/nextjs` integration's own default so deploy and local
 * dev agree.
 */
const DEFAULT_COMPATIBILITY_DATE = "2026-05-12";

/** Next.js/OpenNext-specific build knobs, forwarded to the source provider. */
export interface NextjsBuildOptions {
  /**
   * Path of the OpenNext config, relative to the project root.
   * @default "open-next.config.ts"
   */
  configPath?: string;
  /**
   * The command the OpenNext pipeline runs to build the Next.js app.
   * A `buildCommand` set in the project's `open-next.config.ts` takes
   * precedence over this option.
   * @default "npx next build"
   */
  buildCommand?: string;
  /**
   * Skip the internal `next build` and reuse an existing `.next` directory.
   * @default false
   */
  skipNextBuild?: boolean;
  /**
   * Minify the OpenNext bundling steps and the final worker bundle pass.
   * @default false
   */
  minify?: boolean;
  /**
   * Enable OpenNext debug logging (and verbose workerd output in dev).
   * @default false
   */
  debug?: boolean;
  /**
   * Local dev (`alchemy dev`) behavior.
   *
   * - `"preview"` (default): build the OpenNext worker and serve it under
   *   workerd — production parity (workerd APIs, ISR/cache semantics),
   *   no HMR.
   * - `"hmr"`: run the real `next dev` (Turbopack HMR) in Node with the
   *   Worker's bindings proxied onto OpenNext's `getCloudflareContext()`
   *   contract. App code runs in Node, not workerd — CF-specific runtime
   *   behavior still needs `"preview"`.
   * @default "preview"
   */
  devMode?: "preview" | "hmr";
}

export interface NextjsProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "script" | "bundle" | "source" | "rules"
> {
  /**
   * The Next.js project root (the directory containing `next.config.*` and
   * `open-next.config.ts`). Defaults to the process working directory.
   */
  rootDir?: string;
  /**
   * Controls which files are content-hashed to decide whether the OpenNext
   * build needs to re-run. By default every project file outside build
   * outputs (`.next`, `.open-next`, `dist`) and `node_modules` is hashed,
   * plus the nearest package-manager lockfile. Narrow the scope with
   * `include`/`exclude` globs when the default is too broad.
   */
  memo?: MemoOptions;
  /** Next.js/OpenNext-specific build and dev configuration. */
  nextjs?: NextjsBuildOptions;
  /**
   * Optional configuration for static asset routing behavior.
   * Defaults to `runWorkerFirst: true` with `htmlHandling`/`notFoundHandling`
   * set to `"none"` — the OpenNext server owns routing and delegates to the
   * `ASSETS` binding itself.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a Next.js project.
 *
 * `Nextjs` builds the app with the wrangler-free OpenNext pipeline from
 * [`@alchemy.run/frontend-frameworks/nextjs`](https://github.com/alchemy-run/alchemy/tree/main/packages/frontend-frameworks/src/nextjs):
 * `next build` runs through `@opennextjs/cloudflare`, the resulting worker
 * is bundled into a self-contained ES module set, and the static assets
 * (including prerendered pages and the read-only incremental cache) deploy
 * as Workers static assets. Input files are content-hashed so unchanged
 * projects skip the build and deploy entirely.
 *
 * Both `@alchemy.run/frontend-frameworks` and its peer
 * `@opennextjs/cloudflare` must be installed in the deploying project. The
 * source provider is loaded from the package's `/nextjs` export with a dynamic
 * `import()`.
 *
 * Local dev (`alchemy dev`) defaults to preview parity — the built worker
 * served under workerd. Set `nextjs: { devMode: "hmr" }` for the real
 * `next dev` (Turbopack HMR) with the Worker's bindings proxied onto
 * `getCloudflareContext()`.
 *
 * ISR comes in two flavors, chosen by the project's `open-next.config.ts`:
 * the zero-infra static-assets incremental cache (prerendered pages serve
 * as built; revalidation writes are a no-op), or the fully writable
 * KV-backed setup (`revalidatePath`/`revalidateTag` and time-based
 * regeneration all work) — see the Writable ISR section below. OpenNext's
 * `WORKER_SELF_REFERENCE` self service binding is always wired on deploy.
 *
 * Known limitations (upstream `@opennextjs/cloudflare`):
 * - Edge-runtime routes/pages (`export const runtime = "edge"`) are not
 *   supported — the build fails with the offending route list; remove the
 *   directive (the node runtime runs on Workers). Middleware is fine.
 * - `next/image` optimization requires a zone with Cloudflare Images;
 *   on `workers.dev`, use `unoptimized` (images serve as raw assets).
 * - Partial Prerendering / `"use cache"` (`cacheComponents`) and
 *   Pages-Router `i18n` config are untested/out of scope for now. App
 *   Router i18n via middleware works (middleware is fully supported).
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 *
 * @section Deploying a Next.js App
 * A single call builds the app with OpenNext and deploys the worker plus
 * its static assets. The project needs an `open-next.config.ts` — the
 * read-only static-assets incremental cache is a good default:
 *
 * ```typescript
 * // open-next.config.ts
 * import { defineCloudflareConfig } from "@opennextjs/cloudflare";
 * import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";
 *
 * export default defineCloudflareConfig({
 *   incrementalCache: staticAssetsIncrementalCache,
 * });
 * ```
 *
 * @example Basic Next.js site
 * ```typescript
 * const site = yield* Cloudflare.Website.Nextjs("Site");
 * ```
 *
 * @example Explicit project root
 * ```typescript
 * const site = yield* Cloudflare.Website.Nextjs("Site", {
 *   rootDir: "./apps/web",
 * });
 * ```
 *
 * @section Bindings
 * Resources passed via `env` become Worker bindings, readable in route
 * handlers and server components through OpenNext's
 * `getCloudflareContext()`.
 *
 * @example Binding an R2 bucket
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("Uploads");
 * const site = yield* Cloudflare.Website.Nextjs("Site", {
 *   env: {
 *     UPLOADS: bucket,
 *   },
 * });
 * ```
 *
 * ```typescript
 * // app/api/upload/route.ts
 * import { getCloudflareContext } from "@opennextjs/cloudflare";
 *
 * export async function PUT(request: Request) {
 *   const { env } = getCloudflareContext();
 *   await env.UPLOADS.put("key", await request.text());
 *   return Response.json({ ok: true });
 * }
 * ```
 *
 * @section Writable ISR
 * With the KV incremental cache, ISR revalidation actually writes:
 * `revalidatePath` / `revalidateTag` purge entries, and time-based
 * `revalidate` windows regenerate pages in the background through the
 * same-worker Durable Object queue. Configure OpenNext for it and bind
 * the pieces — `WORKER_SELF_REFERENCE` is wired automatically:
 *
 * ```typescript
 * // open-next.config.ts
 * import { defineCloudflareConfig } from "@opennextjs/cloudflare";
 * import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";
 * import doQueue from "@opennextjs/cloudflare/overrides/queue/do-queue";
 * import kvNextTagCache from "@opennextjs/cloudflare/overrides/tag-cache/kv-next-tag-cache";
 *
 * export default defineCloudflareConfig({
 *   incrementalCache: kvIncrementalCache,
 *   queue: doQueue,
 *   tagCache: kvNextTagCache,
 * });
 * ```
 *
 * @example Binding the writable-ISR resources
 * ```typescript
 * const incCache = yield* Cloudflare.KV.Namespace("NextIncCache");
 * const tagCache = yield* Cloudflare.KV.Namespace("NextTagCache");
 *
 * const site = yield* Cloudflare.Website.Nextjs("Site", {
 *   env: {
 *     NEXT_INC_CACHE_KV: incCache,
 *     NEXT_TAG_CACHE_KV: tagCache,
 *     // The revalidation queue: a Durable Object class shipped in the
 *     // OpenNext worker bundle itself.
 *     NEXT_CACHE_DO_QUEUE: Cloudflare.DurableObject("NEXT_CACHE_DO_QUEUE", {
 *       className: "DOQueueHandler",
 *     }),
 *   },
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, every project file outside build outputs is hashed to decide
 * whether a rebuild is needed. Use `memo` to narrow the scope when the
 * project has large directories that don't affect the build output.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Nextjs("Site", {
 *   memo: {
 *     include: ["app/**", "public/**", "package.json", "next.config.mjs", "open-next.config.ts"],
 *   },
 * });
 * ```
 *
 * @section Build Configuration
 * The `nextjs` prop tunes the OpenNext pipeline: a custom build command,
 * minification, or reusing an existing `.next` build.
 *
 * @example Minified build with a custom command
 * ```typescript
 * const site = yield* Cloudflare.Website.Nextjs("Site", {
 *   nextjs: {
 *     buildCommand: "npx next build --no-lint",
 *     minify: true,
 *   },
 * });
 * ```
 *
 * @section Effectful Website
 * Pass an Effect program as the third argument and ONE Worker serves the
 * Next.js app **and** your effect-native handlers. The program's capability
 * bindings are collected at plan time exactly like an effect Worker's; at
 * build time alchemy performs an OpenNext artifact takeover — the site
 * module is prebundled next to `.open-next/worker.js` and a generated
 * wrapper entry routes by `server.routes` (default `/api/*`): inside the
 * routes the effect fetch is authoritative — an `HttpRouter` miss renders
 * as its own 404, never delegation — and the OpenNext handler serves
 * everything outside them without invoking the effect. Hand a path back
 * to Next with an exclusion glob (`routes: ["/api/*", "!/api/foo"]` —
 * exclusions win). Durable Object exports and queue/scheduled/cron
 * handlers ride the same wrapper (non-fetch surface).
 *
 * The impl's non-`fetch` methods are **RPC methods** — a typed API
 * surface for TRUSTED callers only: server components dispatch them
 * directly in-process through the value form of `createClient` from
 * `alchemy/Client`, and sibling Workers call them over Cloudflare
 * JS-RPC service bindings. There is no public HTTP wire — client
 * components talk to the backend through a schema you own (effect
 * `HttpApi` / `@effect/rpc`) mounted on the `fetch` handler, which also
 * serves any hand-rolled routes.
 *
 * The program must live in a dedicated module whose default export is the
 * class, anchored by `main: import.meta.url`. Local dev: `preview` mode
 * serves the takeover artifact with full parity; `hmr` mode (the real
 * `next dev`) serves effect routes through the dev server's front
 * dispatch — the same strict-ownership gate as the deployed wrapper,
 * zero user files (fetch only: DO/queue surfaces and site-module edits
 * still need `preview`, which rebuilds the artifact).
 * `server: { takeover: false }` forces the explicit
 * `toHandler` tier everywhere (mounting it explicitly also makes the
 * takeover stand down on deploy).
 *
 * @example Effectful Next.js site (src/backend.ts)
 * ```typescript
 * // Narrow subpath imports keep the IaC engine out of the framework
 * // bundle graph; never import the `alchemy/Cloudflare` provider barrel
 * // from a site module.
 * import * as KV from "alchemy/Cloudflare/KV";
 * import * as Website from "alchemy/Cloudflare/Website";
 * import * as Effect from "effect/Effect";
 *
 * export const Users = KV.Namespace("Users");
 *
 * export default class Site extends Website.Nextjs<Site>()(
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
 * @example Calling it from a server component (createClient)
 * ```typescript
 * // a server component — VALUE import, direct in-process dispatch
 * import { createClient } from "alchemy/Client";
 * import Backend from "../src/backend.ts";
 *
 * const backend = createClient(Backend);
 *
 * await backend.save("hello"); // direct effect invocation, no HTTP
 * const value = await backend.get(); // typed end-to-end
 * ```
 *
 * @section Class Form
 * Calling `Nextjs` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * @example Declaring a Worker class
 * ```typescript
 * class Site extends Cloudflare.Website.Nextjs<Site>()("Site", {
 *   rootDir: "./apps/web",
 * }) {}
 *
 * const site = yield* Site;
 * ```
 */
export const Nextjs: {
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
        | InputProps<NextjsProps<Bindings> & { main: string }>
        | Effect.Effect<
            InputProps<NextjsProps<Bindings> & { main: string }>,
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
        | InputProps<NextjsProps<Bindings>>
        | Effect.Effect<InputProps<NextjsProps<Bindings>>, never, Req>,
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
    props: InputProps<NextjsProps<Bindings> & { main: string }>,
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
      | InputProps<NextjsProps<Bindings>>
      | Effect.Effect<InputProps<NextjsProps<Bindings>>, never, Req>,
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
          ? workerServeBridge.attach(effectClass(Nextjs(id, propsEff)))
          : Nextjs(id, propsEff, impl)
    : (Worker as any)(
        id,
        Effect.gen(function* () {
          const props: any =
            (Effect.isEffect(propsEff) ? yield* propsEff : propsEff) ?? {};
          // With an impl, `main` anchors the Effect program's module
          // (`main: import.meta.url`) and the OpenNext artifact-takeover
          // wrapper delivers the runtime half — auto-inject tier
          // (`server: { takeover: false }` forces the explicit route-handler
          // mount instead).
          const anchor =
            impl === undefined
              ? undefined
              : yield* validateImplAnchor(id, "Nextjs", props.main);
          return {
            ...props,
            main: anchor!,
            ...(anchor !== undefined
              ? { runtimeDelivery: "wrapper" as const }
              : undefined),
            // OpenNext's revalidation queues (memory-queue, do-queue) fetch
            // the worker back through `WORKER_SELF_REFERENCE`. Always wire
            // the self service binding — it's inert when unused, and its
            // absence turns ISR revalidation into a silent no-op. An
            // explicit user-provided `env.WORKER_SELF_REFERENCE` wins.
            env: {
              WORKER_SELF_REFERENCE: Self,
              ...props?.env,
            },
            // OpenNext requires nodejs_compat; the Worker here is external
            // (no inline Effect entry), so the engine won't add it.
            compatibility: {
              date: props?.compatibility?.date ?? DEFAULT_COMPATIBILITY_DATE,
              flags: Array.from(
                new Set([
                  "nodejs_compat",
                  ...(props?.compatibility?.flags ?? []),
                ]),
              ),
            },
            // The OpenNext server owns routing: run the worker first and
            // leave asset-path rewriting off. Users can still override.
            assets: {
              runWorkerFirst: true,
              htmlHandling: "none",
              notFoundHandling: "none",
              ...props?.assets,
            },
            source: {
              provider: NEXTJS_SOURCE_PROVIDER,
              devMode: "server",
              options: {
                root: props?.rootDir,
                memo: props?.memo,
                ...(props?.nextjs !== undefined
                  ? (({ devMode, ...build }: any) => ({
                      ...build,
                      ...(devMode !== undefined
                        ? { dev: { mode: devMode } }
                        : {}),
                    }))(props.nextjs)
                  : {}),
              },
            },
          };
        }),
        impl,
      )) as any;
