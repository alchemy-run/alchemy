/**
 * `@alchemy.run/frontend-frameworks/vinext/source` — alchemy Worker
 * source provider for vinext, on the shared `makeWorkerSource` base.
 *
 * `build()` runs Vite's `createBuilder` in a child process with
 * `@alchemy.run/cloudflare-runtime/vite` injected (the
 * `vite-plugin-cloudflare:alchemy` presence plugin), then vinext prerender
 * and a platform-agnostic cache seed (`putText` into KV HTTP).
 * `hash()` is a project-tree memo. `dev()` is Vite's own server with
 * the same plugin stack.
 */
import { createRequire } from "node:module";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import cloudflare from "@alchemy.run/cloudflare-runtime/vite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { toOutputFile, type BuildOutput } from "../core/BuildOutput.ts";
import { WORKER_ENTRY_PREFIX } from "../core/Collector.ts";
import { resolveViteDevPort } from "../core/DevPort.ts";
import {
  makeSourceModule,
  makeWorkerSource,
  type SourceModuleContext,
  SourceProviderError,
  type MemoOptions,
  type ServerDevHandle,
  type SourceError,
  type SourceProvider,
} from "../core/WorkerSource.ts";
import { kvHttpNamespaceFromEnv, kvHttpSink } from "./cache/kv-http.ts";
import { makeVinextCachePlugin } from "./cache/plugin.ts";
import { seedPrerenderTo } from "./cache/seed.ts";
import {
  ALCHEMY_CLOUDFLARE_VITE_INJECTED,
  DEFAULT_WORKER_ENTRY,
  makeVinextPluginOptions,
} from "./cloudflare.ts";
import { runVinextPrerenderIfConfigured } from "./Prerender.ts";
import { VINEXT_CACHE_BINDING, VINEXT_KV_CACHE_BINDING } from "./PrerenderCache.ts";

export {
  SourceProviderError,
  type AssetReadResult,
  type BundleFile,
  type BundleOutput,
  type DevContext,
  type ServerDevHandle,
  type SourceBuildOutput,
  type SourceContext,
  type SourceHash,
  type SourceProvider,
  type SourceRequirements,
} from "../core/WorkerSource.ts";

const PROVIDER = "@alchemy.run/frontend-frameworks/vinext/source";

const VINEXT_SERVER_ENTRIES = ["dist/server/index.js", "dist/server/ssr/index.js"] as const;

const RSC_MANIFEST = {
  "virtual:vite-rsc/assets-manifest": "__vite_rsc_assets_manifest.js",
  "virtual:vite-rsc/environment-imports": "__vite_rsc_env_imports_manifest.js",
} as const;

export type VinextSourceError = SourceError;

export type VinextMemoOptions = MemoOptions;

export interface VinextSourceOptions {
  readonly main?: string | undefined;
  readonly memo?: VinextMemoOptions | undefined;
  readonly viteEnvironments?: {
    readonly entry?: string;
    readonly children?: ReadonlyArray<string>;
  };
}

export interface VinextBuildChildConfig {
  readonly rootDir: string;
  readonly main: string | undefined;
  readonly compatibilityDate: string;
  readonly compatibilityFlags: Array<string>;
  readonly viteEnvironments: { entry?: string; children?: ReadonlyArray<string> } | undefined;
}

const isBindingMarker = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "~alchemy/Kind" in value;

/** Nearest directory at or above `startDir` holding a `package.json`. */
const findPackageDir = Effect.fn(function* (startDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = startDir;
  for (;;) {
    if (yield* fs.exists(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
});

// ─────────────────────────────────────────────────────────────────────
// Vite createBuilder + output collection
// ─────────────────────────────────────────────────────────────────────

type ViteModule = typeof import("vite");

const loadVite = async (projectRoot: string): Promise<ViteModule> => {
  try {
    const require = createRequire(nodePath.join(projectRoot, "package.json"));
    return await import(/* @vite-ignore */ pathToFileURL(require.resolve("vite")).href);
  } catch {
    return await import("vite");
  }
};

const getDefine = (env: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, raw]) => {
      if (!key.startsWith("VITE_")) return [];
      const value = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
      return [[`import.meta.env.${key}`, JSON.stringify(value)] as const];
    }),
  );

