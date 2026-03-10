import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";

/**
 * Creates a deterministic bundle staging directory under the nearest
 * package-local `.alchemy/tmp` root so resolution matches the entry's package.
 */
export const createTempBundleDir = (
  entry: string,
  dotAlchemy: string,
  id: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stack = yield* Stack;
    const stage = yield* Stage;
    const tempRoot = yield* findBundleTempRoot(entry, dotAlchemy);
    const bundleId = `${stack.name}-${stage}-${id}`;
    const tempDir = path.join(tempRoot, bundleId);

    yield* fs.makeDirectory(tempRoot, { recursive: true });
    yield* fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore);
    yield* fs.makeDirectory(tempDir, { recursive: true });

    return tempDir;
  });

/**
 * Cleans up a bundle's private temp directory.
 */
export const cleanupBundleTempDir = (tempDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore);
  });

const findBundleTempRoot = (entry: string, dotAlchemy: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    let current = path.dirname(entry);
    while (true) {
      // `node_modules` acts as the package/workspace anchor for temp bundles.
      if (yield* fs.exists(path.join(current, "node_modules"))) {
        return path.join(current, path.basename(dotAlchemy), "tmp");
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    return path.join(path.dirname(entry), path.basename(dotAlchemy), "tmp");
  });
