import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ArtifactFile } from "./ArtifactFile.ts";

/**
 * Keep an artifact in `directory`, named by its SHA-256, so it outlives the
 * reconcile that built it, and remove the artifacts it replaces.
 */
export const storeArtifact = Effect.fn(function* (
  directory: string,
  archive: Pick<ArtifactFile, "path" | "sha256">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(directory, { recursive: true });
  const artifactPath = path.join(directory, `${archive.sha256}.tar.gz`);
  yield* fs.copyFile(archive.path, artifactPath);
  for (const old of yield* fs.readDirectory(directory)) {
    if (old !== path.basename(artifactPath) && /^[a-f0-9]{64}\.tar\.gz$/.test(old)) {
      yield* fs.remove(path.join(directory, old), { force: true });
    }
  }
  return artifactPath;
});
