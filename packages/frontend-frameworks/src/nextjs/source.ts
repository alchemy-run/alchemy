/**
 * The alchemy Worker source-provider entry for Next.js
 * (`@alchemy.run/frontend-frameworks/nextjs/source`).
 *
 * `build()` runs this package's OpenNext-based, wrangler-free pipeline
 * (`Nextjs.ts`) in a build child: server modules become the worker bundle
 * (entry first), `.open-next/assets` becomes the static-assets manifest, and
 * the project tree is content-hashed for rebuild-free diffs. `hash()` never
 * builds. `dev()` serves the built worker under cloudflare-runtime (workerd),
 * or with `dev.mode: "hmr"` runs `next dev` in Node behind an HTTP service
 * binding.
 *
 * This is a small wrapper over the shared `core/WorkerSource.ts` building
 * blocks rather than `makeWorkerSource`: the input hash also covers the
 * OpenNext config file (read on every hash, even outside a narrowed memo
 * scope) and excludes the host's runtime directory (`ctx.dotAlchemy`), both
 * of which are only known per call.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveBuildEnv, runBuildChild } from "../core/BuildChild.ts";
import * as FrameworkCore from "../core/index.ts";
import { hashInput, sha256, type MemoOptions } from "../core/InputHash.ts";
import {
  assetsConfigOf,
  bundleOf,
  readClientAssets,
  SourceProviderError,
  type AssetReadResult,
  type BundleFile,
  type ServerDevHandle,
  type SourceBuildOutput,
  type SourceContext,
  type SourceError,
  type SourceHash,
  type SourceModuleContext,
  type SourceProvider,
  type SourceRequirements,
} from "../core/WorkerSource.ts";
import * as Nextjs from "./Nextjs.ts";
import * as Runner from "./Runner.ts";

export {
  SourceProviderError,
  type DevContext,
  type SourceBuildOutput,
  type SourceContext,
  type SourceError,
  type SourceHash,
  type SourceProvider,
} from "../core/WorkerSource.ts";
export type SourceBundleFile = BundleFile;
export type SourceAssets = AssetReadResult;
export type SourceDevHandle = ServerDevHandle;
export type SourceServices = SourceRequirements;

const PROVIDER = "@alchemy.run/frontend-frameworks/nextjs/source";

/** Build outputs and tool caches under the root, never hashed. */
const OUTPUT_DIRS = [".next", ".open-next", "dist", ".turbo", ".vercel", ".wrangler"];

/** Controls which project files are content-hashed to decide whether the OpenNext build re-runs. */
export type NextjsMemoOptions = MemoOptions;

/**
 * The JSON-serializable options of the `@alchemy.run/frontend-frameworks/nextjs/source`
 * descriptor (`WorkerProps.source.options`). Must stay JSON-stable — the
 * descriptor persists in state and participates in the Worker metadata hash.
 */
export interface NextjsSourceOptions {
  /** Rebuild-scope configuration (which files bust the build memo). */
  readonly memo?: NextjsMemoOptions | undefined;
  /** Optional explicit config; otherwise discover `open-next.config.ts`, falling back to generated defaults. */
  readonly configPath?: string | undefined;
  /** Resource-selected cache adapters. Defaults to the read-only static-assets cache. */
  readonly cache?: "static-assets" | "kv" | undefined;
  /**
   * The command the OpenNext pipeline runs to build the Next.js app.
   * Takes precedence over an explicitly supplied OpenNext config.
   * @default "npx next build"
   */
  readonly buildCommand?: string | undefined;
  /** Skip the internal `next build` (reuse an existing `.next`). */
  readonly skipNextBuild?: boolean | undefined;
  /** Minify the OpenNext bundling steps and the final bundle pass. */
  readonly minify?: boolean | undefined;
  /** Enable OpenNext debug logging (and verbose workerd output in dev). */
  readonly debug?: boolean | undefined;
  /** Dev-server behavior (JSON-stable; does not affect the build). */
  readonly dev?:
    | {
        /**
         * - `"preview"` (default): build the OpenNext worker and serve it
         *   under `cloudflare-runtime` (workerd) — production parity, no HMR.
         * - `"hmr"`: run the real `next dev` (Turbopack HMR) in Node with the
         *   worker's bindings proxied from `cloudflare-runtime` onto
         *   OpenNext's `getCloudflareContext()` contract. App code runs in
         *   Node, not workerd — CF-specific runtime behavior and ISR/caching
         *   semantics still need `"preview"`.
         * @default "preview"
         */
        readonly mode?: "preview" | "hmr" | undefined;
      }
    | undefined;
}

