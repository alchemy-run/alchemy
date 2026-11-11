import type {
  BindingHook,
  BindingServices,
  HyperdriveOrigin,
  Assets as RuntimeAssets,
  DurableObjectNamespace as RuntimeDurableObject,
  QueueConsumer as RuntimeQueueConsumer,
  RuntimeServices,
  RuntimeWorker,
} from "@alchemy.run/cloudflare-runtime/core";
import {
  listFileSystemDirectory,
  parseIgnoreRules,
  walkIgnoring,
} from "@alchemy.run/node-utils/ignore-rules";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import { resolveBuildEnv, runBuildChild } from "./BuildChild.ts";
import type { BuildOutput } from "./BuildOutput.ts";
import { hashInput, sha256, sha256Object, type MemoOptions } from "./InputHash.ts";

export type { MemoOptions } from "./InputHash.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Structural mirror of alchemy's Worker source-provider contract
// (`packages/cloudflare/src/Workers/Source.ts`). Implemented structurally, with
// no alchemy import, so version skew degrades to a load-time
// `SourceProviderError` instead of a crash. Keep in sync with alchemy.
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceHash {
  readonly bundle: string | undefined;
  readonly assets: string | undefined;
  readonly input: string | undefined;
  readonly additionalWorkspaces: Array<string> | undefined;
}

export interface BundleFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly hash: string;
}

export interface BundleOutput {
  readonly files: [BundleFile, ...Array<BundleFile>];
  readonly hash: string;
}

export interface AssetReadResult {
  directory: string;
  config: Record<string, unknown> | undefined;
  manifest: Record<string, { hash: string; size: number }>;
  _headers: string | undefined;
  _redirects: string | undefined;
  hash: string;
}

export interface SourceBuildOutput {
  readonly bundle: BundleOutput | undefined;
  readonly assets: AssetReadResult | undefined;
  readonly hash: Partial<SourceHash>;
}

export interface SourceContext {
  readonly id: string;
  readonly fqn?: string;
  readonly workerName: string;
  readonly compatibility: { readonly date: string; readonly flags: Array<string> };
  readonly entry:
    | { readonly kind: "external" }
    | { readonly kind: "effect"; readonly exports: Record<string, unknown> };
  readonly stack: { readonly name: string; readonly stage: string };
  readonly env: Record<string, unknown> | undefined;
  readonly selfUrl?: string | undefined;
  readonly extraOptions: unknown;
  /** Raw `props.assets`; sources that own assets merge its routing config in. */
  readonly assets: unknown;
}

export interface DevContext extends SourceContext {
  readonly worker: {
    readonly bindings: Array<BindingHook<BindingServices>>;
    readonly durableObjectNamespaces: Array<RuntimeDurableObject & { uniqueKey: string }>;
    readonly hyperdrives: Record<string, Required<HyperdriveOrigin>>;
    readonly queueConsumers: Effect.Effect<Array<RuntimeQueueConsumer>>;
    readonly assets: RuntimeAssets | undefined;
    /** The Worker's other runtime settings, spread whole into the runtime Worker. */
    readonly options: Pick<
      RuntimeWorker,
      "workflows" | "crons" | "tails" | "streamingTails" | "cache" | "cf" | "access" | "workerd"
    >;
  };
  readonly runtimeContext: Context.Context<RuntimeServices>;
}

/** The `server`-mode arm of alchemy's `SourceDevHandle`. */
export interface ServerDevHandle {
  readonly mode: "server";
  readonly url: URL;
  /** Register an HTTP forwarding Worker when the server does not run in workerd. */
  readonly serviceBinding?: "http";
}

/** Tag-compatible with alchemy's `SourceProviderError`, so `catchTag` matches on both sides. */
export class SourceProviderError extends Data.TaggedError(
  "Cloudflare.Workers.SourceProviderError",
)<{
  readonly provider: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SourceError = SourceProviderError | PlatformError;

export type SourceRequirements = FileSystem.FileSystem | Path.Path;

export interface SourceProvider {
  readonly ownsAssets: boolean;
  readonly devAssetsBinding?: boolean;
  readonly build: (
    ctx: SourceContext,
  ) => Effect.Effect<SourceBuildOutput, SourceError, SourceRequirements>;
  readonly hash: (
    ctx: SourceContext,
    previous: SourceHash | undefined,
  ) => Effect.Effect<Partial<SourceHash>, SourceError, SourceRequirements>;
  readonly dev: (
    ctx: DevContext,
  ) => Effect.Effect<ServerDevHandle, SourceError, SourceRequirements | Scope.Scope>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Building blocks
// ─────────────────────────────────────────────────────────────────────────────

/** Routing config from raw `props.assets`; `directory`/`hash` are alchemy's path-level concerns. */
export const assetsConfigOf = (assets: unknown): Record<string, unknown> | undefined => {
  if (assets === undefined || assets === null || typeof assets !== "object") return undefined;
  const { directory: _directory, hash: _hash, ...config } = assets as Record<string, unknown>;
  return Object.keys(config).length > 0 ? config : undefined;
};

const SPECIAL_ASSET_FILES = [".assetsignore", "_headers", "_redirects"];

/** Cloudflare's Workers assets limits. */
const MAX_ASSET_COUNT = 20_000;
const MAX_ASSET_SIZE = 25 * 1024 * 1024;

/** A client directory over Cloudflare's asset count or size limit. */
export class AssetLimitError extends Data.TaggedError("AssetLimitError")<{
  readonly message: string;
}> {}

const maybeReadString = Effect.fn(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.undefined,
    ),
  );
});

