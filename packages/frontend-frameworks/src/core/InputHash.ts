import {
  combineIgnoreRules,
  listFileSystemDirectory,
  parseIgnoreRules,
  walkIgnoring,
  type IgnoreRules,
} from "@alchemy.run/node-utils/ignore-rules";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import { serialize } from "ohash";
import { glob } from "tinyglobby";

/**
 * Input-hash scoping, mirroring alchemy's `MemoOptions` (`Command/Memo.ts`):
 * by default every non-gitignored file under the root is hashed plus the
 * nearest package-manager lockfile; explicit `include` / `exclude` globs
 * narrow the scope.
 */
export interface MemoOptions {
  /** Glob patterns of files to hash, relative to the root. @default all files */
  readonly include?: Array<string> | undefined;
  /** Glob patterns to exclude. @default gitignore rules from the root up to the repo root */
  readonly exclude?: Array<string> | undefined;
  /**
   * Whether to include the nearest package-manager lockfile in the hash.
   * @default true when both `include` and `exclude` are unset; false otherwise
   */
  readonly lockfile?: boolean | undefined;
}

/** Lowercase hex sha256 of `input`. */
export const sha256 = (input: string | Uint8Array): Effect.Effect<string> =>
  Digest.Digest.use((digest) =>
    digest.digestHex(
      Digest.sha256,
      typeof input === "string" ? new TextEncoder().encode(input) : input,
    ),
  ).pipe(Effect.provide(Digest.layerWebCrypto));

/** sha256 of `value` serialized with `ohash`, so key order never changes the hash. */
export const sha256Object = (value: unknown): Effect.Effect<string> => sha256(serialize(value));

/** This package's version, salted into every input hash so an upgrade busts build memos. */
export const packageVersion: Effect.Effect<string> = Effect.promise(
  () => import("../../package.json", { with: { type: "json" } }),
).pipe(Effect.map((pkg) => pkg.default.version));

const LOCKFILE_NAMES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

const isNotFound = (error: PlatformError) => error.reason._tag === "NotFound";

