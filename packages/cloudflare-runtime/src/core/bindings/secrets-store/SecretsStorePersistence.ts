// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import * as NodeFs from "node:fs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { SystemError } from "../../RuntimeError.shared.ts";

class InsecureDirectory extends Data.TaggedError("InsecureDirectory")<{
  readonly message: string;
}> {}

/**
 * Establish the Secrets Store boundary before workerd can write plaintext blobs
 * or SQLite databases with its default permissions.
 *
 * Ported from Miniflare's `plugins/secret-store/persistence.ts` (#16611).
 * Effect's `File` exposes no descriptor, so the open/`fchmod` step uses
 * `node:fs` directly, as upstream does.
 *
 * @param persistPath - Plugin persistence directory, created if missing.
 * @returns Its path with parent symlinks resolved for the disk service.
 */
export const ensureSecretsStoreDirectory = Effect.fn("ensureSecretsStoreDirectory")(function* (
  persistPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.gen(function* () {
    // Only restrict the plugin directory, not shared persistence parents. Resolve
    // configured parent aliases so the disk service uses the path we checked.
    yield* fs.makeDirectory(path.dirname(persistPath), { recursive: true });
    const parent = yield* fs.realPath(path.dirname(persistPath));
    const directoryPath = path.join(parent, path.basename(persistPath));
    yield* fs.makeDirectory(directoryPath, { mode: 0o700 }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
    );

    const isSymlink = yield* fs.readLink(directoryPath).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (isSymlink || (yield* fs.stat(directoryPath)).type !== "Directory") {
      return yield* new InsecureDirectory({
        message: "The Secrets Store directory must not be a symlink or file.",
      });
    }
    // Windows permissions are governed by inherited ACLs. chmod() cannot
    // establish an owner-only boundary there, and opening directories is unsupported.
    if ((yield* Effect.sync(() => process.platform)) === "win32") {
      return directoryPath.replaceAll("\\", "/");
    }

    // Check ownership of, and chmod, the inode we opened. `O_NOFOLLOW` rejects
    // a symlink substituted after the check above, and `fchmod` never follows
    // the path again.
    const syscall = <A>(run: () => A) =>
      Effect.try({
        try: run,
        catch: (cause) =>
          new InsecureDirectory({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = NodeFs.constants;
        const fd = yield* Effect.acquireRelease(
          syscall(() => NodeFs.openSync(directoryPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)),
          (fd) => Effect.sync(() => NodeFs.closeSync(fd)),
        );
        const stats = yield* syscall(() => NodeFs.fstatSync(fd));
        const uid = yield* Effect.sync(() => process.geteuid?.());
        if (!stats.isDirectory() || uid === undefined || stats.uid !== uid) {
          return yield* new InsecureDirectory({
            message: "The Secrets Store directory must be owned by the current user.",
          });
        }
        if ((stats.mode & 0o7777) !== 0o700) {
          yield* syscall(() => NodeFs.fchmodSync(fd, 0o700));
        }
        const secured = yield* syscall(() => NodeFs.fstatSync(fd));
        const current = yield* syscall(() => NodeFs.lstatSync(directoryPath));
        if (
          (secured.mode & 0o7777) !== 0o700 ||
          !current.isDirectory() ||
          current.dev !== secured.dev ||
          current.ino !== secured.ino
        ) {
          return yield* new InsecureDirectory({
            message: "The Secrets Store directory could not be secured or was replaced.",
          });
        }
      }),
    );
    return directoryPath;
  }).pipe(
    Effect.mapError((cause) =>
      SystemError.make({
        subtag: "SecretsStore",
        message: `Unable to secure Secrets Store persistence directory at ${persistPath}: ${cause.message}`,
        hint: "Ensure the directory is a real directory owned by the current user.",
        detail: { persistPath },
        cause,
      }),
    ),
  );
});