/**
 * Read a client output directory into the manifest alchemy's asset upload
 * consumes: `sha256(content).slice(0, 32)` + size per `/`-prefixed posix
 * path. The aggregate hash covers only upload-affecting inputs.
 */
export const readClientAssets = Effect.fn(function* (
  directory: string,
  config: Record<string, unknown> | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [ignoreFile, _headers, _redirects] = yield* Effect.all([
    maybeReadString(path.join(directory, ".assetsignore")),
    maybeReadString(path.join(directory, "_headers")),
    maybeReadString(path.join(directory, "_redirects")),
  ]);
  // `.assetsignore` uses gitignore semantics, as in wrangler. Excluded
  // directories are skipped without being read.
  const files = (yield* walkIgnoring({
    list: yield* listFileSystemDirectory(directory),
    rules: parseIgnoreRules(
      [...SPECIAL_ASSET_FILES, ...(ignoreFile?.split("\n") ?? [])],
      "gitignore",
    ),
  })).flatMap((entry) => (entry.type === "Directory" ? [] : [entry.path]));
  if (files.length > MAX_ASSET_COUNT) {
    return yield* new AssetLimitError({
      message: `Too many assets in ${directory} (maximum is ${MAX_ASSET_COUNT}, found ${files.length})`,
    });
  }
  const manifest = new Map<string, { hash: string; size: number }>();
  yield* Effect.forEach(
    files,
    Effect.fn(function* (relPath) {
      const file = path.join(directory, relPath);
      const stat = yield* fs.stat(file);
      if (Number(stat.size) > MAX_ASSET_SIZE) {
        return yield* new AssetLimitError({
          message: `Asset ${relPath} is too large (the maximum size is 25 MB)`,
        });
      }
      manifest.set(`/${relPath}`, {
        hash: (yield* sha256(yield* fs.readFile(file))).slice(0, 32),
        size: Number(stat.size),
      });
    }),
    { concurrency: 16 },
  );
  const sortedManifest = Object.fromEntries(
    Array.from(manifest.entries()).sort((a, b) => a[0].localeCompare(b[0])),
  );
  return {
    directory,
    config,
    manifest: sortedManifest,
    _headers,
    _redirects,
    hash: yield* sha256Object({ config, manifest: sortedManifest, _headers, _redirects }),
  } satisfies AssetReadResult;
});

/** Map a build's server modules (entry first) onto alchemy's bundle shape. */
export const bundleOf = Effect.fn(function* (
  serverModules: BuildOutput["serverModules"],
): Effect.fn.Return<BundleOutput | undefined> {
  if (serverModules === undefined || serverModules.length === 0) return undefined;
  const files = serverModules.map((module) => ({
    path: module.name.replaceAll("\\", "/"),
    content: module.content,
    hash: module.hash,
  })) as [BundleFile, ...Array<BundleFile>];
  return { files, hash: yield* sha256Object(files.map((file) => [file.path, file.hash])) };
});