/** alchemy's `SourceContext` carries the resolved runtime directory, excluded from inputs. */
export type NextjsSourceContext = SourceContext & { readonly dotAlchemy?: string | undefined };

/** The context `hash()` reads: only the runtime directory. */
export type NextjsHashContext = Pick<NextjsSourceContext, "id" | "dotAlchemy">;

/** {@link SourceProvider} whose `hash()` needs only the runtime directory. */
export interface NextjsSourceProvider extends Omit<SourceProvider, "build" | "hash"> {
  readonly build: (
    ctx: NextjsSourceContext,
  ) => Effect.Effect<SourceBuildOutput, SourceError, SourceRequirements>;
  readonly hash: (
    ctx: NextjsHashContext,
    previous: SourceHash | undefined,
  ) => Effect.Effect<Partial<SourceHash>, SourceError, SourceRequirements>;
}

/** Run `use` against a freshly-built `Framework` service for `options`. */
const withFramework = <A, E, R>(
  options: Nextjs.NextjsFrameworkOptions,
  use: (framework: FrameworkCore.Framework["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const framework = yield* FrameworkCore.Framework;
    return yield* use(framework);
  }).pipe(Effect.provide(Nextjs.make(options)));

/**
 * The production build runs in a disposable child process with
 * `cwd = project root` (see `core/BuildChild.ts`). The OpenNext pipeline
 * itself already runs in its own child (`runner.mjs`, nested inside this
 * one), but the surrounding steps — `open-next.config.ts` handling, the
 * final bundle pass, cache population — execute framework/user code that
 * must not run in the engine process either. The shared `core/BuildChildRunner`
 * entry imports this module in the child and calls the exported
 * {@link buildInChild}.
 */
export interface NextjsBuildChildConfig {
  readonly rootDir: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly configPath: string | undefined;
  readonly cache: "static-assets" | "kv" | undefined;
  readonly buildCommand: string | undefined;
  readonly skipNextBuild: boolean | undefined;
  readonly minify: boolean | undefined;
  readonly debug: boolean | undefined;
}

export const buildInChild = (config: NextjsBuildChildConfig) =>
  withFramework(
    {
      root: config.rootDir,
      vite: {
        compatibilityDate: config.compatibilityDate,
        compatibilityFlags: config.compatibilityFlags,
      },
      nextjs: {
        configPath: config.configPath,
        cache: config.cache,
        buildCommand: config.buildCommand,
        skipNextBuild: config.skipNextBuild,
        minify: config.minify,
        debug: config.debug,
      },
    },
    (framework) => framework.build({ root: config.rootDir }),
  );

export const makeNextjsSourceProvider = (
  options: NextjsSourceOptions,
  { rootDir: root }: SourceModuleContext,
): NextjsSourceProvider => {
  /**
   * The shared input hash, plus the OpenNext config file (path and content)
   * in the salt and the runtime directory, when under the root, among the
   * excluded output directories.
   */
  const input = Effect.fn(function* (
    rootDir: string,
    dotAlchemy: string | undefined,
    workspaces: Iterable<string>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configPath = yield* Runner.resolveConfigPath({
      appDir: rootDir,
      configPath: options.configPath,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SourceProviderError({ provider: PROVIDER, message: cause.message, cause: cause }),
      ),
    );
    const config =
      configPath === undefined
        ? undefined
        : {
            path: path.relative(rootDir, configPath).replaceAll("\\", "/"),
            hash: yield* sha256(yield* fs.readFile(configPath)),
          };
    const runtimeDir =
      dotAlchemy === undefined ? undefined : path.relative(rootDir, path.resolve(dotAlchemy));
    const insideRoot =
      runtimeDir !== undefined &&
      runtimeDir !== "" &&
      runtimeDir !== ".." &&
      !runtimeDir.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(runtimeDir);
    return yield* hashInput({
      rootDir,
      outputDirs: insideRoot ? [...OUTPUT_DIRS, runtimeDir.replaceAll("\\", "/")] : OUTPUT_DIRS,
      memo: options.memo,
      workspaces,
      options: {
        config,
        configPath: options.configPath,
        cache: options.cache,
        buildCommand: options.buildCommand,
        skipNextBuild: options.skipNextBuild,
        minify: options.minify,
      },
    });
  });

  return {
    ownsAssets: true,

    build: Effect.fn(function* (ctx) {
      const path = yield* Path.Path;
      const rootDir = root;
      const output = yield* runBuildChild({
        module: import.meta.resolve(PROVIDER),
        rootDir,
        framework: "nextjs",
        env: resolveBuildEnv(ctx.env),
        config: {
          rootDir,
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          configPath: options.configPath,
          cache: options.cache,
          buildCommand: options.buildCommand,
          skipNextBuild: options.skipNextBuild,
          minify: options.minify,
          debug: options.debug,
        } satisfies NextjsBuildChildConfig,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SourceProviderError({ provider: PROVIDER, message: cause.message, cause: cause }),
        ),
      );
      const bundle = yield* bundleOf(output.serverModules);
      if (bundle === undefined) {
        return yield* new SourceProviderError({
          provider: PROVIDER,
          message: "The OpenNext build produced no server modules",
        });
      }
      const [assets, inputHash] = yield* Effect.all(
        [
          output.clientDirectory !== undefined
            ? readClientAssets(
                path.resolve(rootDir, output.clientDirectory),
                assetsConfigOf(ctx.assets),
              ).pipe(
                Effect.catchTag("AssetLimitError", (error) =>
                  Effect.fail(
                    new SourceProviderError({ provider: PROVIDER, message: error.message }),
                  ),
                ),
              )
            : Effect.undefined,
          input(rootDir, ctx.dotAlchemy, output.externalWorkspaces),
        ],
        { concurrency: "unbounded" },
      );
      return {
        bundle,
        assets,
        hash: {
          bundle: bundle.hash,
          assets: assets?.hash,
          input: inputHash.hash,
          additionalWorkspaces: inputHash.workspaces,
        },
      } satisfies SourceBuildOutput;
    }),

    hash: Effect.fn(function* (ctx, previous) {
      const { hash, workspaces } = yield* input(
        root,
        ctx.dotAlchemy,
        previous?.additionalWorkspaces ?? [],
      );
      return { input: hash, additionalWorkspaces: workspaces };
    }),

    // Default ("preview"): always build on dev start (OpenNext memoizes
    // where possible) and serve the built worker under cloudflare-runtime
    // (workerd) with the alchemy-managed binding wiring. No HMR; ISR
    // revalidation writes are a no-op.
    // With `options.dev.mode: "hmr"`, the Framework instead runs the real
    // `next dev` (Turbopack HMR) in Node — the alchemy-managed bindings are
    // proxied through cloudflare-runtime's platform proxy onto OpenNext's
    // getCloudflareContext() contract.
    dev: Effect.fn(function* (ctx) {
      const queueConsumers = yield* ctx.worker.queueConsumers;
      const devOptions: Nextjs.NextjsFrameworkOptions = {
        root,
        nextjs: {
          configPath: options.configPath,
          cache: options.cache,
          buildCommand: options.buildCommand,
          skipNextBuild: options.skipNextBuild,
          minify: options.minify,
          debug: options.debug,
        },
        dev: options.dev,
        // The host's runtime stack (includes remote-bindings support) — the
        // dev binding proxy is hosted in it instead of the credential-free
        // internal layer, so `Alchemy.remote()` bindings resolve in dev.
        services: ctx.runtimeContext,
        vite: {
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          worker: {
            ...ctx.worker.options,
            name: ctx.workerName,
            bindings: ctx.worker.bindings,
            durableObjectNamespaces: ctx.worker.durableObjectNamespaces,
            hyperdrives: ctx.worker.hyperdrives,
            queueConsumers,
            assets: ctx.worker.assets,
          },
        },
      };
      const server = yield* withFramework(devOptions, (framework) => framework.dev({ root })).pipe(
        Effect.mapError(
          (cause) =>
            new SourceProviderError({ provider: PROVIDER, message: cause.message, cause: cause }),
        ),
      );
      return {
        mode: "server",
        url: new URL(server.url),
        ...(options.dev?.mode === "hmr" ? { serviceBinding: "http" as const } : {}),
      } satisfies ServerDevHandle;
    }),
  };
};

/**
 * The `WorkerSourceModule` implementation: validate the descriptor options
 * and hand back the provider. Kept local (rather than `makeSourceModule`) so
 * the returned provider keeps its narrower `hash()` context and arrays are
 * still rejected.
 */
const make = (
  options: unknown,
  context: SourceModuleContext,
): Effect.Effect<NextjsSourceProvider, SourceProviderError> =>
  options !== undefined &&
  (typeof options !== "object" || options === null || Array.isArray(options))
    ? Effect.fail(
        new SourceProviderError({
          provider: PROVIDER,
          message: "Invalid source options: expected a plain JSON object (NextjsSourceOptions)",
        }),
      )
    : Effect.succeed(makeNextjsSourceProvider((options ?? {}) as NextjsSourceOptions, context));

export default { make };
