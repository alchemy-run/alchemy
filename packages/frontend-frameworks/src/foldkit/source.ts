/**
 * `@alchemy.run/frontend-frameworks/foldkit/source` — alchemy Worker source
 * provider for Foldkit apps (`Cloudflare.Website.Foldkit`), built on the
 * shared `makeWorkerSource` skeleton with the Foldkit Cloudflare target.
 */
import * as Effect from "effect/Effect";
import { resolveBuildEnv } from "../core/BuildChild.ts";
import {
  makeSourceModule,
  makeWorkerSource,
  SourceProviderError,
  type MemoOptions,
  type ServerDevHandle,
  type SourceProvider,
} from "../core/WorkerSource.ts";
import { foldkitAssetDefaults, makeFoldkitCloudflareTarget } from "./cloudflare.ts";
import { make as makeFoldkit } from "./Foldkit.ts";

export {
  SourceProviderError,
  type DevContext,
  type ServerDevHandle,
  type SourceContext,
  type SourceProvider,
} from "../core/WorkerSource.ts";

const PROVIDER = "@alchemy.run/frontend-frameworks/foldkit/source";

/**
 * Descriptor options. JSON-serializable: they persist in alchemy state and
 * participate in the Worker's metadata hash.
 */
export interface FoldkitSourceOptions {
  /** Project root. @default process.cwd() */
  readonly rootDir?: string | undefined;
  /**
   * Custom Worker entry for a client-only app, relative to the root. Cannot
   * be combined with Foldkit's `ssr.build`.
   */
  readonly main?: string | undefined;
  /** Narrows the rebuild-detection input hash. */
  readonly memo?: MemoOptions | undefined;
}

/** JSON config the build child hands to {@link buildInChild}. */
export interface FoldkitBuildChildConfig {
  readonly rootDir: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly main: string | undefined;
}

export const buildInChild = (config: FoldkitBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* makeFoldkit({
      root: config.rootDir,
      target: makeFoldkitCloudflareTarget({
        main: config.main,
        compatibilityDate: config.compatibilityDate,
        compatibilityFlags: config.compatibilityFlags,
      }),
    });
    return yield* framework.build({ root: config.rootDir });
  });

export const makeFoldkitSource = (options: FoldkitSourceOptions): SourceProvider =>
  makeWorkerSource({
    provider: PROVIDER,
    framework: "foldkit",
    displayName: "Foldkit",
    rootDir: options.rootDir,
    memo: options.memo,
    outputDirs: ["dist"],
    // A changed custom entry must bust the memo.
    hashOptions: { main: options.main },
    // A client-only app without `main` deploys assets alone.
    requireServer: false,
    buildConfig: (ctx, rootDir) =>
      ({
        rootDir,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        main: options.main,
      }) satisfies FoldkitBuildChildConfig,
    assetDefaults: (output) => foldkitAssetDefaults(output, options.main),
    // Dev runs the Worker in workerd with the Vite plugin's assets service.
    devAssetsBinding: true,
    dev: (ctx, { rootDir }) =>
      Effect.gen(function* () {
        const queueConsumers = yield* ctx.worker.queueConsumers;
        const framework = yield* makeFoldkit({
          root: rootDir,
          target: makeFoldkitCloudflareTarget(
            {
              main: options.main,
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
              context: ctx.runtimeContext,
            },
            resolveBuildEnv(ctx.env),
          ),
        });
        const server = yield* framework.dev({ root: rootDir, port: 0 }).pipe(
          Effect.mapError(
            (error) =>
              new SourceProviderError({
                provider: PROVIDER,
                message: error.message,
                cause: error.cause ?? error,
              }),
          ),
        );
        return { mode: "server", url: new URL(server.url) } satisfies ServerDevHandle;
      }),
  });

export default makeSourceModule(PROVIDER, makeFoldkitSource);
