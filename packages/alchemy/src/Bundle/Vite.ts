import type { NonEmptyArray } from "effect/Array";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as vite from "vite";
import { sha256, sha256Promise } from "../Util/index.ts";
import {
  BundleError,
  bundleErrorFromUnknown,
  bundleOutputFromFiles,
  type BundleFile,
  type BundleOutput,
} from "./Bundle.ts";

export interface ViteBuildOutput {
  readonly assets: string | undefined;
  readonly server: BundleOutput | undefined;
}

const RSC_MANIFEST = {
  "virtual:vite-rsc/assets-manifest": "__vite_rsc_assets_manifest.js",
  "virtual:vite-rsc/environment-imports": "__vite_rsc_env_imports_manifest.js",
} as const;

type ChunkMap = Map<string, Effect.Effect<BundleFile, BundleError>>;

export const makeViteOutputPlugin = Effect.fn(function* (input: {
  readonly viteEnvironments?: {
    readonly entry?: string;
    readonly children?: string[];
  };
  readonly deferred: Deferred.Deferred<ViteBuildOutput, BundleError>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const fileName = (name: string, environment: vite.Environment) =>
    `${environment.name}/${name}`;

  const makeRscManifestChunk = (
    name: string,
    environment: vite.Environment,
  ) => {
    return fs
      .readFile(
        path.resolve(
          environment.config.root,
          environment.config.build.outDir,
          name,
        ),
      )
      .pipe(
        Effect.flatMap((content) =>
          sha256(content).pipe(
            Effect.map((hash) => ({
              path: fileName(name, environment),
              content,
              hash,
            })),
          ),
        ),
        Effect.mapError(bundleErrorFromUnknown),
      );
  };

  let assets: string | undefined;
  let entry: string | undefined;
  const chunks: ChunkMap = new Map();
  const getChunk = (path: string) => {
    const chunk = chunks.get(path);
    if (!chunk) {
      return Effect.die(
        new Cause.NoSuchElementError(`Chunk ${path} not found`),
      );
    }
    return chunk;
  };

  const buildResult = Effect.gen(function* () {
    if (!entry) {
      return { assets, server: undefined };
    }
    const keys = Array.from(chunks.keys()).sort((a, b) => a.localeCompare(b));
    const server: NonEmptyArray<Effect.Effect<BundleFile, BundleError>> = [
      getChunk(entry),
    ];
    for (const key of keys) {
      if (key === entry) continue;
      server.push(getChunk(key));
    }
    return {
      assets,
      server: yield* Effect.all(server, { concurrency: "unbounded" }).pipe(
        Effect.flatMap(bundleOutputFromFiles),
      ),
    };
  });

  return {
    name: "alchemy:build-output",
    sharedDuringBuild: true,
    async writeBundle(_, bundle) {
      if (this.environment.name === "client") {
        assets = path.resolve(
          this.environment.config.root,
          this.environment.config.build.outDir,
        );
        return;
      }
      const isEntryEnvironment =
        this.environment.name === (input.viteEnvironments?.entry ?? "ssr");
      const files = Object.values(bundle);
      if (isEntryEnvironment) {
        if (files[0].type === "chunk" && files[0].isEntry) {
          entry = fileName(files[0].fileName, this.environment);
        } else {
          throw new Error(
            `Entry chunk not found for environment "${this.environment.name}"`,
          );
        }
      }
      await Promise.all(
        files.map(async (file) => {
          if (file.type === "chunk") {
            file.imports
              .filter(
                (self): self is keyof typeof RSC_MANIFEST =>
                  self in RSC_MANIFEST,
              )
              .forEach((id) => {
                const name = fileName(RSC_MANIFEST[id], this.environment);
                if (!chunks.has(name)) {
                  chunks.set(
                    name,
                    makeRscManifestChunk(RSC_MANIFEST[id], this.environment),
                  );
                }
              });
          }
          const name = fileName(file.fileName, this.environment);
          const content = file.type === "chunk" ? file.code : file.source;
          const hash = await sha256Promise(content);
          chunks.set(name, Effect.succeed({ path: name, content, hash }));
        }),
      );
    },
    buildApp: {
      order: "post",
      async handler() {
        Deferred.doneUnsafe(input.deferred, buildResult);
      },
    },
  } satisfies vite.Plugin;
});
