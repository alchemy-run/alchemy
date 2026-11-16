import { initialCwd } from "alchemy/Util/Node";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { ArtifactFile } from "./ArtifactFile.ts";

/** Pattern of an archive named by its SHA-256, as {@link storeArtifact} names it. */
const CONTENT_NAMED_ARCHIVE = /^[a-f0-9]{64}\.tar\.gz$/;

/**
 * Whether `artifactPath` is named by its own SHA-256, so the name alone
 * says which bytes it holds.
 */
export const isContentNamedArchive = Effect.fn(function* (artifactPath: string) {
  const path = yield* Path.Path;
  return CONTENT_NAMED_ARCHIVE.test(path.basename(artifactPath));
});

/** A path stored relative to the initial working directory, made absolute. */
export const resolveStoredPath = Effect.fn(function* (stored: string) {
  const path = yield* Path.Path;
  return path.resolve(initialCwd, stored);
});

/**
 * Keep an artifact in `directory`, named by its SHA-256, so it outlives the
 * reconcile that built it, and remove the artifacts it replaces. Returns the
 * path relative to the initial working directory, so state written on one
 * machine or checkout names the same archive on another.
 */
export const storeArtifact = Effect.fn(function* (
  directory: string,
  archive: Pick<ArtifactFile, "path" | "sha256">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.resolve(initialCwd, directory);
  yield* fs.makeDirectory(absolute, { recursive: true });
  const artifactPath = path.join(absolute, `${archive.sha256}.tar.gz`);
  yield* fs.copyFile(archive.path, artifactPath);
  for (const old of yield* fs.readDirectory(absolute)) {
    if (old !== path.basename(artifactPath) && CONTENT_NAMED_ARCHIVE.test(old)) {
      yield* fs.remove(path.join(absolute, old), { force: true });
    }
  }
  return path.relative(initialCwd, artifactPath);
});
