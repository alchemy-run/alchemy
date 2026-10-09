import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

export interface CopyTreeOptions {
  /** Skip an entry (and, for a directory, everything under it). */
  readonly exclude?: (relativePath: string, name: string) => boolean;
  /**
   * Hard-link a file instead of copying it — for content nothing will edit
   * in place (installed dependencies), where it saves the copy entirely.
   */
  readonly link?: (relativePath: string) => boolean;
}

/**
 * Copy a directory tree with Effect's `FileSystem`. Symlinks are recreated
 * verbatim (relative links keep pointing inside the copy — pnpm's
 * `node_modules` depends on that), files are copied or hard-linked, and
 * directories recurse in parallel.
 */
export const copyTree = (
  from: string,
  to: string,
  options: CopyTreeOptions = {},
): Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const walk = (relative: string): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        const source = path.join(from, relative);
        const target = path.join(to, relative);
        yield* fs.makeDirectory(target, { recursive: true });
        const names = yield* fs.readDirectory(source);
        yield* Effect.forEach(
          names,
          (name) =>
            Effect.gen(function* () {
              const entry = relative ? `${relative}/${name}` : name;
              if (options.exclude?.(entry, name)) return;
              const src = path.join(source, name);
              const dst = path.join(target, name);
              // `stat` follows links; `readLink` succeeds only for a link.
              const link = yield* fs.readLink(src).pipe(Effect.option);
              if (Option.isSome(link)) {
                yield* fs.remove(dst, { force: true });
                return yield* fs.symlink(link.value, dst);
              }
              const info = yield* fs.stat(src);
              if (info.type === "Directory") return yield* walk(entry);
              yield* fs.remove(dst, { force: true });
              yield* options.link?.(entry) ? fs.link(src, dst) : fs.copyFile(src, dst);
            }),
          { concurrency: 16, discard: true },
        );
      });
    yield* walk("");
  });
