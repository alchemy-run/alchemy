/**
 * `@alchemy.run/frontend-frameworks/vocs/azure` — the Azure Functions deploy
 * target and framework module for Vocs (`Azure.Website.Vocs`).
 *
 * The build runs the Vocs (Waku RSC) pipeline under Node in a child process
 * with waku's `node` adapter, then replaces the listening serve entry with a
 * Fetch module (`dist/server/serve-azure.mjs`, `export default { fetch }`)
 * that calls `INTERNAL_runFetch`. `Azure.Functions.Function` bundles that
 * module into one file for a Flex Consumption app, so the build swaps Vocs'
 * runtime config loader (Vite + `vocs.config.*` on disk) for the bundled user
 * config. Front Door serves the client directory from Blob Storage; the
 * Function answers every page and RSC payload (see `waku/azure`).
 *
 * `alchemy dev` runs Vocs' own Vite dev server, like the Node module.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { finishAzureOutput, makeAzureTarget } from "../core/AzureServe.ts";
import { runBuildChild } from "../core/BuildChild.ts";
import type { BuildOutput } from "../core/BuildOutput.ts";
import { DeployTargetError } from "../core/DeployTarget.ts";
import { Framework } from "../core/Framework.ts";
import { removeStaticRscPayloads } from "../waku/azure.ts";
import {
  make as makeNode,
  makeNodeTarget,
  type VocsNodeFrameworkOptions,
  type VocsNodeTargetConfig,
} from "./node.ts";
import { vocsRuntimeConfigPlugin } from "./runtime-config.ts";
import type { VocsTarget } from "./Target.ts";
import { make as makeVocsLayer } from "./Vocs.ts";

export interface VocsAzureBuildChildConfig {
  readonly root: string;
}

/** Runs inside the build child: the Node adapter build, then the Azure Fetch entry. */
export const buildInChild = (config: VocsAzureBuildChildConfig) =>
  Effect.gen(function* () {
    const node = makeNodeTarget();
    const framework = yield* Framework.pipe(
      Effect.provide(
        makeVocsLayer({
          root: config.root,
          target: {
            ...node,
            build: undefined,
            vitePlugins: (context) =>
              node
                .vitePlugins(context)
                .pipe(Effect.map((plugins) => [...plugins, vocsRuntimeConfigPlugin("azure")])),
          },
        }),
      ),
    );
    return yield* framework
      .build({ root: config.root })
      .pipe(Effect.flatMap(finishAzureOutput), Effect.flatMap(removeStaticRscPayloads));
  });

/** Vocs production output served by an Azure Functions Fetch handler. */
export const target = (config?: VocsNodeTargetConfig): VocsTarget<VocsNodeTargetConfig> => ({
  ...makeAzureTarget(makeNodeTarget(config)),
  build: (context) =>
    runBuildChild({
      // Vocs' build exhausts memory under Bun.
      runtime: "node",
      module: import.meta.url,
      rootDir: context.root,
      config: { root: context.root } satisfies VocsAzureBuildChildConfig,
      framework: "vocs",
      env: context.env,
    }).pipe(
      Effect.mapError(
        (cause) => new DeployTargetError({ platform: "azure", message: cause.message, cause }),
      ),
    ),
});

export default target;

/**
 * Framework-module contract for `Azure.Website.Vocs` (`make(...)` returns
 * `{ build, dev }`): Vocs' own dev server, and the Azure Functions build.
 */
export const make = (options: VocsNodeFrameworkOptions = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const node = yield* makeNode(options);
    const build = target().build!;
    return {
      dev: node.dev,
      build: (buildOptions?: {
        readonly root?: string;
        readonly env?: Record<string, string> | undefined;
      }): Effect.Effect<BuildOutput, DeployTargetError> =>
        Effect.gen(function* () {
          const root = yield* Effect.sync(() =>
            path.resolve(buildOptions?.root ?? options.root ?? process.cwd()),
          );
          return yield* build({ root, framework: "vocs", env: buildOptions?.env });
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
    };
  });