const relativeJsImports = (code: string): readonly string[] => {
  const specs = new Set<string>();
  for (const match of code.matchAll(/(?:from|import)\s*["'](\.\.?\/[^"']+\.js)["']/g)) {
    specs.add(match[1]!);
  }
  return [...specs];
};

interface EnvironmentLike {
  readonly name: string;
  readonly config: {
    readonly base: string;
    readonly root: string;
    readonly build: { readonly outDir: string };
  };
}

const makeOutputCollector = (entryEnvironment: string) => {
  let clientDirectory: string | undefined;
  let serverEntry: string | undefined;
  const serverChunks = new Map<string, { content: string | Uint8Array }>();
  const maybeExternalWorkspaces = new Set<string>();

  const fileName = (name: string, environment: EnvironmentLike) => {
    const outDir = environment.config.build.outDir;
    const relativeOutDir = nodePath.isAbsolute(outDir)
      ? nodePath.relative(environment.config.root, outDir)
      : outDir;
    return `${relativeOutDir.replaceAll("\\", "/")}/${name}`;
  };

  const plugin = {
    name: "alchemy:vinext-build-output",
    sharedDuringBuild: true,
    async writeBundle(
      this: {
        environment: EnvironmentLike;
        getModuleIds: () => Iterable<string>;
      },
      _opts: unknown,
      bundle: Record<
        string,
        {
          type: string;
          fileName: string;
          isEntry?: boolean;
          facadeModuleId?: string | null;
          code?: string;
          source?: string | Uint8Array;
          imports?: Array<string>;
        }
      >,
    ) {
      const root = nodePath.resolve(this.environment.config.root);
      for (const id of this.getModuleIds()) {
        if (!nodePath.isAbsolute(id) || id.includes("node_modules") || id.startsWith(root)) {
          continue;
        }
        maybeExternalWorkspaces.add(nodePath.dirname(id));
      }
      if (this.environment.name === "client") {
        clientDirectory = nodePath.resolve(root, this.environment.config.build.outDir);
        return;
      }
      const files = Object.values(bundle);
      if (this.environment.name === entryEnvironment) {
        // Vinext's rsc environment can emit its own app entry alongside the
        // wrapped Worker main; only the latter is a valid Worker module.
        const entryChunk =
          files.find(
            (file) =>
              file.type === "chunk" &&
              file.isEntry &&
              file.facadeModuleId?.startsWith(WORKER_ENTRY_PREFIX),
          ) ?? files.find((file) => file.type === "chunk" && file.isEntry);
        if (entryChunk) {
          serverEntry = fileName(entryChunk.fileName, this.environment);
        }
      }
      for (const file of files) {
        if (file.type === "chunk") {
          for (const spec of file.imports ?? []) {
            if (spec in RSC_MANIFEST) {
              const manifest = RSC_MANIFEST[spec as keyof typeof RSC_MANIFEST];
              serverChunks.set(fileName(manifest, this.environment), {
                content: "",
              });
            }
          }
        }
        // Vite's build metadata (`.vite/manifest.json`), not a Worker module.
        if (file.fileName.startsWith(".vite/")) continue;
        const name = fileName(file.fileName, this.environment);
        const content = file.type === "chunk" ? (file.code ?? "") : (file.source ?? "");
        serverChunks.set(name, { content });
      }
    },
  };

  return {
    plugin,
    snapshot: () => ({
      clientDirectory,
      serverEntry,
      serverChunks,
      externalWorkspaces: maybeExternalWorkspaces,
    }),
  };
};

const readRscManifestsFromDisk = Effect.fn(function* (
  root: string,
  chunks: Map<string, { content: string | Uint8Array }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [name, chunk] of chunks) {
    if (chunk.content !== "") continue;
    const filePath = path.join(root, name);
    if (yield* fs.exists(filePath)) {
      chunks.set(name, { content: yield* fs.readFile(filePath) });
    } else {
      chunks.delete(name);
    }
  }
});

/**
 * Vinext rewrites server chunks and writes sidecar modules (the action-owner
 * manifest, `vinext-client-assets.js`) after `writeBundle`, so re-read every
 * captured JS chunk from disk and follow its relative imports to pick up
 * modules that were never part of a bundle.
 */
