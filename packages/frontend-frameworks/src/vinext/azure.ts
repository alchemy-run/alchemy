import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type { Plugin } from "vite";
import { AZURE_SERVE_ENTRY_FILE_NAME, makeAzureServeEntrySource } from "../core/AzureServe.ts";
import { runBuildChild } from "../core/BuildChild.ts";
/**
 * `@alchemy.run/frontend-frameworks/vinext/azure` — vinext on Azure
 * Functions (`Azure.Website.Vinext`).
 *
 * The build is vinext's Vite build in Node (no Cloudflare Vite plugin),
 * then a Fetch entry that `Azure.Functions.Function` bundles into one ESM
 * file. Front Door serves `dist/client` from Blob Storage; every other
 * path reaches the entry.
 *
 * - **`build`** runs vinext's Vite build in a disposable child, then writes
 *   `dist/server/serve-azure.mjs` (`export default { fetch(request) }`)
 *   around the App Router RSC entry (`dist/server/index.js`).
 * - **`dev`** runs the real `vinext dev` CLI (plain Node), scoped.
 *
 * A Function package ships no `node_modules`, so the SSR environment
 * bundles React instead of leaving it external: the React Server Components
 * client `require`s `react-dom` at run time, which a second bundling pass
 * cannot see. The RSC environment already bundles its `react-server` copy.
 *
 * App Router only — Pages Router has no single fetch handler to wrap.
 * The data cache is vinext's Redis adapter: in-process memory unless the
 * Function has `REDIS_URL`.
 */
import * as FrameworkCore from "../core/index.ts";
import { DeployTargetError, makeDeployTarget, type DeployTarget } from "../core/index.ts";
import { NODE_BUNDLE_CONDITIONS } from "../core/NodeServe.ts";
import {
  awaitVinextDevReady,
  collectVinextDist,
  failFramework,
  pickEphemeralPort,
  pinServeModule,
  resolveVinextCli,
  runVinextBuild,
  spawnVinextDev,
  VINEXT_APP_FETCH_HANDLER_SOURCE,
  VINEXT_RSC_ENTRY,
} from "./cli.ts";

const failTarget = (message: string, cause?: unknown) =>
  new DeployTargetError({ platform: "azure", message, cause });

/** Options for the vinext Azure framework module / deploy target. */
export interface VinextAzureOptions {
  readonly root?: string | undefined;
  /**
   * The deploy target module specifier the caller resolved this module as.
   * This module IS the Azure target — accepted and ignored.
   */
  readonly target?: string | undefined;
}

export interface VinextAzureTargetConfig {
  readonly root?: string | undefined;
}

export interface VinextAzureTarget extends DeployTarget<VinextAzureTargetConfig> {}

/** The Fetch entry the finishing pass writes into `dist/server`. */
export const SERVE_ENTRY_NAME = `server/${AZURE_SERVE_ENTRY_FILE_NAME}`;

/** React packages the SSR environment externalizes by default. */
const REACT_EXTERNAL = /^react(-dom)?(\/|$)/;

/**
 * Bundle React into vinext's server environments. vinext leaves `react`
 * and `react-dom` external for a Node server with `node_modules`; an Azure
 * Function package has none.
 */
export const bundleReactPlugin = (): Plugin => ({
  name: "alchemy:vinext-azure-bundle-react",
  apply: "build",
  enforce: "post",
  configEnvironment(name, config) {
    if (name !== "ssr" && name !== "rsc") return;
    const external = config.resolve?.external;
    if (config.resolve !== undefined && Array.isArray(external)) {
      // `resolve.external` merges by concatenation, so filter it in place.
      config.resolve.external = external.filter((entry) => !REACT_EXTERNAL.test(entry));
    }
  },
});

/** The generated Fetch entry around vinext's App Router handler. */
export const makeAzureEntrySource = (): string =>
  makeAzureServeEntrySource({
    handler: { kind: "fetch", imports: VINEXT_APP_FETCH_HANDLER_SOURCE, expr: "fetchHandler" },
  });

