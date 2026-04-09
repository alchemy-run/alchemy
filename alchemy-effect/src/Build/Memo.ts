import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import fg from "fast-glob";
import { gitignoreRulesToGlobs } from "../Util/gitignore-rules-to-globs.ts";
import { sha256, sha256Object } from "../Util/sha256.ts";

export interface MemoOptions {
  /**
   * Glob patterns to match input files for hashing.
   * When the hash of matched files changes, the build will re-run.
   * Defaults to all files in the working directory, except those matched by exclude.
   * @example ["src/*.ts", "src/*.tsx", "package.json"]
   */
  include?: string[];
  /**
   * Glob patterns to exclude from input hashing.
   * Defaults to using your .gitignore rules.
   */
  exclude?: string[];
  /**
   * Whether to include the package manager lockfile in the hash.
   * Defaults to false if include or exclude is provided.
   */
  lockfile?: boolean;
}

interface ResolvedMemoOptions {
  cwd: string;
  include: string[];
  exclude: string[];
  lockfile: boolean;
}

const Memo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const findUp = Effect.fnUntraced(function* (
    cwd: string,
    filenames: string[],
  ): Effect.fn.Return<string | undefined, PlatformError> {
    const [file] = yield* Effect.filter(
      filenames.map((filename) => path.join(cwd, filename)),
      fs.exists,
      { concurrency: "unbounded" },
    );
    if (file) {
      return file;
    }
    const parent = path.dirname(cwd);
    if (parent === cwd) {
      return undefined;
    }
    return yield* findUp(parent, filenames);
  });

  const readGitIgnoreRules = Effect.fnUntraced(function* (
    cwd: string,
  ): Effect.fn.Return<string[], PlatformError> {
    const rules = yield* fs.readFileString(path.join(cwd, ".gitignore")).pipe(
      Effect.map((file) => file.split("\n")),
      Effect.catchIf(
        (error) =>
          error._tag === "PlatformError" && error.reason._tag === "NotFound",
        () => Effect.succeed([]),
      ),
    );
    const parent = path.dirname(cwd);
    if (parent === cwd || (yield* fs.exists(path.join(cwd, ".git")))) {
      return rules;
    }
    return [...(yield* readGitIgnoreRules(parent)), ...rules];
  });

  const resolveMemoOptions = Effect.fnUntraced(function* (
    cwd: string | undefined,
    options: MemoOptions,
  ): Effect.fn.Return<ResolvedMemoOptions, PlatformError> {
    const resolvedCwd = cwd ? path.resolve(cwd) : process.cwd();
    return {
      cwd: resolvedCwd,
      include: options.include ?? ["**/*"],
      exclude:
        options.exclude ??
        (yield* readGitIgnoreRules(resolvedCwd).pipe(
          Effect.map(gitignoreRulesToGlobs),
          Effect.map((globs) => ["**/.git/**", ...globs]),
        )),
      lockfile: options.lockfile ?? !(options.exclude || options.include),
    };
  });

  const listFiles = Effect.fnUntraced(function* (
    options: ResolvedMemoOptions,
  ): Effect.fn.Return<string[], PlatformError> {
    const [files, lockfile] = yield* Effect.all(
      [
        Effect.promise(() =>
          fg.glob(options.include, {
            cwd: options.cwd,
            ignore: options.exclude,
            onlyFiles: true,
            dot: true,
          }),
        ),
        options.lockfile
          ? findUp(options.cwd, [
              "bun.lock",
              "bun.lockb",
              "package-lock.json",
              "pnpm-lock.yaml",
              "yarn.lock",
            ])
          : Effect.succeed(undefined),
      ],
      { concurrency: "unbounded" },
    );
    if (lockfile) {
      files.push(path.relative(options.cwd, lockfile));
    }
    return files.sort();
  });

  const hashFiles = Effect.fnUntraced(function* (
    cwd: string,
    files: string[],
  ): Effect.fn.Return<string, PlatformError> {
    const hashes = yield* Effect.forEach(
      files,
      (file) =>
        fs.readFile(path.join(cwd, file)).pipe(
          Effect.flatMap(sha256),
          Effect.map((hash) => `${file}:${hash}`),
        ),
      { concurrency: "unbounded" },
    );
    return yield* sha256Object(hashes);
  });

  return {
    resolveMemoOptions,
    listFiles,
    hashFiles,
  };
});

export const hashDirectory = Effect.fn(function* (
  cwd: string | undefined,
  options?: MemoOptions,
): Effect.fn.Return<string, PlatformError, FileSystem.FileSystem | Path.Path> {
  const service = yield* Memo;
  const resolvedOptions = yield* service.resolveMemoOptions(cwd, options ?? {});
  const files = yield* service.listFiles(resolvedOptions);
  const hash = yield* service.hashFiles(resolvedOptions.cwd, files);
  return hash;
});