const syncVinextServerModules = Effect.fn(function* (
  root: string,
  chunks: Map<string, { content: string | Uint8Array }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pending: string[] = [
    ...VINEXT_SERVER_ENTRIES,
    ...[...chunks.keys()].filter((name) => /\.[mc]?js$/.test(name)),
  ];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const bundlePath = pending.pop()!;
    if (seen.has(bundlePath)) continue;
    seen.add(bundlePath);
    const filePath = path.join(root, bundlePath);
    if (!(yield* fs.exists(filePath))) continue;
    const content = yield* fs.readFileString(filePath);
    chunks.set(bundlePath, { content });
    const dir = nodePath.posix.dirname(bundlePath);
    for (const spec of relativeJsImports(content)) {
      const next = nodePath.posix.normalize(nodePath.posix.join(dir, spec));
      if (!next.startsWith("dist/server/") || chunks.has(next)) continue;
      pending.push(next);
    }
  }
});

const collectExternalWorkspaces = Effect.fn(function* (dirs: Iterable<string>) {
  const found = yield* Effect.forEach(dirs, findPackageDir, { concurrency: "unbounded" });
  return new Set(found.filter((dir): dir is string => dir !== undefined));
});

/**
 * Child-process vinext production build. `runBuildChild` sets cwd to the
 * project root before importing this module.
 */
export const buildInChild = (config: VinextBuildChildConfig) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = path.resolve(config.rootDir);
    // oxlint-disable-next-line effecttsgo/process-env-in-effect -- flags the vite plugin injection via process.env, not config reading
    process.env[ALCHEMY_CLOUDFLARE_VITE_INJECTED] = "1";
    const cachePlugin = yield* makeVinextCachePlugin(root, "kv");
    const pluginOptions = makeVinextPluginOptions({
      root,
      main: config.main,
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      viteEnvironments: config.viteEnvironments,
    });
    const collector = makeOutputCollector(pluginOptions.viteEnvironments?.entry ?? "rsc");
    const vite = yield* Effect.promise(() => loadVite(root));
    yield* Effect.promise(async () => {
      const builder = await vite.createBuilder(
        {
          root,
          plugins: [cachePlugin, cloudflare(pluginOptions), collector.plugin as never],
          logLevel: "warn",
        },
        null,
      );
      await builder.buildApp();
    });
    yield* runVinextPrerenderIfConfigured(root);
    const snap = collector.snapshot();
    yield* readRscManifestsFromDisk(root, snap.serverChunks);
    yield* syncVinextServerModules(root, snap.serverChunks);
    if (snap.serverChunks.size === 0) {
      return {
        distDirectory: path.join(root, "dist"),
        clientDirectory: snap.clientDirectory,
        serverModules: undefined,
        externalWorkspaces: yield* collectExternalWorkspaces(snap.externalWorkspaces),
      } satisfies BuildOutput;
    }
    const names = Array.from(snap.serverChunks.keys()).sort((a, b) => {
      if (a === snap.serverEntry) return -1;
      if (b === snap.serverEntry) return 1;
      return a.localeCompare(b);
    });
    const serverModules = yield* Effect.forEach(names, (name) => {
      const chunk = snap.serverChunks.get(name)!;
      return toOutputFile(name, chunk.content);
    });
    return {
      distDirectory: path.join(root, "dist"),
      clientDirectory: snap.clientDirectory,
      serverModules,
      externalWorkspaces: yield* collectExternalWorkspaces(snap.externalWorkspaces),
    } satisfies BuildOutput;
  });

const resolveVinextCacheEnv = (env: Record<string, unknown>) =>
  Effect.gen(function* () {
    const resolved = { ...env };
    for (const key of [VINEXT_KV_CACHE_BINDING, VINEXT_CACHE_BINDING]) {
      const value = env[key];
      if (value == null || isBindingMarker(value)) continue;
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- cache bindings are pre-resolved resource Effects
      resolved[key] = Effect.isEffect(value) ? yield* value as Effect.Effect<unknown> : value;
    }
    return resolved;
  });

/**
 * Same `seedPrerenderTo(sink.putText)` as Redis / S3. The Worker provider
 * layer supplies the distilled KV HTTP client. Closed as `Effect<void>`
 * so the source contract stays `SourceRequirements`.
 */
