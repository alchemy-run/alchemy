/**
 * `@alchemy.run/frontend-frameworks/effect-ui/source` — alchemy Worker source
 * provider for Effect UI apps (`Cloudflare.Website.EffectUI`), built on the
 * shared `makeWorkerSource` skeleton with the Effect UI Cloudflare target.
 */
import * as Effect from "effect/Effect";
import { resolveBuildEnv } from "../core/BuildChild.ts";
import {
  makeSourceModule,
  makeWorkerSource,
  type SourceModuleContext,
  SourceProviderError,
  type MemoOptions,
  type ServerDevHandle,
  type SourceProvider,
} from "../core/WorkerSource.ts";
import { effectUIAssetDefaults, makeEffectUICloudflareTarget } from "./cloudflare.ts";
import { make as makeEffectUI } from "./EffectUI.ts";

export {
  SourceProviderError,
  type DevContext,
  type ServerDevHandle,
  type SourceContext,
  type SourceProvider,
} from "../core/WorkerSource.ts";

const PROVIDER = "@alchemy.run/frontend-frameworks/effect-ui/source";

/**
 * Descriptor options. JSON-serializable: they persist in alchemy state and
 * participate in the Worker's metadata hash.
 */
export interface EffectUISourceOptions {
  /**
   * Custom Worker entry for an app without a server handler, relative to
   * the root. Cannot be combined with `HtmlServerVite`'s `serverOutDir`.
   */
  readonly main?: string | undefined;
  /** Narrows the rebuild-detection input hash. */
  readonly memo?: MemoOptions | undefined;
}

/** JSON config the build child hands to {@link buildInChild}. */
export interface EffectUIBuildChildConfig {
  readonly rootDir: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly main: string | undefined;
}

export const buildInChild = (config: EffectUIBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* makeEffectUI({
      root: config.rootDir,
      target: makeEffectUICloudflareTarget({
        main: config.main,
        compatibilityDate: config.compatibilityDate,
        compatibilityFlags: config.compatibilityFlags,
      }),
    });
    return yield* framework.build({ root: config.rootDir });
  });

export const makeEffectUISource = (
  options: EffectUISourceOptions,
  { rootDir }: SourceModuleContext,
): SourceProvider =>
  makeWorkerSource({
    provider: PROVIDER,
    framework: "effect-ui",
    displayName: "Effect UI",
    rootDir,
    memo: options.memo,
    outputDirs: ["dist"],
    // A changed custom entry must bust the memo.
    // A client-only app without `main` deploys assets alone.
    requireServer: false,
    buildConfig: (ctx, rootDir) =>
      ({
        rootDir,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        main: options.main,
      }) satisfies EffectUIBuildChildConfig,
    assetDefaults: (output) => effectUIAssetDefaults(output, options.main),
    // Dev runs the Worker in workerd with the Vite plugin's assets service.
    devAssetsBinding: true,
    dev: (ctx, { rootDir }) =>
      Effect.gen(function* () {
        const queueConsumers = yield* ctx.worker.queueConsumers;
        const framework = yield* makeEffectUI({
          root: rootDir,
          target: makeEffectUICloudflareTarget(
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
              entrypoints: ctx.worker.entrypoints,
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

export default makeSourceModule(PROVIDER, makeEffectUISource);
