import { DEFAULT_COMPATIBILITY_DATE } from "@alchemy.run/cloudflare-runtime/core/internal/constants";
import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
import { effectClass } from "../../Util/effect.ts";
import type { Providers } from "../Providers.ts";
import type { Namespace } from "../KV/Namespace.ts";
import { DurableObject } from "../Workers/DurableObject.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Self,
  Worker,
  type NormalizedBindings,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

/**
 * The module specifier of the Next.js source provider. Loaded with a
 * dynamic `import()`, so `@alchemy.run/frontend-frameworks` must be installed
 * in the deploying project. The provider is exposed through its `/nextjs`
 * subpath.
 */
const NEXTJS_SOURCE_PROVIDER = "@alchemy.run/frontend-frameworks/nextjs/source";

export interface NextjsProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "script" | "bundle" | "source" | "rules" | "dev"
> {
  /**
   * The Next.js project root. Defaults to the process working directory.
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
  /**
   * Writable incremental static regeneration. Alchemy selects the KV cache
   * adapters and binds the same-worker Durable Object revalidation queue.
   * When omitted, prerendered pages use the read-only static-assets cache.
   * KV fills on demand; build-time cache entries are not uploaded to KV.
   */
  isr?: {
    /** KV namespace storing rendered pages and fetch results. */
    incrementalCache: Namespace;
    /** KV namespace storing cache-tag invalidations. */
    tagCache: Namespace;
  };
  /** OpenNext build options. No application-owned OpenNext config is required. */
  openNext?: {
    /** Command used to build the Next.js app. Defaults to `npx next build`. */
    buildCommand?: string;
    /** Minify the generated Worker. Defaults to false. */
    minify?: boolean;
    /** Enable OpenNext build diagnostics. Defaults to false. */
    debug?: boolean;
  };
  /**
   * Local dev (`alchemy dev`) behavior.
   */
  dev?: {
    /**
     * - `"preview"` (default): build the OpenNext worker and serve it
     *   under workerd — production parity (workerd APIs, ISR/cache
     *   semantics), no HMR.
     * - `"hmr"`: run the real `next dev` (Turbopack HMR) in Node with the
     *   Worker's bindings proxied onto OpenNext's `getCloudflareContext()`
     *   contract. App code runs in Node, not workerd — CF-specific
     *   runtime behavior still needs `"preview"`.
     * @default "preview"
     */
    mode?: "preview" | "hmr";
    /**
     * Port for the local dev server. `0` picks an ephemeral port.
     */
    port?: number;
  };
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
 * served under workerd. Set `dev: { mode: "hmr" }` for the real `next dev`
 * (Turbopack HMR) with the Worker's bindings proxied onto
 * `getCloudflareContext()`.
 *
 * Alchemy generates the OpenNext configuration. The default static-assets
 * cache serves prerendered pages as built; revalidation writes are a no-op.
 * Configure `isr` for writable KV caching and background regeneration.
 * The self service binding and revalidation queue are wired automatically.
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
 *
 * ### Deploying a Next.js App
 * A single call builds the app and deploys the Worker plus static assets.
 * No `open-next.config.ts`, Wrangler config, or Alchemy plugin is required.
 *
 * **Example:** Basic Next.js site
 * ```typescript
 * const site = yield* Cloudflare.Website.Nextjs("Site");
 * ```
 *
 * **Example:** Explicit project root
 * ```typescript
 * const site = yield* Cloudflare.Website.Nextjs("Site", {
 *   rootDir: "./apps/web",
 * });
 * ```
 *
 * ### Bindings
 * Resources passed via `env` become Worker bindings, readable in route
 * handlers and server components through OpenNext's
 * `getCloudflareContext()`.
 *
 * **Example:** Binding an R2 bucket
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
 * ### Writable ISR
 * Supply the cache namespaces on the resource. Alchemy selects the KV
 * adapters and adds the Durable Object queue for background regeneration.
 *
 * **Example:** Binding the writable-ISR resources
 * ```typescript
 * const incCache = yield* Cloudflare.KV.Namespace("NextIncCache");
 * const tagCache = yield* Cloudflare.KV.Namespace("NextTagCache");
 *
 * const site = yield* Cloudflare.Website.Nextjs("Site", {
 *   isr: { incrementalCache: incCache, tagCache },
 * });
 * ```
 *
 * ### Custom Rebuild Scope
 * By default, every project file outside build outputs is hashed to decide
 * whether a rebuild is needed. Use `memo` to narrow the scope when the
 * project has large directories that don't affect the build output.
 *
 * **Example:** Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Nextjs("Site", {
 *   memo: {
 *     include: ["app/**", "public/**", "package.json", "next.config.mjs"],
 *   },
 * });
 * ```
 *
 * ### Build Configuration
 * **Example:** Customize the build
 * ```typescript
 * const site = yield* Cloudflare.Website.Nextjs("Site", {
 *   openNext: { buildCommand: "pnpm exec next build", minify: true },
 * });
 * ```
 *
 * ### Class Form
 * Calling `Nextjs` with no arguments returns a constructor you can
 * `extend` to declare the Worker as a named class. The class is both an
 * `Effect` you can `yield*` to deploy and a type you can reference
 * elsewhere — useful when other resources need to bind to this Worker.
 *
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Site extends Cloudflare.Website.Nextjs<Site>()("Site", {
 *   rootDir: "./apps/web",
 * }) {}
 *
 * const site = yield* Site;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 */
export const Nextjs: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<NextjsProps<Bindings>>
        | Effect.Effect<InputProps<NextjsProps<Bindings>>, never, Req>,
    ): Effect.Effect<Self, never, Req | Providers> & {
      new (): Worker<{
        [
          binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>
        ]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
      }>;
    };
  };
  <const Bindings extends WorkerBindingProps = {}, Req = never>(
    id: string,
    propsEff?:
      | InputProps<NextjsProps<Bindings>>
      | Effect.Effect<InputProps<NextjsProps<Bindings>>, never, Req>,
  ): Effect.Effect<
    Worker<{
      [
        binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>
      ]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
    }>,
    never,
    Req | Providers
  >;
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(Nextjs(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            // `dev.mode` is the integration's dev behavior (routed through
            // the source options below); only `port` maps onto the Worker's
            // own local-dev config.
            dev:
              props?.dev?.port !== undefined
                ? { port: props.dev.port }
                : undefined,
            // OpenNext's revalidation queues (memory-queue, do-queue) fetch
            // the worker back through `WORKER_SELF_REFERENCE`. Always wire
            // the self service binding — it's inert when unused, and its
            // absence turns ISR revalidation into a silent no-op. An
            // explicit user-provided `env.WORKER_SELF_REFERENCE` wins.
            env: {
              WORKER_SELF_REFERENCE: Self,
              ...props?.env,
              ...(props?.isr
                ? {
                    NEXT_INC_CACHE_KV: props.isr.incrementalCache,
                    NEXT_TAG_CACHE_KV: props.isr.tagCache,
                    NEXT_CACHE_DO_QUEUE: DurableObject("NEXT_CACHE_DO_QUEUE", {
                      className: "DOQueueHandler",
                    }),
                  }
                : {}),
            },
            // OpenNext requires Node.js APIs. The 2026-08-31 default date
            // enables both nodejs_compat modes, so no redundant flag is sent.
            compatibility: {
              date: props?.compatibility?.date ?? DEFAULT_COMPATIBILITY_DATE,
              flags: props?.compatibility?.flags,
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
              rootDir: props?.rootDir,
              // `next dev` (Turbopack) cold-starts broken under bun (every
              // route 404s until `.next` is warm) — pin the dev child to node.
              runtime: "node",
              options: {
                root: props?.rootDir,
                memo: props?.memo,
                cache: props?.isr ? "kv" : "static-assets",
                ...props?.openNext,
                ...(props?.dev?.mode !== undefined
                  ? { dev: { mode: props.dev.mode } }
                  : {}),
              },
            },
          }),
        ),
      )) as any;