const seedVinextPrerenderCache = (
  rootDir: string,
  env: Record<string, unknown>,
): Effect.Effect<void> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- closed so the source contract stays SourceRequirements, see JSDoc
  Effect.gen(function* () {
    const namespace = kvHttpNamespaceFromEnv(env);
    if (namespace === undefined) return;
    const path = yield* Path.Path;
    yield* seedPrerenderTo(kvHttpSink(namespace), {
      rootDir: path.resolve(rootDir),
      label: "Cloudflare KV",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SourceProviderError({
            provider: PROVIDER,
            message: "Failed to seed the vinext prerender cache.",
            cause,
          }),
      ),
    );
  }) as Effect.Effect<void>;

export const makeVinextSourceProvider = (
  options: VinextSourceOptions,
  { rootDir }: SourceModuleContext,
): SourceProvider => {
  const source = makeWorkerSource({
    provider: PROVIDER,
    framework: "vinext",
    displayName: "vinext",
    runtime: "node",
    rootDir,
    memo: options.memo,
    outputDirs: ["dist"],
    hashOptions: { main: options.main, viteEnvironments: options.viteEnvironments },
    buildConfig: (ctx, rootDir) =>
      ({
        rootDir,
        main: options.main,
        compatibilityDate: ctx.compatibility.date,
        compatibilityFlags: ctx.compatibility.flags,
        viteEnvironments: options.viteEnvironments,
      }) satisfies VinextBuildChildConfig,
    // Dev runs the Worker in workerd with the Vite plugin's assets service.
    devAssetsBinding: true,
    dev: (ctx, { rootDir }) =>
      Effect.gen(function* () {
        // oxlint-disable-next-line effecttsgo/process-env-in-effect -- flags the vite plugin injection via process.env, not config reading
        process.env[ALCHEMY_CLOUDFLARE_VITE_INJECTED] = "1";
        const cachePlugin = yield* makeVinextCachePlugin(rootDir, "kv").pipe(
          Effect.mapError(
            (cause) =>
              new SourceProviderError({
                provider: PROVIDER,
                message: "Failed to load the vinext cache adapters",
                cause: cause,
              }),
          ),
        );
        const vite = yield* Effect.promise(() => loadVite(rootDir));
        const port = yield* resolveViteDevPort(vite.version).pipe(
          Effect.mapError(
            (cause) =>
              new SourceProviderError({
                provider: PROVIDER,
                message: "Failed to allocate a vinext dev port",
                cause: cause,
              }),
          ),
        );
        const pluginOptions = makeVinextPluginOptions({
          root: rootDir,
          main: options.main ?? DEFAULT_WORKER_ENTRY,
          compatibilityDate: ctx.compatibility.date,
          compatibilityFlags: ctx.compatibility.flags,
          viteEnvironments: options.viteEnvironments,
          worker: {
            ...ctx.worker.options,
            name: ctx.workerName,
            bindings: ctx.worker.bindings,
            durableObjectNamespaces: ctx.worker.durableObjectNamespaces,
            hyperdrives: ctx.worker.hyperdrives,
            queueConsumers: yield* ctx.worker.queueConsumers,
            assets: ctx.worker.assets,
          },
          entrypoints: ctx.worker.entrypoints,
          context: ctx.runtimeContext,
        });
        const server = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const devServer = await vite.createServer({
              root: rootDir,
              define: getDefine(ctx.env ?? {}),
              plugins: [cachePlugin, cloudflare(pluginOptions)],
              server: { port, strictPort: false },
            });
            await devServer.listen();
            return devServer;
          }),
          (devServer) => Effect.promise(() => devServer.close()),
        );
        const local = server.resolvedUrls?.local[0];
        if (!local)
          return yield* new SourceProviderError({
            provider: PROVIDER,
            message: "vinext dev server started without a local URL",
          });
        return { mode: "server", url: new URL(local) } satisfies ServerDevHandle;
      }),
  });

  return {
    ...source,
    // After the shared build: seed vinext's prerender cache from the build output.
    build: Effect.fn(function* (ctx) {
      const output = yield* source.build(ctx);
      yield* seedVinextPrerenderCache(rootDir, yield* resolveVinextCacheEnv(ctx.env ?? {}));
      return output;
    }),
  };
};

export default makeSourceModule(PROVIDER, makeVinextSourceProvider);
