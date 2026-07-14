import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Path from "effect/Path";
import crypto from "node:crypto";
import type { Plugin } from "vite";
import { BuildCache, BuildCacheLive } from "./BuildCache.ts";

const merge = <K, V>(
  maps: Array<ReadonlyMap<K, V>>,
): ReadonlyMap<K, V> => {
  if (maps.length === 0) return new Map();
  if (maps.length === 1) return maps[0];
  const merged = new Map<K, V>();
  for (const map of maps) {
    for (const [key, value] of map.entries()) {
      merged.set(key, value);
    }
  }
  return merged;
};

export const combineHashes = (hashes: Array<ReadonlyMap<string, string>>) => {
  const merged = merge(hashes);
  const paths = Array.from(merged.keys()).sort();
  const hash = crypto.createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update(merged.get(path)!);
    hash.update("\0");
  }
  return hash.digest("hex");
};

/**
 * Walk up from `dir` looking for the nearest `package.json`, using the Effect
 * `FileSystem`/`Path` services instead of `node:fs`/`node:path`.
 */
const findUpPackageJson = (
  dir: string,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filepath = path.join(dir, "package.json");
    const found = yield* fs.stat(filepath).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.orElseSucceed(() => false),
    );
    if (found) {
      return filepath;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    return yield* findUpPackageJson(parent);
  });

// The Node platform services (FileSystem, Path, ...) satisfy BuildCache's
// requirements. Build the runtime once and reuse it across every hook call.
const runtimeLayer = Layer.provideMerge(BuildCacheLive, NodeServices.layer);

export function hashPlugin(): Plugin {
  const runtime = ManagedRuntime.make(runtimeLayer);
  let pathSvc: Path.Path;
  let root = process.cwd();
  const workspaces = new Set<string>([root]);
  const promises: Array<Promise<void>> = [];
  const seen = new Set<string>();
  const envs = new Map<string, boolean>();

  const isDone = () => Array.from(envs.values()).every((done) => done);

  const hashWorkspaces = (dirs: Array<string>) =>
    runtime.runPromise(
      Effect.flatMap(BuildCache, (buildCache) =>
        Effect.forEach(dirs, (dir) => buildCache.hashDirectory(dir), {
          concurrency: "unbounded",
        }),
      ),
    );

  const done = async () => {
    await Promise.all(promises);
    const hashes = await hashWorkspaces(Array.from(workspaces));
    const hash = combineHashes(hashes);
    return {
      hash,
      workspaces: Array.from(workspaces).map((workspace) =>
        pathSvc.relative(root, workspace),
      ),
    };
  };

  const redo = async (workspaceDirs: Array<string>) => {
    const hashes = await hashWorkspaces(
      workspaceDirs.map((dir) => pathSvc.resolve(root, dir)),
    );
    return combineHashes(hashes);
  };

  return {
    name: "hash",
    async configResolved(config) {
      pathSvc = await runtime.runPromise(Path.Path);
      root = pathSvc.resolve(config.root);
      for (const env of Object.keys(config.environments)) {
        envs.set(env, false);
      }
    },
    async writeBundle() {
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        if (info) {
          if (seen.has(info.id)) {
            continue;
          }
          seen.add(info.id);
          if (
            !info.code ||
            info.id.includes("node_modules") ||
            !pathSvc.isAbsolute(info.id) ||
            info.id.startsWith(root)
          ) {
            continue;
          }
          promises.push(
            runtime.runPromise(
              findUpPackageJson(pathSvc.dirname(info.id)).pipe(
                Effect.map((pkgPath) => {
                  if (pkgPath) {
                    workspaces.add(pathSvc.dirname(pkgPath));
                  }
                }),
              ),
            ),
          );
        }
      }
      envs.set(this.environment.name, true);
      if (isDone()) {
        const t0 = performance.now();
        const { hash, workspaces } = await done();
        const t1 = performance.now();
        const redoHash = await redo(workspaces);
        const t2 = performance.now();
        console.log(
          `BENCH ${JSON.stringify({
            impl: "effect",
            doneMs: +(t1 - t0).toFixed(2),
            redoMs: +(t2 - t1).toFixed(2),
            totalMs: +(t2 - t0).toFixed(2),
            hash,
            redoHash,
            workspaces,
          })}`,
        );
      }
    },
  };
}
