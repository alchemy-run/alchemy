import type { CloudflareVitePluginOptions } from "@alchemy.run/cloudflare-runtime/vite";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import nodePath from "node:path";
import {
  resolveViteEnv,
  viteBuildInProcess as buildInProcess,
  viteDev,
} from "@alchemy.run/cloudflare-runtime/vite/build";
export { viteDev } from "@alchemy.run/cloudflare-runtime/vite/build";
import {
  adaptViteBuildOutput,
  type ViteBuildOutput,
} from "../../../Bundle/Vite.ts";
import { makeResourceLogger } from "../../../Util/ResourceOutput.ts";
import { hashViteInput as hashSourceInput } from "@alchemy.run/node-utils/memo";
import { dotAlchemyDirectory } from "../../../AlchemyContext.ts";
import { initialCwd } from "../../../Util/Node.ts";
import { type AssetsConfig, readAssets } from "../Assets.ts";
import type {
  SourceDevHandle,
  SourceError,
  SourceProvider,
  SourceServices,
} from "../Source.ts";
import { runViteBuildChild } from "../ViteChild.ts";
import { type ViteOptions } from "../Worker.ts";
export const viteBuildInProcess = (
  ...args: Parameters<typeof buildInProcess>
) => buildInProcess(...args).pipe(Effect.map(adaptViteBuildOutput));

/**
 * This module statically imports `@alchemy.run/cloudflare-runtime/vite`
 * (~0.5s to load), which is only needed for vite-based workers. Importers
 * MUST load it lazily (`Effect.promise(() => import("./Sources/Vite.ts"))`
 * from the dispatch in `Source.ts`, or the legacy vite arms in the
 * Worker providers) so the module cost is only paid when a vite worker
 * is actually built, hashed, or served.
 */

/**
 * Run a production Vite build in a child process rooted at the project
 * directory and adapt the result to the in-process {@link ViteBuildOutput}
 * shape.
 *
 * The child boundary is what makes concurrent builds safe: vite resolves a
 * relative root against live `process.cwd()`, plugins read cwd freely, and
 * build-time spawns chdir the hosting process transiently (cross-spawn's
 * PATH resolution) — so an in-process build both breaks under and causes
 * cwd races when the engine runs builds concurrently.
 */
export const viteBuild = (
  rootDir: string = initialCwd,
  env: Record<string, unknown>,
  pluginOptions: CloudflareVitePluginOptions,
  fqn: string,
) =>
  Effect.gen(function* () {
    const logResourceOutput = makeResourceLogger(fqn);
    const result = yield* runViteBuildChild(
      {
        // Anchor to the initial cwd so the resolution itself can't race a
        // transient chdir; the child's own cwd is this resolved root.
        rootDir: nodePath.resolve(initialCwd, rootDir),
        // Only `VITE_`-prefixed entries participate in the build (see
        // `getDefine`); the rest may hold non-serializable values.
        env: Object.fromEntries(
          Object.entries(env).filter(([key]) => key.startsWith("VITE_")),
        ),
        main: pluginOptions.main,
        compatibilityDate: pluginOptions.compatibilityDate,
        compatibilityFlags: pluginOptions.compatibilityFlags,
        viteEnvironments: pluginOptions.viteEnvironments,
      },
      logResourceOutput,
    );
    return {
      clientDirectory: result.clientDirectory,
      serverDirectory: result.serverDirectory,
      base: result.base,
      serverBundle: Effect.succeed(result.serverBundle),
      externalWorkspaces: Effect.succeed(new Set(result.externalWorkspaces)),
    } satisfies ViteBuildOutput;
  });

/** Workspace-aware hash using the stack's runtime-directory exclusion. */
export const hashViteInput = <E, R>(
  rootDir: string = initialCwd,
  options: ViteOptions["memo"],
  additionalWorkspaces: Effect.Effect<Iterable<string>, E, R>,
) =>
  Effect.gen(function* () {
    const runtimeDirectory = yield* dotAlchemyDirectory;
    return yield* hashSourceInput(
      nodePath.resolve(initialCwd, rootDir),
      options,
      additionalWorkspaces,
      runtimeDirectory,
    );
  });