// ─────────────────────────────────────────────────────────────────────────────
// The provider
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerSourceSpec<Config> {
  /**
   * This source module's package specifier. It must export
   * `buildInChild(config)`: the build child imports it by this specifier,
   * since `import.meta.url` names a shared chunk once the package is bundled.
   */
  readonly provider: string;
  /** Framework name for build-child error attribution. */
  readonly framework: string;
  readonly displayName: string;
  /** Run the build child under Node instead of the current runtime. */
  readonly runtime?: "node" | undefined;
  /** Project root. @default process.cwd() */
  readonly rootDir: string | undefined;
  readonly memo: MemoOptions | undefined;
  /** Build output directories relative to the root, excluded from the input hash. */
  readonly outputDirs: ReadonlyArray<string>;
  /** Build-affecting options that must bust the memo when they change. */
  readonly hashOptions?: unknown;
  /** JSON config handed to `buildInChild` in the build child. */
  readonly buildConfig: (ctx: SourceContext, rootDir: string) => Config;
  /** Reject a build without server modules. @default true */
  readonly requireServer?: boolean | undefined;
  /** Reject a build without a client directory. @default false */
  readonly requireClient?: boolean | undefined;
  /** Dev runs the Worker in workerd with the Vite plugin's assets service. */
  readonly devAssetsBinding?: boolean | undefined;
  /** Start the dev server, failing with this source's `SourceProviderError`. */
  readonly dev: (
    ctx: DevContext,
    helpers: { readonly rootDir: string },
  ) => Effect.Effect<ServerDevHandle, SourceError, SourceRequirements | Scope.Scope>;
}

/**
 * The common Cloudflare Worker source: the framework's production build runs
 * in a child process rooted at the project, its server modules become the
 * bundle and its client output the assets, and the rebuild-free `input` hash
 * covers the project tree, the workspaces it imports and the lockfile.
 */
export const makeWorkerSource = <Config>(spec: WorkerSourceSpec<Config>): SourceProvider => {
  const rootDirOf = (path: Path.Path) => path.resolve(spec.rootDir ?? process.cwd());
  const input = (rootDir: string, workspaces: Iterable<string>) =>
    hashInput({
      rootDir,
      outputDirs: spec.outputDirs,
      memo: spec.memo,
      workspaces,
      options: spec.hashOptions,
    });

  return {
    ownsAssets: true,
    ...(spec.devAssetsBinding ? { devAssetsBinding: true } : {}),

    build: Effect.fn(function* (ctx) {
      const path = yield* Path.Path;
      const rootDir = rootDirOf(path);
      const output = yield* runBuildChild({
        module: import.meta.resolve(spec.provider),
        rootDir,
        framework: spec.framework,
        env: resolveBuildEnv(ctx.env),
        config: spec.buildConfig(ctx, rootDir),
        ...(spec.runtime ? { runtime: spec.runtime } : {}),
      }).pipe(
        Effect.mapError(
          (error) =>
            new SourceProviderError({
              provider: spec.provider,
              message: error.message,
              cause: error.cause ?? error,
            }),
        ),
      );
      const bundle = yield* bundleOf(output.serverModules);
      if (bundle === undefined && (spec.requireServer ?? true)) {
        return yield* new SourceProviderError({
          provider: spec.provider,
          message: `${spec.displayName} build produced no server modules`,
        });
      }
      if (output.clientDirectory === undefined && spec.requireClient) {
        return yield* new SourceProviderError({
          provider: spec.provider,
          message: `${spec.displayName} build produced no client directory`,
        });
      }
      if (bundle === undefined && output.clientDirectory === undefined) {
        return yield* new SourceProviderError({
          provider: spec.provider,
          message: `${spec.displayName} build produced neither server modules nor assets`,
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
                    new SourceProviderError({ provider: spec.provider, message: error.message }),
                  ),
                ),
              )
            : Effect.undefined,
          input(rootDir, output.externalWorkspaces),
        ],
        { concurrency: "unbounded" },
      );
      return {
        bundle,
        assets,
        hash: {
          bundle: bundle?.hash,
          assets: assets?.hash,
          input: inputHash.hash,
          additionalWorkspaces: inputHash.workspaces,
        },
      } satisfies SourceBuildOutput;
    }),

    // Rebuild-free: re-hash the tree over the previously discovered workspaces.
    hash: Effect.fn(function* (_ctx, previous) {
      const path = yield* Path.Path;
      const { hash, workspaces } = yield* input(
        rootDirOf(path),
        previous?.additionalWorkspaces ?? [],
      );
      return { input: hash, additionalWorkspaces: workspaces };
    }),

    dev: Effect.fn(function* (ctx) {
      const path = yield* Path.Path;
      return yield* spec.dev(ctx, { rootDir: rootDirOf(path) });
    }),
  };
};

/**
 * The module contract alchemy's `loadSource` expects: `make(options)` builds
 * a provider from the descriptor's JSON options.
 */
export const makeSourceModule = <Options>(
  provider: string,
  make: (options: Options) => SourceProvider,
) => ({
  make: (options: unknown): Effect.Effect<SourceProvider, SourceProviderError> =>
    options !== undefined && (typeof options !== "object" || options === null)
      ? Effect.fail(
          new SourceProviderError({
            provider,
            message: `Invalid options for ${provider}: expected an object, got ${typeof options}`,
          }),
        )
      : Effect.succeed(make((options ?? {}) as Options)),
});
