import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";

/**
 * Write `contents` to `filePath` via a same-directory temp file + rename.
 *
 * A plain `writeFileString` truncates the target before writing, so a crash
 * mid-write (or a concurrent reader — another CLI process, the RPC sidecar)
 * can observe empty/partial JSON. rename(2) is atomic on the same
 * filesystem, so readers see either the old contents or the new, never a
 * torn write. When `mode` is given the temp file is created with it (and
 * chmod-ed to it, past the umask) *before* the rename, so a secret is never
 * readable with default permissions at either path. The temp file is
 * removed on failure.
 *
 * Used for `~/.alchemy/profiles.json`, the per-provider credential files,
 * and local state files.
 */
export const writeFileAtomic = (
  fs: FileSystem.FileSystem,
  filePath: string,
  contents: string,
  mode?: number,
): Effect.Effect<void, PlatformError> =>
  Effect.suspend(() => {
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    return fs.writeFileString(tmp, contents, mode === undefined ? undefined : { mode }).pipe(
      Effect.flatMap(() => (mode === undefined ? Effect.void : fs.chmod(tmp, mode))),
      Effect.flatMap(() => fs.rename(tmp, filePath)),
      Effect.tapError(() => fs.remove(tmp).pipe(Effect.ignore)),
    );
  });
