import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
import { effectClass } from "../../Util/effect.ts";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import {
  Worker,
  type NormalizedBindings,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

/**
 * The module specifier of the Next.js source provider. Loaded with a
 * dynamic `import()`, so `@distilled.cloud/nextjs` must be installed in
 * the deploying project.
 */
const NEXTJS_SOURCE_PROVIDER = "@distilled.cloud/nextjs/source";

/**
 * The default compatibility date when none is provided. Matches the
 * `@distilled.cloud/nextjs` integration's own default so deploy and local
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
  /** Next.js/OpenNext-specific build configuration. */
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
 * [`@distilled.cloud/nextjs`](https://github.com/alchemy-run/cloudflare-tools):
 * `next build` runs through `@opennextjs/cloudflare`, the resulting worker
 * is bundled into a self-contained ES module set, and the static assets
 * (including prerendered pages and the read-only incremental cache) deploy
 * as Workers static assets. Input files are content-hashed so unchanged
 * projects skip the build and deploy entirely.
 *
 * Both `@distilled.cloud/nextjs` and its peer `@opennextjs/cloudflare`
 * must be installed in the deploying project — the source provider is
 * loaded with a dynamic `import()`.
 *
 * Known v1 limitations:
 * - The incremental cache is the read-only static-assets flavor: ISR pages
 *   serve their prerendered payloads, but revalidation writes are a no-op
 *   (no KV/R2/D1-backed cache yet).
 * - `WORKER_SELF_REFERENCE` (OpenNext's self service binding, used by the
 *   revalidation queue) is not wired on deploy — consistent with the
 *   read-only cache above.
 * - Local dev (`alchemy dev`) is preview parity: the built worker served
 *   under workerd, no HMR.
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
} = ((id?: any, propsEff?: any) =>
  id === undefined
    ? (id: string, propsEff: any) => effectClass(Nextjs(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
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
              options: {
                root: props?.rootDir,
                memo: props?.memo,
                ...props?.nextjs,
              },
            },
          }),
        ),
      )) as any;
