import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { hashDirectory } from "../Command/Memo.ts";
import {
  CONTEXT_ROOT_DEST,
  EXTRA_FILES_HASH_EXCLUDE,
  isContextRootDest,
} from "../Server/externalProgram.ts";
import { initialCwd } from "./Node.ts";
import { sha256 } from "./sha256.ts";

const ioConcurrency = 16;

/**
 * Extra file or directory copied next to a bundled program (Docker
 * context, unit archive, …). `dest` is relative to the image/unit root.
 */
export interface ExtraFile {
  /** Local file or directory (absolute, or relative to {@link initialCwd}). */
  readonly source: string;
  /**
   * Destination relative to the image/unit root (e.g. `"dist"`, `".next"`).
   * `"."` means merge into the root.
   */
  readonly dest: string;
}

/** Normalize a COPY destination so it cannot escape the root. `"."` is the root. */
export const extraFileDestination = (destination: string): string => {
  const normalized = destination.replaceAll("\\", "/").replace(/^\/+/, "");
  if (isContextRootDest(normalized)) return CONTEXT_ROOT_DEST;
  const parts = normalized
    .split("/")
    .filter((part) => part.length > 0 && part !== "." && part !== "..");
  return parts.length === 0 ? "dist" : parts.join("/");
};

export const resolveExtraSource = (
  source: string,
  path: {
    readonly isAbsolute: (value: string) => boolean;
    readonly resolve: (...segments: string[]) => string;
  },
) => (path.isAbsolute(source) ? source : path.resolve(initialCwd, source));

const skipCopySegment = (segment: string) =>
  segment === ".git" || segment === ".alchemy";

export const hashExtraFiles = Effect.fn(function* (
  extraFiles: ReadonlyArray<ExtraFile> | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* Effect.all(
    (extraFiles ?? []).map((extra) =>
      Effect.gen(function* () {
        const dest = extraFileDestination(extra.dest);
        const source = resolveExtraSource(extra.source, path);
        const exists = yield* fs
          .exists(source)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) return [dest, ""] as const;
        const stat = yield* fs.stat(source);
        const hash =
          stat.type === "Directory"
            ? yield* hashDirectory({
                cwd: source,
                memo: {
                  exclude: EXTRA_FILES_HASH_EXCLUDE,
                  lockfile: false,
                },
              }).pipe(Effect.orElseSucceed(() => ""))
            : yield* sha256(yield* fs.readFile(source));
        return [dest, hash] as const;
      }),
    ),
    { concurrency: ioConcurrency },
  );
  return Object.fromEntries(entries) as Record<string, string>;
});

/**
 * Copy a file or directory without macOS `clonefile`. Nitro/Nuxt
 * `.output/server` trees (and their nested `node_modules`) fail
 * `fs.copy` with `EINVAL: invalid argument, clonefile`. Nested
 * `node_modules` are copied — nitro's node preset emits runtime
 * deps there (`solid-js`, `seroval`, …) and the host imports them.
 */
export const copyTree = Effect.fn(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fs
    .stat(from)
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (stat === undefined) return;
  if (stat.type !== "Directory") {
    if (stat.type !== "File") return;
    yield* fs.makeDirectory(path.dirname(to), { recursive: true });
    const contents = yield* fs.readFile(from);
    yield* fs.writeFile(to, contents);
    return;
  }
  yield* fs.makeDirectory(to, { recursive: true });
  const names = yield* fs.readDirectory(from, { recursive: true });
  yield* Effect.all(
    names.flatMap((name) => {
      if (name.split(/[\\/]/).some(skipCopySegment)) return [];
      return [
        Effect.gen(function* () {
          const src = path.join(from, name);
          const item = yield* fs
            .stat(src)
            .pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (item === undefined || item.type !== "File") return;
          const dst = path.join(to, name);
          yield* fs.makeDirectory(path.dirname(dst), { recursive: true });
          const contents = yield* fs.readFile(src);
          yield* fs.writeFile(dst, contents);
        }),
      ];
    }),
    { concurrency: ioConcurrency },
  );
});

export const copyExtraFiles = Effect.fn(function* (
  contextDir: string,
  extraFiles: ReadonlyArray<ExtraFile> | undefined,
  options?: {
    readonly onMissing?: (file: {
      readonly source: string;
      readonly dest: string;
    }) => Effect.Effect<unknown, any>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.all(
    (extraFiles ?? []).map((extra) =>
      Effect.gen(function* () {
        const source = resolveExtraSource(extra.source, path);
        const destName = extraFileDestination(extra.dest);
        const exists = yield* fs
          .exists(source)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) {
          if (options?.onMissing !== undefined) {
            yield* options.onMissing({ source, dest: destName });
          }
          return;
        }
        if (isContextRootDest(destName)) {
          const stat = yield* fs.stat(source);
          if (stat.type === "Directory") {
            const names = yield* fs.readDirectory(source);
            yield* Effect.all(
              names.map((name) =>
                copyTree(path.join(source, name), path.join(contextDir, name)),
              ),
              { concurrency: ioConcurrency },
            );
          } else {
            yield* copyTree(
              source,
              path.join(contextDir, path.basename(source)),
            );
          }
          return;
        }
        const dest = path.join(contextDir, destName);
        if (yield* fs.exists(dest).pipe(Effect.orElseSucceed(() => false))) {
          yield* fs.remove(dest, { recursive: true });
        }
        yield* fs.makeDirectory(path.dirname(dest), { recursive: true });
        yield* copyTree(source, dest);
      }),
    ),
    { concurrency: ioConcurrency },
  );
});
