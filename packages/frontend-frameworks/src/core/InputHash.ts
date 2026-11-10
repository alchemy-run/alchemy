import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
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

export const sha256 = (input: string | Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(input).digest("hex");

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
};

/** sha256 over sorted-key JSON, so key order never changes the hash. */
export const sha256Object = (value: unknown): string => sha256(JSON.stringify(stableValue(value)));

/**
 * Gitignore rules as glob `ignore` patterns, the common cases only. A copy of
 * alchemy's `Util/gitignore-rules-to-globs.ts`; negated (`!`) rules are
 * skipped.
 */
export const gitignoreRulesToGlobs = (rules: ReadonlyArray<string>): Array<string> =>
  rules.flatMap((raw) => {
    let rule = raw.trim().replaceAll("\\", "/");
    if (rule.length === 0 || rule.startsWith("#") || rule.startsWith("!")) return [];
    const dirOnly = rule.endsWith("/");
    if (dirOnly) rule = rule.slice(0, -1);
    const anchored = rule.startsWith("/");
    if (anchored) rule = rule.slice(1);
    if (rule.length === 0) return [];
    if (anchored || rule.includes("/")) return dirOnly ? [`${rule}/**`] : [rule, `${rule}/**`];
    return dirOnly ? [`**/${rule}/**`] : [`**/${rule}`, `**/${rule}/**`];
  });

/** Every file under `cwd` matched by `include` and not by `ignore`, as sorted posix paths. */
export const listFiles = (
  cwd: string,
  options: { readonly include?: ReadonlyArray<string>; readonly ignore: ReadonlyArray<string> },
) =>
  Effect.promise(() =>
    glob([...(options.include ?? ["**/*"])], {
      cwd,
      ignore: [...options.ignore],
      onlyFiles: true,
      expandDirectories: false,
      dot: true,
    }),
  ).pipe(Effect.map((files) => files.sort()));

const LOCKFILE_NAMES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

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

/** `.gitignore` rules from `rootDir` up to the repo root (the first directory with `.git`), outermost first. */
const readGitIgnoreRules = Effect.fn(function* (rootDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const chain: Array<Array<string>> = [];
  let dir = rootDir;
  for (;;) {
    const gitignore = path.join(dir, ".gitignore");
    if (yield* fs.exists(gitignore))
      chain.unshift((yield* fs.readFileString(gitignore)).split("\n"));
    if (yield* fs.exists(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain.flat();
});

/** Content hash of one tree: sorted `relativePosixPath:sha256` pairs, never absolute paths. */
const hashDirectory = Effect.fn(function* (
  rootDir: string,
  memo: MemoOptions | undefined,
  /** Always excluded, whatever `memo` says. */
  alwaysExclude: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exclude = memo?.exclude ?? gitignoreRulesToGlobs(yield* readGitIgnoreRules(rootDir));
  const files: Array<string> = yield* listFiles(rootDir, {
    include: memo?.include,
    ignore: [...alwaysExclude, ...exclude],
  });
  if (memo?.lockfile ?? !(memo?.include || memo?.exclude)) {
    const lockfile = yield* findUp(rootDir, LOCKFILE_NAMES);
    if (lockfile !== undefined) {
      const relative = path.relative(rootDir, lockfile).replaceAll("\\", "/");
      if (!files.includes(relative)) files.push(relative);
    }
  }
  const hashes = yield* Effect.forEach(
    files.sort(),
    (file): Effect.Effect<string, PlatformError> =>
      Effect.map(fs.readFile(path.join(rootDir, file)), (content) => `${file}:${sha256(content)}`),
    { concurrency: 16 },
  );
  return sha256Object(hashes);
});

/**
 * The `input` hash slot: the project tree, the workspaces it imports, the
 * lockfile, the integration's version, and its build-affecting options.
 * Deterministic for an unchanged tree and stable across `rootDir` moves.
 */
export const hashInput = Effect.fn(function* (params: {
  readonly rootDir: string;
  /** Build output directories relative to the root, never hashed. */
  readonly outputDirs: ReadonlyArray<string>;
  readonly memo: MemoOptions | undefined;
  /** Workspace directories, absolute or relative to the root. */
  readonly workspaces: Iterable<string>;
  /** The integration's package version and build-affecting options. */
  readonly salt: unknown;
}) {
  const path = yield* Path.Path;
  // Dependency trees, VCS metadata, alchemy's state and the framework's own
  // build output (hashing it would make every build bust its memo).
  const alwaysExclude = [
    "**/node_modules/**",
    "**/.git/**",
    ".alchemy/**",
    ...params.outputDirs.map((dir) => `${dir.replace(/^\.?\//, "").replace(/\/+$/, "")}/**`),
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
    hash: sha256Object({ salt: params.salt, root, workspaces: workspaceHashes.sort() }),
    workspaces: workspaces.map((workspace) =>
      path.relative(params.rootDir, workspace).replaceAll("\\", "/"),
    ),
  };
});
