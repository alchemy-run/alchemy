import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";

/**
 * Input-hash scoping, mirroring alchemy's `MemoOptions` (`Command/Memo.ts`):
 * by default every non-gitignored file under the root is hashed plus the
 * nearest package-manager lockfile; explicit `include` / `exclude` globs
 * narrow the scope.
 *
 * The glob support is a self-contained subset (`**`, `*`, `?`;
 * gitignore-style anchoring). Negated (`!`) gitignore rules are ignored.
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

const escapeRegExpChar = (char: string): string =>
  /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;

const globBodyToRegExpSource = (glob: string): string => {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:[^/]+/)*";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += escapeRegExpChar(char);
      i += 1;
    }
  }
  return source;
};

/**
 * Compile one gitignore-style rule into a RegExp over root-relative posix
 * paths, matching the path and everything under it. `undefined` for blank
 * lines, comments and negated rules.
 */
const compileIgnoreRule = (raw: string): RegExp | undefined => {
  let rule = raw.trim();
  if (rule.length === 0 || rule.startsWith("#") || rule.startsWith("!")) return undefined;
  if (rule.endsWith("/")) rule = rule.slice(0, -1);
  if (rule.length === 0) return undefined;
  const anchored = rule.includes("/");
  if (rule.startsWith("/")) rule = rule.slice(1);
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${globBodyToRegExpSource(rule)}(?:/.*)?$`);
};

export const compileIgnoreRules = (rules: ReadonlyArray<string>): Array<RegExp> =>
  rules.map(compileIgnoreRule).filter((regex): regex is RegExp => regex !== undefined);

const compileIncludeGlobs = (globs: ReadonlyArray<string>): Array<RegExp> =>
  globs.map((glob) => new RegExp(`^${globBodyToRegExpSource(glob)}$`));

export const matchesAny = (regexes: ReadonlyArray<RegExp>, path: string): boolean =>
  regexes.some((regex) => regex.test(path));

const LOCKFILE_NAMES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

const findUp = Effect.fn(function* (startDir: string, filenames: ReadonlyArray<string>) {
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
 * `.gitignore` rules from `rootDir` up to the repo root (the first directory
 * containing `.git`), outermost first. Rules apply relative to `rootDir`.
 */
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

interface ResolvedMemo {
  readonly include: Array<RegExp> | undefined;
  readonly exclude: Array<RegExp>;
  readonly lockfile: boolean;
}

const resolveMemo = Effect.fn(function* (
  rootDir: string,
  outputDirs: ReadonlyArray<string>,
  memo: MemoOptions | undefined,
) {
  const exclude =
    memo?.exclude !== undefined
      ? compileIgnoreRules(memo.exclude)
      : compileIgnoreRules(yield* readGitIgnoreRules(rootDir));
  return {
    include: memo?.include !== undefined ? compileIncludeGlobs(memo.include) : undefined,
    exclude: [
      // Always excluded: dependency trees, VCS metadata, and the framework's
      // own build output (hashing it would make every build bust its memo).
      ...compileIgnoreRules([
        "node_modules",
        ".git",
        ".alchemy",
        ...outputDirs.map((dir) => `/${dir.replace(/^\.?\//, "")}`),
      ]),
      ...exclude,
    ],
    lockfile: memo?.lockfile ?? !(memo?.include || memo?.exclude),
  } satisfies ResolvedMemo;
});

/** Content hash of one tree: sorted `relativePosixPath:sha256` pairs, never absolute paths. */
const hashDirectory = Effect.fn(function* (rootDir: string, memo: ResolvedMemo) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  const walk: (dir: string, rel: string) => Effect.Effect<void, PlatformError> = Effect.fn(
    function* (dir: string, rel: string) {
      for (const entry of (yield* fs.readDirectory(dir)).sort()) {
        const relPath = rel === "" ? entry : `${rel}/${entry}`;
        if (matchesAny(memo.exclude, relPath)) continue;
        const absPath = path.join(dir, entry);
        const stat = yield* fs.stat(absPath);
        if (stat.type === "Directory") yield* walk(absPath, relPath);
        else if (stat.type === "File") {
          if (memo.include !== undefined && !matchesAny(memo.include, relPath)) continue;
          files.push(relPath);
        }
      }
    },
  );
  yield* walk(rootDir, "");
  if (memo.lockfile) {
    const lockfile = yield* findUp(rootDir, LOCKFILE_NAMES);
    if (lockfile !== undefined) {
      const relative = path.relative(rootDir, lockfile).replaceAll("\\", "/");
      if (!files.includes(relative)) files.push(relative);
    }
  }
  const hashes = yield* Effect.forEach(
    files.sort(),
    Effect.fn(function* (file) {
      return `${file}:${sha256(yield* fs.readFile(path.join(rootDir, file)))}`;
    }),
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
  const memo = yield* resolveMemo(params.rootDir, params.outputDirs, params.memo);
  const workspaceMemo = yield* resolveMemo(params.rootDir, params.outputDirs, undefined);
  const workspaces = Array.from(params.workspaces, (workspace) =>
    path.resolve(params.rootDir, workspace),
  );
  const [root, ...workspaceHashes] = yield* Effect.all(
    [
      hashDirectory(params.rootDir, memo),
      ...workspaces.map((workspace) =>
        Effect.gen(function* () {
          const rules = yield* readGitIgnoreRules(workspace);
          const hash = yield* hashDirectory(workspace, {
            ...workspaceMemo,
            exclude: [...workspaceMemo.exclude, ...compileIgnoreRules(rules)],
          });
          return `${path.relative(params.rootDir, workspace).replaceAll("\\", "/")}:${hash}`;
        }),
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
