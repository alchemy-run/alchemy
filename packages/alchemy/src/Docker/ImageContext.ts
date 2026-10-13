/**
 * Files a binding contributes to its host's image build context.
 *
 * An {@link ImageLayer} can carry {@link ImageContextSource}s: inline files
 * or a host directory. The host materializes them under the build context
 * before building, and the layer's instructions `COPY` them into place. Each
 * source reports a digest (content hash, directory hash) so the image is
 * rebuilt exactly when a mounted source changes.
 */
import * as Crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/** A file written into the build context. */
export interface ContentSource {
  readonly kind: "content";
  /** Path inside the build context. */
  readonly target: string;
  readonly content: string;
}

/** A directory on the deploying machine, copied into the build context. */
export interface DirectorySource {
  readonly kind: "directory";
  readonly target: string;
  /** Absolute path on the deploying machine. */
  readonly source: string;
}

export type ImageContextSource = ContentSource | DirectorySource;

export class ImageContextError extends Schema.TaggedError<ImageContextError>()(
  "ImageContextError",
  { message: Schema.String },
) {}

const sha256 = (value: string | Uint8Array) =>
  Crypto.createHash("sha256").update(value).digest("hex");

/** A stable, filesystem-safe directory name for a context target. */
export const contextTarget = (key: string) => `mounts/${sha256(key).slice(0, 16)}`;

/** What materializing produced: a digest for the image hash. */
export interface MaterializedContext {
  readonly digest: string;
}

/**
 * Materialize every source under `context` and return a digest over all of
 * them (fold it into the image hash).
 */
export const materializeImageContext = (options: {
  readonly context: string;
  readonly sources: ReadonlyArray<ImageContextSource>;
}): Effect.Effect<
  MaterializedContext,
  ImageContextError | PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const digests = yield* Effect.forEach(
      options.sources,
      (source) => Effect.map(materialize(options, source), (digest) => [source.target, digest]),
      { concurrency: 4 },
    );
    return {
      digest: sha256(
        JSON.stringify(digests.sort(([a], [b]) => String(a).localeCompare(String(b)))),
      ),
    };
  });

const materialize = (options: { readonly context: string }, source: ImageContextSource) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(options.context, source.target);
    // Digest the SOURCE first and rewrite the target only when it changed:
    // every plan materializes, and rewriting an unchanged mount would race
    // an image build reading the same context.
    const marker = `${target}.digest`;
    const replace = (
      digest: string,
      write: Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path>,
    ) =>
      // One writer per target: concurrent plans (diff, reconcile) would
      // otherwise delete the target while another copies into it.
      targetLock(target).withPermits(1)(
        Effect.gen(function* () {
          const current = yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""));
          if (digest === current && (yield* fs.exists(target))) return digest;
          yield* fs.remove(target, { recursive: true, force: true });
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* write;
          yield* fs.writeFileString(marker, digest);
          return digest;
        }),
      );
    switch (source.kind) {
      case "content":
        return yield* replace(sha256(source.content), fs.writeFileString(target, source.content));
      case "directory": {
        if (!(yield* fs.exists(source.source))) {
          return yield* new ImageContextError({
            message: `mounted folder ${source.source} does not exist`,
          });
        }
        return yield* replace(yield* hashTree(source.source), fs.copy(source.source, target));
      }
    }
  });

/** Deterministic hash over a directory tree (paths + contents). */
const hashTree = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entries = (yield* fs.readDirectory(root, { recursive: true })).sort();
    const hash = Crypto.createHash("sha256");
    for (const entry of entries) {
      const full = path.join(root, entry);
      const info = yield* fs.stat(full);
      if (info.type !== "File") continue;
      hash.update(entry);
      hash.update(yield* fs.readFile(full));
    }
    return hash.digest("hex");
  });

/** One lock per context target. */
const targetLocks = new Map<string, Semaphore.Semaphore>();
const targetLock = (target: string) => {
  let lock = targetLocks.get(target);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    targetLocks.set(target, lock);
  }
  return lock;
};