export interface VinextAzureBuildChildConfig {
  readonly rootDir: string;
  readonly config: VinextAzureTargetConfig;
}

export const buildInChild = (config: VinextAzureBuildChildConfig) =>
  Effect.gen(function* () {
    const root = config.rootDir;
    yield* runVinextBuild({ root, cache: "redis", plugins: [bundleReactPlugin()] });
    const dist = yield* collectVinextDist(root);
    if (!dist.hasRsc) {
      return yield* failFramework(
        `The vinext Azure target requires an App Router build (${VINEXT_RSC_ENTRY}). Pages Router has no single fetch handler to run on Azure Functions.`,
      )(undefined);
    }
    return yield* pinServeModule(dist, SERVE_ENTRY_NAME, makeAzureEntrySource());
  });

const makeAzureChildTarget = (config: VinextAzureTargetConfig = {}): VinextAzureTarget =>
  makeDeployTarget({
    platform: "azure",
    config,
    bundle: {
      conditions: [...NODE_BUNDLE_CONDITIONS],
    },
  });

/**
 * Create the Azure Functions {@link VinextAzureTarget}. See the module doc.
 */
export const makeAzureTarget = (config: VinextAzureTargetConfig = {}): VinextAzureTarget => ({
  ...makeAzureChildTarget(config),
  build: (context) =>
    runBuildChild({
      runtime: "node",
      module: import.meta.url,
      rootDir: context.root,
      env: context.env,
      framework: "vinext",
      config: {
        rootDir: context.root,
        config,
      } satisfies VinextAzureBuildChildConfig,
    }).pipe(Effect.mapError((error) => failTarget(error.message, error.cause))),
});

export const target = makeAzureTarget;

export default makeAzureTarget;

export interface VinextAzureService {
  readonly build: (options?: FrameworkCore.FrameworkBuildOptions) => Effect.Effect<
    {
      readonly distDirectory: string;
      readonly clientDirectory: string | undefined;
      readonly serverModules: Array<{ readonly name: string }>;
    },
    FrameworkCore.FrameworkError
  >;
  readonly dev: (
    options?: FrameworkCore.FrameworkDevOptions,
  ) => Effect.Effect<FrameworkCore.FrameworkDevServer, FrameworkCore.FrameworkError, Scope.Scope>;
}

/**
 * Build the vinext-on-Azure framework service. See the module doc for the
 * `build`/`dev` semantics.
 */
export const make: (
  options?: VinextAzureOptions,
) => Effect.Effect<VinextAzureService, never, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (options?: VinextAzureOptions) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolveRoot = (override: string | undefined) =>
      Effect.sync(() => path.resolve(override ?? options?.root ?? process.cwd()));

    const build: VinextAzureService["build"] = Effect.fn(function* (
      buildOptions?: FrameworkCore.FrameworkBuildOptions,
    ) {
      const root = yield* resolveRoot(buildOptions?.root);
      const output = yield* makeAzureTarget({ root }).build!({
        root,
        framework: "vinext",
        env: buildOptions?.env,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError((error) => failFramework(error.message)(error.cause)),
      );
      return {
        distDirectory: output.distDirectory ?? path.join(root, "dist"),
        clientDirectory: output.clientDirectory,
        serverModules: (output.serverModules ?? []).map((module_) => ({
          name: module_.name,
        })),
      };
    });

    const dev: VinextAzureService["dev"] = Effect.fn(function* (
      devOptions?: FrameworkCore.FrameworkDevOptions,
    ) {
      const root = yield* resolveRoot(devOptions?.root);
      const port = devOptions?.port ?? (yield* pickEphemeralPort);
      const cli = yield* resolveVinextCli(root);
      const host = devOptions?.host ?? "127.0.0.1";
      const child = yield* spawnVinextDev({ root, cli, port, host });
      const url = `http://${host}:${port}`;
      yield* awaitVinextDevReady({ url, child });
      return { url };
    });

    return { build, dev };
  });
