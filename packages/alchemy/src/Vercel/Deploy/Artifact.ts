/**
 * Internal deploy-engine artifact model (DESIGN §6.1).
 *
 * A {@link DeploymentArtifact} is an immutable description of one Vercel
 * deployment: the full `.vercel/output` (Build Output v3) file tree, each
 * file content-addressed by its SHA1 (Vercel's content address for the
 * upload API), plus a deterministic artifact hash used as THE diff key.
 *
 * NOT exported from `Vercel/index.ts` — this is a library shared by the
 * `Function` (and later `Website`) providers, the same status as the
 * bundling internals.
 */
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import { sha256Object } from "../../Util/sha256.ts";

/** Source of an {@link ArtifactFile}'s bytes. */
export type ArtifactFileSource =
  | { readonly _tag: "Bytes"; readonly bytes: Uint8Array }
  | { readonly _tag: "File"; readonly absPath: string };

export interface ArtifactFile {
  /**
   * POSIX path as sent to `createDeployment` — INCLUDES the
   * `.vercel/output/` prefix for prebuilt deploys.
   */
  readonly path: string;
  /** SHA1 hex of the file contents — Vercel's content address. */
  readonly sha1: string;
  /** File size in bytes. */
  readonly size: number;
  /** Optional file mode (symlink / executable bits). */
  readonly mode?: number;
  readonly source: ArtifactFileSource;
}

/**
 * Minimal `projectSettings` patch attached to a first deploy. Prebuilt
 * deploys need none of the framework autodetection settings.
 */
export interface ProjectSettingsPatch {
  readonly framework?: string | null;
}

export interface DeploymentArtifact {
  readonly kind: "prebuilt" | "sources";
  readonly files: ReadonlyArray<ArtifactFile>;
  /**
   * sha256 over the sorted `(path, sha1, mode)` tuples — THE diff key for
   * skip-on-hash and crash-recovery deployment lookup.
   */
  readonly hash: string;
  readonly projectSettings?: ProjectSettingsPatch;
}

/** SHA1 hex digest (Vercel's upload content address). */
export const sha1Hex = (bytes: Uint8Array): Effect.Effect<string> =>
  Effect.sync(() => createHash("sha1").update(bytes).digest("hex"));

/** Build an in-memory {@link ArtifactFile} from raw bytes. */
export const artifactFileFromBytes = (
  path: string,
  bytes: Uint8Array,
  mode?: number,
): Effect.Effect<ArtifactFile> =>
  Effect.map(sha1Hex(bytes), (sha1) => ({
    path,
    sha1,
    size: bytes.byteLength,
    ...(mode !== undefined ? { mode } : {}),
    source: { _tag: "Bytes", bytes },
  }));

/** Build a disk-backed {@link ArtifactFile} (bytes read lazily at upload). */
export const artifactFileFromDisk = (
  path: string,
  absPath: string,
): Effect.Effect<ArtifactFile, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs.readFile(absPath);
    const sha1 = yield* sha1Hex(bytes);
    return {
      path,
      sha1,
      size: bytes.byteLength,
      source: { _tag: "File", absPath },
    } satisfies ArtifactFile;
  });

/** Read an {@link ArtifactFile}'s bytes (upload path). */
export const readArtifactFile = (
  file: ArtifactFile,
): Effect.Effect<Uint8Array, PlatformError, FileSystem.FileSystem> =>
  file.source._tag === "Bytes"
    ? Effect.succeed(file.source.bytes)
    : Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.readFile(file.source._tag === "File" ? file.source.absPath : ""),
      );

/**
 * Deterministic artifact hash: sha256 over the sorted `(path, sha1, mode)`
 * tuples. Content-only — independent of source kind (bytes vs disk).
 */
export const artifactHash = (
  files: ReadonlyArray<ArtifactFile>,
): Effect.Effect<string> =>
  sha256Object(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => [f.path, f.sha1, f.mode ?? null]),
  );

/** Assemble a {@link DeploymentArtifact} from its files. */
export const makeArtifact = (
  kind: DeploymentArtifact["kind"],
  files: ReadonlyArray<ArtifactFile>,
  projectSettings?: ProjectSettingsPatch,
): Effect.Effect<DeploymentArtifact> =>
  Effect.map(artifactHash(files), (hash) => ({
    kind,
    files,
    hash,
    ...(projectSettings !== undefined ? { projectSettings } : {}),
  }));