/**
 * Source provider for vite-based workers (`props.vite`, set by
 * `Website.Vite`): the vite builder produces the client assets and the
 * server bundle in one pass; diff never builds — the `input` hash over
 * the project tree is the change signal.
 *
 * This module is the lazy-import boundary for the vite toolchain (see
 * the module note above): the dispatch in `Source.ts` dynamically
 * imports it, so its ~0.5s module cost is only paid for vite-based
 * workers.
 */
export const makeViteSource = (
  vite: ViteOptions,
  // Source integrations can supply defaults from the completed build before
  // assets are read and hashed. User-declared asset settings always win.
  assetDefaults?: (
    build: Pick<ViteBuildOutput, "clientDirectory" | "serverDirectory">,
  ) => Effect.Effect<AssetsConfig | undefined, SourceError, SourceServices>,
): SourceProvider => ({
  ownsAssets: true,
  build: Effect.fn(function* (ctx) {
    const path = yield* Path.Path;
    const env = yield* resolveViteEnv(ctx.env ?? {}, ctx.selfUrl);
    const {
      clientDirectory,
      serverDirectory,
      base,
      serverBundle,
      externalWorkspaces,
    } = yield* viteBuild(
      vite.rootDir,
      env,
      {
        // A relative `vite.main` is documented to resolve from the Vite
        // root. The rolldown plugin resolves the worker entry with no
        // importer (i.e. against `process.cwd()`), which breaks when the
        // deploy runs from a different directory (e.g. a monorepo infra
        // package) — absolutize before handing it over (#796).
        main: vite.main
          ? path.resolve(initialCwd, vite.rootDir ?? ".", vite.main)
          : undefined,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        viteEnvironments: vite.viteEnvironments,
      },
      ctx.fqn,
    );
    const declaredAssets =
      ctx.assets && typeof ctx.assets !== "string" ? ctx.assets : undefined;
    // What the build itself says about its assets, filled in under what
    // the resource declared: a framework that records which pages it
    // prerendered knows the routing better than a default would, and the
    // resource's own `assets` still has the last word.
    const derivedAssets =
      clientDirectory && assetDefaults
        ? yield* assetDefaults({
            clientDirectory,
            serverDirectory,
          })
        : undefined;
    const [assets, bundle, input] = yield* Effect.all(
      [
        clientDirectory
          ? readAssets({
              ...derivedAssets,
              ...declaredAssets,
              // `clientDirectory` from the build child is absolute; the
              // rootDir only matters as a legacy fallback.
              directory: path.resolve(
                initialCwd,
                vite.rootDir ?? ".",
                clientDirectory,
              ),
              // The resolved Vite `base` is what rewrote the URLs in the
              // emitted HTML, so it is the only prefix the manifest can
              // agree with.
              base,
            })
          : Effect.undefined,
        serverBundle,
        hashViteInput(vite.rootDir, vite.memo, externalWorkspaces),
      ],
      { concurrency: "unbounded" },
    );
    if (!assets && !bundle) {
      return yield* Effect.die(
        new Error("Vite build produced neither assets nor server output"),
      );
    }
    return {
      bundle,
      assets,
      hash: {
        bundle: bundle?.hash,
        assets: assets?.hash,
        input: input.hash,
        additionalWorkspaces: input.workspaces,
      },
    };
  }),
  hash: Effect.fn(function* (_ctx, previous) {
    const { hash, workspaces } = yield* hashViteInput(
      vite.rootDir,
      vite.memo,
      Effect.succeed(previous?.additionalWorkspaces ?? []),
    );
    return { input: hash, additionalWorkspaces: workspaces };
  }),
  dev: Effect.fn(function* (ctx) {
    const devServer = yield* viteDev(
      vite.rootDir,
      ctx.env ?? {},
      {
        main: vite.main,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        viteEnvironments: vite.viteEnvironments,
        worker: {
          name: ctx.workerName,
          bindings: ctx.worker.bindings,
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
      mode: "server",
      url: new URL(devServer.resolvedUrls!.local[0]),
    } satisfies SourceDevHandle;
  }),
});
