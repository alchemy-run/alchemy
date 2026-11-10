/**
 * `@alchemy.run/frontend-frameworks/octane/source` — alchemy Worker source provider for
 * OctaneJS projects, built on the shared `makeWorkerSource` skeleton.
 *
 * - `build()` runs the Octane Framework service in a child process (the
 *   project's own Vite plugins compile the client and server; Alchemy
 *   generates the `dist/server/worker.js` entry without requiring a hosting
 *   adapter): server modules → bundle, `dist/client` → assets.
 * - `hash()` recomputes the `input` hash without building.
 * - `dev()` starts Octane's own Vite dev server (SSR, server routes and RPC
 *   run in-process with full HMR) behind an HTTP forwarding Worker. NOTE:
 *   Octane's dev middleware supplies no request-scoped platform bindings
 *   (`context.platform` is `undefined` in dev — an upstream limitation), so
 *   Worker bindings are not observable from dev-mode app code yet.
 */
import * as Effect from "effect/Effect";
import {
  makeSourceModule,
  makeWorkerSource,
  type MemoOptions,
  type ServerDevHandle,
  type SourceProvider,
} from "../core/WorkerSource.ts";
import { makeCloudflareTarget } from "./cloudflare.ts";
import { make as makeOctane } from "./Octane.ts";

export {
  SourceProviderError,
  type AssetReadResult as SourceAssetReadResult,
  type BundleFile as SourceBundleFile,
  type BundleOutput as SourceBundleOutput,
  type DevContext as SourceDevContext,
  type ServerDevHandle as SourceDevHandle,
  type SourceBuildOutput,
  type SourceContext,
  type SourceError,
  type SourceHash,
  type SourceProvider,
} from "../core/WorkerSource.ts";

const PROVIDER = "@alchemy.run/frontend-frameworks/octane/source";

export type OctaneMemoOptions = MemoOptions;

/**
 * Descriptor options. JSON-serializable: they persist in alchemy state and
 * participate in the Worker's metadata hash.
 */
export interface OctaneSourceOptions {
  /**
   * Octane project root (the directory containing `vite.config.ts` and
   * `octane.config.ts`). Relative paths resolve from the process working
   * directory. @default process.cwd()
   */
  readonly rootDir?: string | undefined;
  /** Narrows the rebuild-detection input hash. */
  readonly memo?: OctaneMemoOptions | undefined;
}

/** JSON config the build child (`core/BuildChildRunner`) hands to {@link buildInChild}. */
export interface OctaneBuildChildConfig {
  readonly rootDir: string;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
}

export const buildInChild = (config: OctaneBuildChildConfig) =>
  Effect.gen(function* () {
    const framework = yield* makeOctane({
      root: config.rootDir,
      target: makeCloudflareTarget,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
    });
    return yield* framework.build({ root: config.rootDir });
  });

export const makeOctaneSource = (options: OctaneSourceOptions): SourceProvider =>
  makeWorkerSource({
    // Octane always emits `dist/client`; a build without it is broken.
    requireClient: true,
    provider: PROVIDER,
    framework: "octane",
    displayName: "Octane",
    rootDir: options.rootDir,
    memo: options.memo,
    // Octane's default `build.outDir`.
    outputDirs: ["dist"],
    buildConfig: (ctx, rootDir) =>
      ({
        rootDir,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
      }) satisfies OctaneBuildChildConfig,
    dev: (ctx, { rootDir, fail }) =>
      Effect.gen(function* () {
        // This module is Cloudflare-specific by contract, so it passes the
        // target factory directly instead of resolving it from the project.
        const framework = yield* makeOctane({
          root: rootDir,
          target: makeCloudflareTarget,
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
        });
        const server = yield* framework
          .dev({ root: rootDir, port: 0 })
          .pipe(Effect.mapError((error) => fail(error.message, error.cause ?? error)));
        return {
          mode: "server",
          url: new URL(server.url),
          serviceBinding: "http",
        } satisfies ServerDevHandle;
      }),
  });

/**
 * The `WorkerSourceModule` contract: alchemy dynamically imports this module
 * and calls `make(descriptor.options)`.
 */
export default makeSourceModule(PROVIDER, makeOctaneSource);