/** The nearest of `filenames`, walking up from `startDir`. */
export const findUp = Effect.fn(function* (startDir: string, filenames: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let dir = startDir;
  for (;;) {
    for (const filename of filenames) {
      const candidate = path.join(dir, filename);
      if (yield* fs.exists(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
});

/**
 * Each `.gitignore` from `rootDir` up to the repository root, anchored to its
 * own directory, as alchemy's `Command/Memo.ts` reads them.
 */
const readGitIgnoreScopes = Effect.fn(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scopes: Array<IgnoreRules> = [];
  let dir = rootDir;
  for (;;) {
    const content = yield* fs
      .readFileString(path.join(dir, ".gitignore"))
      .pipe(Effect.catchIf(isNotFound, () => Effect.undefined));
    if (content !== undefined) {
      scopes.unshift(
        parseIgnoreRules(content, "gitignore", {
          prefix: path.relative(dir, rootDir).replaceAll("\\", "/"),
        }),
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir || (yield* fs.exists(path.join(dir, ".git")))) break;
    dir = parent;
  }
  return scopes;
});

/**
 * Files under `rootDir` to hash, as sorted posix paths. Explicit `exclude`
 * globs replace the gitignore rules; otherwise the tree is walked with them,
 * never reading an excluded directory. `alwaysExclude` (gitignore syntax)
 * applies either way.
 */
const listInputFiles = Effect.fn(function* (
  rootDir: string,
  memo: MemoOptions | undefined,
  alwaysExclude: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const always = parseIgnoreRules(alwaysExclude, "gitignore");
  if (memo?.exclude !== undefined || memo?.include !== undefined) {
    const files = yield* Effect.promise(() =>
      glob(memo.include ?? ["**/*"], {
        cwd: rootDir,
        ignore: memo.exclude ?? [],
        onlyFiles: true,
        expandDirectories: false,
        dot: true,
      }),
    );
    const gitignore =
      memo.exclude === undefined
        ? combineIgnoreRules("gitignore", yield* readGitIgnoreScopes(rootDir))
        : undefined;
    return files.filter((file) => !always.ignores(file) && !(gitignore?.ignores(file) ?? false));
  }
  const entries = yield* walkIgnoring({
    list: yield* listFileSystemDirectory(rootDir),
    rules: combineIgnoreRules("gitignore", [always, ...(yield* readGitIgnoreScopes(rootDir))]),
  });
  // Like tinyglobby, keep symlinks that resolve to files.
  const files = yield* Effect.filter(
    entries.filter((entry) => entry.type !== "Directory"),
    (entry) =>
      entry.type === "File"
        ? Effect.succeed(true)
        : fs.stat(path.join(rootDir, entry.path)).pipe(
            Effect.map((info) => info.type === "File"),
            Effect.orElseSucceed(() => false),
          ),
  );
  return files.map((entry) => entry.path);
});

/** Content hash of one tree: sorted `relativePosixPath:sha256` pairs, never absolute paths. */
const hashDirectory = Effect.fn(function* (
  rootDir: string,
  memo: MemoOptions | undefined,
  /** Always excluded (gitignore syntax), whatever `memo` says. */
  alwaysExclude: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* listInputFiles(rootDir, memo, alwaysExclude);
  if (memo?.lockfile ?? !(memo?.include || memo?.exclude)) {
    const lockfile = yield* findUp(rootDir, LOCKFILE_NAMES);
    if (lockfile !== undefined) {
      const relative = path.relative(rootDir, lockfile).replaceAll("\\", "/");
      if (!files.includes(relative)) files.push(relative);
    }
  }
  const hashes = yield* Effect.forEach(
    files.sort(),
    (file) =>
      fs.readFile(path.join(rootDir, file)).pipe(
        Effect.flatMap(sha256),
        Effect.map((hash) => `${file}:${hash}`),
      ),
    { concurrency: 16 },
  );
  return yield* sha256Object(hashes);
});

/**
 * The `input` hash slot: the project tree, the workspaces it imports, the
 * lockfile, this package's version, and the integration's build-affecting
 * options. Deterministic for an unchanged tree and stable across `rootDir`
 * moves.
 */
export const hashInput = Effect.fn(function* (params: {
  readonly rootDir: string;
  /** Build output directories relative to the root, never hashed. */
  readonly outputDirs: ReadonlyArray<string>;
  readonly memo: MemoOptions | undefined;
  /** Workspace directories, absolute or relative to the root. */
  readonly workspaces: Iterable<string>;
  /** The integration's build-affecting options. */
  readonly options: unknown;
}) {
  const path = yield* Path.Path;
  // Dependency trees, VCS metadata, alchemy's state and the framework's own
  // build output (hashing it would make every build bust its memo).
  const alwaysExclude = [
    "node_modules/",
    ".git/",
    "/.alchemy/",
    ...params.outputDirs.map((dir) => `/${dir.replace(/^\.?\//, "").replace(/\/+$/, "")}/`),
  ];
  const workspaces = Array.from(params.workspaces, (workspace) =>
    path.resolve(params.rootDir, workspace),
  );
  const [root, ...workspaceHashes] = yield* Effect.all(
    [
      hashDirectory(params.rootDir, params.memo, alwaysExclude),
      ...workspaces.map((workspace) =>
        Effect.map(
          hashDirectory(workspace, undefined, alwaysExclude),
          (hash) => `${path.relative(params.rootDir, workspace).replaceAll("\\", "/")}:${hash}`,
        ),
      ),
    ],
    { concurrency: 4 },
  );
  return {
    hash: yield* sha256Object({
      version: yield* packageVersion,
      options: params.options,
      root,
      workspaces: workspaceHashes.sort(),
    }),
    workspaces: workspaces.map((workspace) =>
      path.relative(params.rootDir, workspace).replaceAll("\\", "/"),
    ),
  };
});
