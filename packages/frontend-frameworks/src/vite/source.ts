import type {
  BindingHook,
  BindingServices,
  HyperdriveOrigin,
  Assets as RuntimeAssets,
  DurableObjectNamespace,
  QueueConsumer,
  RuntimeServices,
} from "@alchemy.run/cloudflare-runtime/core";
import { Assets } from "@alchemy.run/cloudflare-runtime/core/bindings";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import NodePath from "node:path";
import { runBuildChild } from "../core/BuildChild.ts";
import type { BuildOutput } from "../core/BuildOutput.ts";
import { sha256Object } from "@alchemy.run/node-utils/hash";
import { hashViteInput, type MemoOptions } from "@alchemy.run/node-utils/memo";
import {
  readAssets,
  type AssetsConfig,
  type AssetReadResult,
} from "@alchemy.run/cloudflare-runtime/vite/assets";
import { resolveViteEnv } from "@alchemy.run/cloudflare-runtime/vite/build";
import {
  viteBuildInProcess,
  viteDev,
} from "@alchemy.run/cloudflare-runtime/vite/build";
import type { BundleOutput } from "@alchemy.run/cloudflare-runtime/vite/build-output";

const initialCwd = process.cwd();
export interface ViteSourceOptions {
  main?: string;
  rootDir?: string;
  memo?: MemoOptions & {
    workspaces?: "auto" | Array<MemoOptions & { cwd: string }>;
  };
  viteEnvironments?: { entry?: string; children?: string[] };
}
export interface SourceHash {
  readonly bundle: string | undefined;
  readonly assets: string | undefined;
  readonly input: string | undefined;
  readonly additionalWorkspaces: Array<string> | undefined;
}
/** Structural subset of Alchemy's source context; no dependency on the IaC package. */
export interface SourceContext {
  readonly dotAlchemy?: string;
  readonly id: string;
  readonly fqn: string;
  readonly workerName: string;
  readonly compatibility: { readonly date: string; readonly flags: string[] };
  readonly stack: { readonly name: string; readonly stage: string };
  readonly entry: unknown;
  readonly env: Record<string, unknown> | undefined;
  readonly selfUrl: string | undefined;
  readonly extraOptions: unknown;
  readonly assets:
    | (AssetsConfig & { directory?: string; hash?: string })
    | string
    | undefined;
}
export interface DevContext extends SourceContext {
  readonly worker: {
    readonly bindings: BindingHook<BindingServices>[];
    readonly durableObjectNamespaces: (DurableObjectNamespace & {
      uniqueKey: string;
    })[];
    readonly hyperdrives: Record<string, Required<HyperdriveOrigin>>;
    readonly queueConsumers: Effect.Effect<QueueConsumer[]>;
    readonly assets: RuntimeAssets | undefined;
  };
  readonly runtimeContext: Context.Context<RuntimeServices>;
}
export class SourceProviderError extends Data.TaggedError(
  "Cloudflare.Workers.SourceProviderError",
)<{
  readonly provider: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}
export type SourceError = SourceProviderError | PlatformError;
type SourceServices = FileSystem.FileSystem | Path.Path;
export interface SourceBuildOutput {
  readonly bundle: BundleOutput | undefined;
  readonly assets: AssetReadResult | undefined;
  readonly hash: SourceHash;
}
export interface SourceProvider {
  readonly ownsAssets: boolean;
  readonly build: (
    ctx: SourceContext,
  ) => Effect.Effect<SourceBuildOutput, SourceError, SourceServices>;
  readonly hash: (
    ctx: SourceContext,
    previous: SourceHash | undefined,
  ) => Effect.Effect<Partial<SourceHash>, SourceError, SourceServices>;
  readonly dev: (
    ctx: DevContext,
  ) => Effect.Effect<
    { mode: "server"; url: URL },
    SourceError,
    SourceServices | Scope.Scope
  >;
}
/** In-package composition; not an extension of Alchemy's source-module contract. */
export interface ViteSourcePolicy {
  readonly provider: string;
  readonly assetDefaults?: (
    build: Pick<BuildOutput, "clientDirectory" | "serverDirectory">,
  ) => Effect.Effect<AssetsConfig | undefined, SourceError, SourceServices>;
}
export interface ViteBuildChildConfig {
  readonly rootDir: string;
  readonly env: Record<string, unknown>;
  readonly main: string | undefined;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: string[];
  readonly viteEnvironments: ViteSourceOptions["viteEnvironments"];
}
/** Called by the existing framework build-child runner. */
export const buildInChild = (config: ViteBuildChildConfig) =>
  Effect.gen(function* () {
    const output = yield* viteBuildInProcess(config.rootDir, config.env, {
      main: config.main,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      viteEnvironments: config.viteEnvironments,
    });
    const [bundle, externalWorkspaces] = yield* Effect.all([
      output.serverBundle,
      output.externalWorkspaces,
    ]);
    return {
      clientDirectory: output.clientDirectory,
      serverDirectory: output.serverDirectory,
      base: output.base,
      serverModules: bundle?.files.map((file) => ({
        name: file.path,
        content: file.content,
        hash: file.hash,
      })),
      externalWorkspaces,
    } satisfies BuildOutput;
  });

