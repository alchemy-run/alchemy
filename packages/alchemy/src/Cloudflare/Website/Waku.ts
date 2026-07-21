import * as Effect from "effect/Effect";
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
 * The specifier of the Waku source-provider module. The package must be
 * installed in the user's project — `loadSource` fails with a
 * `SourceProviderError` naming it otherwise.
 */
const WAKU_SOURCE_PROVIDER = "@distilled.cloud/waku/source";

export interface WakuProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<WorkerProps<Bindings>, "vite" | "main" | "assets"> {
  /**
   * Root directory of the Waku project. Defaults to the process working
   * directory.
   */
  rootDir?: string;
  /**
   * Waku source directory, relative to {@link rootDir}.
   * @default "src"
   */
  srcDir?: string;
  /**
   * Waku build output directory, relative to {@link rootDir}. The server
   * bundle is read from `<distDir>/server` and the client assets from
   * `<distDir>/public`.
   * @default "dist"
   */
  distDir?: string;
  /**
   * Base path the app is served under.
   * @default "/"
   */
  basePath?: string;
  /**
   * Controls which files feed the content hash that decides whether a
   * rebuild is needed. By default every non-gitignored file under
   * {@link rootDir} is hashed, plus the nearest package-manager lockfile.
   * Provide `include`/`exclude` globs to narrow the scope.
   */
  memo?: {
    /** Glob patterns of files to hash, relative to {@link rootDir}. */
    include?: string[];
    /** Glob patterns to exclude from hashing. */
    exclude?: string[];
    /** Whether to include the nearest package-manager lockfile in the hash. */
    lockfile?: boolean;
  };
  /**
   * Optional configuration for static asset routing behavior.
   * Supports `runWorkerFirst`, `htmlHandling`, `notFoundHandling`, etc.
   */
  assets?: AssetsConfig;
}

/**
 * A Cloudflare Worker deployed from a [Waku](https://waku.gg) project.
 *
 * `Waku` builds the project programmatically — no `waku.config.ts` edits,
 * no Wrangler configuration, and no build command required. The RSC server
 * bundle deploys as the Worker script and the client output (including
 * SSG-prerendered pages) deploys as static assets.
 *
 * Requires the `@distilled.cloud/waku` package to be installed in your
 * project (alongside `waku` itself). Input files are content-hashed
 * (respecting `.gitignore` by default) so unchanged projects skip the
 * build and deploy entirely.
 *
 * Waku's server runtime uses `AsyncLocalStorage`, so enable the
 * `nodejs_als` (or `nodejs_compat`) compatibility flag.
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 *
 * @section Deploying a Waku Site
 * A single call builds the project and deploys the RSC server bundle plus
 * the client assets.
 *
 * @example Waku site
 * ```typescript
 * const site = yield* Cloudflare.Website.Waku("Site", {
 *   compatibility: {
 *     flags: ["nodejs_als"],
 *   },
 * });
 * ```
 *
 * @example Waku project in a subdirectory
 * ```typescript
 * const site = yield* Cloudflare.Website.Waku("Site", {
 *   rootDir: "apps/web",
 *   compatibility: {
 *     flags: ["nodejs_als"],
 *   },
 * });
 * ```
 *
 * @section Bindings
 * Pass resources through `env` like any other Worker. Server components
 * and API routes read them from the `cloudflare:workers` env at request
 * time. Prefer a guarded dynamic import in page modules — Waku's SSG step
 * renders static pages in Node, where a top-level
 * `import { env } from "cloudflare:workers"` cannot resolve.
 *
 * @example Binding an R2 bucket
 * ```typescript
 * const bucket = yield* Cloudflare.R2.Bucket("Uploads");
 *
 * const site = yield* Cloudflare.Website.Waku("Site", {
 *   compatibility: {
 *     flags: ["nodejs_als"],
 *   },
 *   env: {
 *     UPLOADS: bucket,
 *   },
 * });
 * ```
 *
 * @section Custom Rebuild Scope
 * By default, every non-gitignored file is hashed to decide whether a
 * rebuild is needed. Use `memo` to narrow the scope when your project has
 * large directories that don't affect the build output.
 *
 * @example Narrowing the memo scope
 * ```typescript
 * const site = yield* Cloudflare.Website.Waku("Site", {
 *   compatibility: {
 *     flags: ["nodejs_als"],
 *   },
 *   memo: {
 *     include: ["src/**", "public/**", "package.json"],
 *   },
 * });
 * ```
 *
 * @section Class Form
 * Calling `Waku` with no arguments returns a constructor you can `extend`
 * to declare the Worker as a named class. The class is both an `Effect`
 * you can `yield*` to deploy and a type you can reference elsewhere —
 * useful when other resources need to bind to this Worker.
 *
 * @example Declaring a Waku Worker class
 * ```typescript
 * class Site extends Cloudflare.Website.Waku<Site>()("Site", {
 *   compatibility: { flags: ["nodejs_als"] },
 * }) {}
 *
 * const site = yield* Site;
 * ```
 */
export const Waku: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | InputProps<WakuProps<Bindings>>
        | Effect.Effect<InputProps<WakuProps<Bindings>>, never, Req>,
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
      | InputProps<WakuProps<Bindings>>
      | Effect.Effect<InputProps<WakuProps<Bindings>>, never, Req>,
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
    ? (id: string, propsEff: any) => effectClass(Waku(id, propsEff))
    : Worker(
        id,
        Effect.map(
          Effect.isEffect(propsEff) ? propsEff : Effect.succeed(propsEff),
          (props) => ({
            ...props,
            main: undefined!,
            source: {
              provider: WAKU_SOURCE_PROVIDER,
              options: {
                rootDir: props?.rootDir,
                srcDir: props?.srcDir,
                distDir: props?.distDir,
                basePath: props?.basePath,
                memo: props?.memo,
              },
            },
          }),
        ),
      )) as any;
