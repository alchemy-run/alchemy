import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as FrameworkCore from "../core/index.ts";
import {
  makeSourceModule,
  makeWorkerSource,
  withRootCwd,
  type MemoOptions,
  type ServerDevHandle,
  type SourceProvider,
  type SourceRequirements,
} from "../core/WorkerSource.ts";
import { makeWakuCloudflareTarget } from "./cloudflare.ts";
import { layer as wakuFrameworkLayer } from "./Waku.ts";

export {
  SourceProviderError,
  type DevContext,
  type ServerDevHandle,
  type SourceContext,
  type SourceProvider,
} from "../core/WorkerSource.ts";

/**
 * Serializable options of the waku source descriptor
 * (`{ provider: "@alchemy.run/frontend-frameworks/waku/source", options }` on alchemy's
 * `WorkerProps.source`). MUST stay plain JSON data — the descriptor persists
 * in alchemy state and participates in the Worker metadata hash.
 */
export interface WakuSourceOptions {
  /** Project root. Defaults to the process working directory. */
  readonly rootDir?: string | undefined;
  /**
   * The user's own worker entry (the user-entry seam,
   * `DeployTarget.entry`): a module that wraps waku's handler — imported
   * from `virtual:waku/server-entry` — and re-exports extras (Durable
   * Object classes, additional handlers). Relative paths resolve against
   * the root. When unset, waku's own rsc server entry is deployed.
   */
  readonly main?: string | undefined;
  /** Waku `srcDir` (relative to the root). @default "src" */
  readonly srcDir?: string | undefined;
  /**
   * Waku `distDir` (relative to the root). If `waku.config.ts` customizes
   * `distDir`, mirror it here (or add it to `memo.exclude`) so the build
   * output stays excluded from the rebuild-deciding input hash.
   * @default "dist"
   */
  readonly distDir?: string | undefined;
  /** Waku `basePath`. @default "/" */
  readonly basePath?: string | undefined;
  /** Controls which files feed the rebuild-deciding `input` hash. */
  readonly memo?: WakuMemoOptions | undefined;
}

export type WakuMemoOptions = MemoOptions;

const wakuConfigFor = (options: WakuSourceOptions) => ({
  ...(options.srcDir !== undefined ? { srcDir: options.srcDir } : undefined),
  ...(options.distDir !== undefined ? { distDir: options.distDir } : undefined),
  ...(options.basePath !== undefined ? { basePath: options.basePath } : undefined),
});

const PROVIDER = "@alchemy.run/frontend-frameworks/waku/source";

/** A framework built on Waku's RSC topology (Waku itself, Vocs). */
export interface WakuLikeSourceIntegration {
  readonly provider: string;
  readonly framework: string;
  readonly displayName: string;
  readonly layer: (options: {
    root: string;
    target: ReturnType<typeof makeWakuCloudflareTarget>;
  }) => Layer.Layer<FrameworkCore.Framework, never, SourceRequirements>;
}

/** JSON config the build child reconstructs the waku framework from. */
export interface WakuBuildChildConfig {
  readonly rootDir: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly main: string | undefined;
  readonly waku: {
    readonly srcDir?: string;
    readonly distDir?: string;
    readonly basePath?: string;
  };
}

export const buildInChild = (config: WakuBuildChildConfig) =>
  Effect.gen(function* () {
    const waku = yield* FrameworkCore.Framework;
    return yield* waku.build({ root: config.rootDir });
  }).pipe(
    Effect.provide(
      wakuFrameworkLayer({
        root: config.rootDir,
        waku: config.waku,
        target: makeWakuCloudflareTarget({
          compatibilityDate: config.compatibilityDate,
          compatibilityFlags: config.compatibilityFlags,
          ...(config.main !== undefined ? { main: config.main } : undefined),
        }),
      }),
    ),
  );

/**
 * Waku assumes `process.cwd()` is the project root (its html-shell input and
 * rolldown's relative inputs resolve against it), like its CLI. The build
 * runs in a child rooted there; the dev server, whose inputs are live
 * objects, starts under the project cwd instead (see `withRootCwd`).
 */
export const makeWakuSourceProvider = (
  options: WakuSourceOptions,
  integration: WakuLikeSourceIntegration = {
    provider: PROVIDER,
    framework: "waku",
    displayName: "Waku",
    layer: ({ root, target }) => wakuFrameworkLayer({ root, waku: wakuConfigFor(options), target }),
  },
): SourceProvider => {
  const waku = wakuConfigFor(options);
  return makeWorkerSource({
    provider: integration.provider,
    framework: integration.framework,
    displayName: integration.displayName,
    rootDir: options.rootDir,
    memo: options.memo,
    outputDirs: [options.distDir ?? "dist"],
    // A changed user entry or waku layout must bust the memo.
    hashOptions: {
      main: options.main,
      srcDir: options.srcDir,
      distDir: options.distDir,
      basePath: options.basePath,
    },
    buildConfig: (ctx, rootDir) =>
      ({
        rootDir,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        main: options.main,
        waku,
      }) satisfies WakuBuildChildConfig,
    // Dev runs the Worker in workerd with the Vite plugin's assets service.
    devAssetsBinding: true,
    // Waku dev is a vite dev server with the cloudflare plugin embedded in
    // waku's plugin stack: the rsc environment runs in workerd against the
    // host-provided worker wiring.
    dev: (ctx, { rootDir, fail }) =>
      Effect.gen(function* () {
        const queueConsumers = yield* ctx.worker.queueConsumers;
        const framework = integration.layer({
          root: rootDir,
          target: makeWakuCloudflareTarget({
            compatibilityDate: ctx.compatibility.date,
            compatibilityFlags: ctx.compatibility.flags,
            // Dev serves the wrapped user entry too, so DO classes exported
            // from it exist in dev.
            ...(options.main !== undefined ? { main: options.main } : undefined),
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
          }),
        });
        const server = yield* withRootCwd(
          rootDir,
          Effect.gen(function* () {
            const framework = yield* FrameworkCore.Framework;
            return yield* framework.dev({ root: rootDir });
          }).pipe(Effect.provide(framework)),
        ).pipe(
          Effect.mapError((cause) =>
            fail(`Failed to start the ${integration.framework} dev server`, cause),
          ),
        );
        return { mode: "server", url: new URL(server.url) } satisfies ServerDevHandle;
      }),
  });
};

export default makeSourceModule(PROVIDER, makeWakuSourceProvider);