export const makeViteSource = (
  options: ViteSourceOptions,
  policy: ViteSourcePolicy,
): SourceProvider => {
  const rootDir = NodePath.resolve(initialCwd, options.rootDir ?? ".");
  const wrapError = (cause: { readonly message: string }) =>
    new SourceProviderError({
      provider: policy.provider,
      message: cause.message,
      cause,
    });
  const hashInput = (ctx: SourceContext, workspaces: Iterable<string>) =>
    hashViteInput(
      rootDir,
      options.memo,
      Effect.succeed(workspaces),
      ctx.dotAlchemy,
    ).pipe(
      Effect.map(({ hash, workspaces }) => ({
        input: hash,
        additionalWorkspaces: workspaces,
      })),
    );
  return {
    ownsAssets: true,
    build: Effect.fn(function* (ctx) {
      const env = yield* resolveViteEnv(ctx.env ?? {}, ctx.selfUrl);
      const output = yield* runBuildChild({
        module: import.meta
          .resolve("@alchemy.run/frontend-frameworks/vite/source"),
        rootDir,
        framework: policy.provider,
        config: {
          rootDir,
          env: Object.fromEntries(
            Object.entries(env).filter(([key]) => key.startsWith("VITE_")),
          ),
          main: options.main
            ? NodePath.resolve(rootDir, options.main)
            : undefined,
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          viteEnvironments: options.viteEnvironments,
        } satisfies ViteBuildChildConfig,
      }).pipe(Effect.mapError(wrapError));
      const defaults =
        output.clientDirectory && policy.assetDefaults
          ? yield* policy.assetDefaults(output)
          : undefined;
      const declared =
        ctx.assets && typeof ctx.assets !== "string" ? ctx.assets : undefined;
      // Directory and base come from the completed build, as with the built-in Vite source.
      const {
        directory: _directory,
        hash: _hash,
        ...assetConfig
      } = declared ?? {};
      const files = output.serverModules?.map((file) => ({
        path: file.name,
        content: file.content,
        hash: file.hash,
      }));
      const bundle =
        files && files.length > 0
          ? {
              files: files as BundleOutput["files"],
              hash: yield* sha256Object(
                files.map(({ path, hash }) => ({ path, hash })),
              ),
            }
          : undefined;
      const assets = output.clientDirectory
        ? yield* readAssets({
            ...defaults,
            ...assetConfig,
            directory: output.clientDirectory,
            base: output.base,
          }).pipe(Effect.mapError(wrapError))
        : undefined;
      if (!assets && !bundle)
        return yield* Effect.fail(
          new SourceProviderError({
            provider: policy.provider,
            message: "Vite build produced neither assets nor server output",
          }),
        );
      const input = yield* hashInput(ctx, output.externalWorkspaces);
      return {
        assets,
        bundle,
        hash: { ...input, assets: assets?.hash, bundle: bundle?.hash },
      };
    }),
    hash: (ctx, previous) =>
      hashInput(ctx, previous?.additionalWorkspaces ?? []),
    dev: Effect.fn(function* (ctx) {
      // Alchemy's server-mode child already runs in the app's directory.
      const server = yield* viteDev(
        ".",
        ctx.env ?? {},
        {
          main: options.main,
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          viteEnvironments: options.viteEnvironments,
          worker: {
            name: ctx.workerName,
            bindings: [...ctx.worker.bindings, Assets.local("ASSETS")],
            durableObjectNamespaces: ctx.worker.durableObjectNamespaces,
            hyperdrives: ctx.worker.hyperdrives,
            queueConsumers: yield* ctx.worker.queueConsumers,
            assets: ctx.worker.assets,
          },
          context: ctx.runtimeContext,
        },
        { port: 0 },
      );
      return {
        mode: "server" as const,
        url: new URL(server.resolvedUrls!.local[0]),
      };
    }),
  };
};
