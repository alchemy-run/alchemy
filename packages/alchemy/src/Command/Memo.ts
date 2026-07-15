import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";
import { gitignoreRulesToGlobs } from "../Util/gitignore-rules-to-globs.ts";
import { sha256, sha256Object } from "../Util/sha256.ts";

/**
 * Controls which files are included in the content hash that determines
 * whether a build needs to re-run.
 *
 * By default (no options), every non-gitignored file in the working directory
 * is hashed, plus the nearest package-manager lockfile. Provide explicit
 * `include`/`exclude` globs to narrow the scope when the default is too broad.
 */
export interface MemoOptions {
  /**
   * Glob patterns of files to hash. Paths are relative to the working directory.
   *
   * @default ["**\/*"] (all files, filtered by `exclude`)
   * @example ["src/**", "package.json", "tsconfig.json"]
   */
  include?: string[];
  /**
   * Glob patterns to exclude from hashing. Paths are relative to the working directory.
   *
   * @default gitignore rules collected from the working directory up to the repo root
   */
  exclude?: string[];
  /**
   * Whether to include the nearest package-manager lockfile (`bun.lock`,
   * `package-lock.json`, `pnpm-lock.yaml`, or `yarn.lock`) in the hash,
   * even when it lives above the working directory (e.g. monorepo root).
   *
   * @default true when both `include` and `exclude` are unset; false otherwise
   */
  lockfile?: boolean;
}

interface ResolvedMemoOptions {
  cwd: string;
  include: string[];
  exclude: string[];
  lockfile: boolean;
}

/** A workspace package reachable from the build root. */
export interface WorkspacePackage {
  /** The package's `name` field, used as a machine-independent hash key. */
  readonly name: string;
  /** Absolute path to the package directory. */
  readonly dir: string;
}

/** The subset of a `package.json` we read to resolve the workspace closure. */
interface PackageManifest {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly workspaces?: string[] | { packages?: string[] };
}

/** The subset of `pnpm-workspace.yaml` we read for workspace globs. */
interface PnpmWorkspace {
  readonly packages?: string[];
}

/**
 * Collects the dependency names to follow when walking the workspace graph.
 * At the build root we also follow `devDependencies` (Vite plugins and shared
 * config packages that shape the build live there); deeper in the graph we
 * follow only the runtime edges a consumer actually pulls in, so the closure
 * stays scoped to what the app bundles instead of the whole monorepo.
 */
const dependencyNames = (
  manifest: PackageManifest,
  includeDev: boolean,
): string[] => [
  ...Object.keys(manifest.dependencies ?? {}),
  ...(includeDev ? Object.keys(manifest.devDependencies ?? {}) : []),
  ...Object.keys(manifest.optionalDependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
];

const workspaceGlobs = (
  manifest: PackageManifest | undefined,
  pnpm: PnpmWorkspace | undefined,
): string[] => {
  const workspaces = manifest?.workspaces;
  if (Array.isArray(workspaces)) return workspaces;
  if (workspaces && Array.isArray(workspaces.packages))
    return workspaces.packages;
  if (pnpm && Array.isArray(pnpm.packages)) return pnpm.packages;
  return [];
};

/**
 * Internal service that resolves memo options, lists matching files, and
 * produces a single SHA-256 content hash. Constructed as an Effect so it
 * can access the platform `FileSystem` and `Path` services.
 */
const Memo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const findUp = Effect.fn(function* (
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

  const readGitIgnoreRules = Effect.fn(function* (
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

  const resolveMemoOptions = Effect.fn(function* (
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

  const listFiles = Effect.fn(function* (
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
            ]).pipe(
              Effect.map((lockfile) =>
                lockfile ? path.relative(options.cwd, lockfile) : undefined,
              ),
            )
          : Effect.succeed(undefined),
      ],
      { concurrency: "unbounded" },
    );
    if (lockfile && !files.includes(lockfile)) {
      files.push(lockfile);
    }
    return files.sort();
  });

  const hashFiles = Effect.fn(function* (
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

  const readJsonFile = Effect.fn(function* <T>(
    file: string,
    parse: (content: string) => T,
  ): Effect.fn.Return<T | undefined, PlatformError> {
    const content = yield* fs.readFileString(file).pipe(
      Effect.catchIf(
        (error) =>
          error._tag === "PlatformError" && error.reason._tag === "NotFound",
        () => Effect.succeed(undefined),
      ),
    );
    if (content === undefined) {
      return undefined;
    }
    // Malformed manifests must not crash a deploy hash; a package we can't
    // parse simply drops out of the workspace closure.
    return yield* Effect.sync(() => {
      try {
        return parse(content);
      } catch {
        return undefined;
      }
    });
  });

  const readManifest = (dir: string) =>
    readJsonFile(
      path.join(dir, "package.json"),
      (content) => JSON.parse(content) as PackageManifest,
    );

  const readPnpmWorkspace = (dir: string) =>
    readJsonFile(
      path.join(dir, "pnpm-workspace.yaml"),
      (content) => parseYaml(content) as PnpmWorkspace,
    );

  // Walk up from `cwd` to the nearest ancestor that declares a package
  // workspace (bun/npm/yarn `workspaces`, or `pnpm-workspace.yaml`).
  const findWorkspaceRoot = Effect.fn(function* (
    cwd: string,
  ): Effect.fn.Return<
    { root: string; globs: string[] } | undefined,
    PlatformError
  > {
    let dir = cwd;
    while (true) {
      const [manifest, pnpm] = yield* Effect.all(
        [readManifest(dir), readPnpmWorkspace(dir)],
        { concurrency: "unbounded" },
      );
      const globs = workspaceGlobs(manifest, pnpm);
      if (globs.length > 0) {
        return { root: dir, globs };
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return undefined;
      }
      dir = parent;
    }
  });

  // Expand the workspace globs to a name → { dir, manifest } map. Reads each
  // package.json once so the closure walk never re-reads a manifest.
  const listWorkspacePackages = Effect.fn(function* (
    root: string,
    globs: string[],
  ): Effect.fn.Return<
    Map<string, { dir: string; manifest: PackageManifest }>,
    PlatformError
  > {
    const packageJsonPaths = yield* Effect.promise(() =>
      fg.glob(
        globs.map((glob) => `${glob.replace(/\/+$/, "")}/package.json`),
        {
          cwd: root,
          ignore: ["**/node_modules/**"],
          onlyFiles: true,
          absolute: true,
        },
      ),
    );
    const entries = yield* Effect.forEach(
      packageJsonPaths,
      (packageJsonPath) =>
        Effect.gen(function* () {
          const dir = path.dirname(packageJsonPath);
          const manifest = yield* readManifest(dir);
          if (!manifest?.name) {
            return undefined;
          }
          return [manifest.name, { dir, manifest }] as const;
        }),
      { concurrency: "unbounded" },
    );
    const packages = new Map<
      string,
      { dir: string; manifest: PackageManifest }
    >();
    for (const entry of entries) {
      if (entry) {
        packages.set(entry[0], entry[1]);
      }
    }
    return packages;
  });

  // The set of workspace packages `cwd` transitively depends on, excluding
  // `cwd` itself. Empty when `cwd` is not inside a package workspace or its
  // dependency graph reaches no sibling packages.
  const resolveWorkspaceClosure = Effect.fn(function* (
    cwd: string,
  ): Effect.fn.Return<WorkspacePackage[], PlatformError> {
    const rootDir = path.resolve(cwd);
    const [rootManifest, workspace] = yield* Effect.all(
      [readManifest(rootDir), findWorkspaceRoot(rootDir)],
      { concurrency: "unbounded" },
    );
    if (!rootManifest || !workspace) {
      return [];
    }
    const packages = yield* listWorkspacePackages(
      workspace.root,
      workspace.globs,
    );
    const visited = new Set<string>();
    if (rootManifest.name) {
      visited.add(rootManifest.name);
    }
    const closure: WorkspacePackage[] = [];
    const queue = dependencyNames(rootManifest, true);
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (visited.has(name)) {
        continue;
      }
      visited.add(name);
      const pkg = packages.get(name);
      if (!pkg || path.resolve(pkg.dir) === rootDir) {
        continue;
      }
      closure.push({ name, dir: pkg.dir });
      queue.push(...dependencyNames(pkg.manifest, false));
    }
    closure.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return closure;
  });

  return {
    resolveMemoOptions,
    listFiles,
    hashFiles,
    resolveWorkspaceClosure,
  };
});

/**
 * Produces a deterministic SHA-256 hash of all files matched by the given
 * memo options. The hash changes if and only if the content of the matched
 * files changes, making it suitable for cache-busting build outputs.
 */
export const hashDirectory = Effect.fn(function* (props: {
  cwd?: string;
  memo?: MemoOptions;
}): Effect.fn.Return<string, PlatformError, FileSystem.FileSystem | Path.Path> {
  const service = yield* Memo;
  const resolvedOptions = yield* service.resolveMemoOptions(
    props.cwd,
    props.memo ?? {},
  );
  const files = yield* service.listFiles(resolvedOptions);
  const hash = yield* service.hashFiles(resolvedOptions.cwd, files);
  return hash;
});

/**
 * Resolves the workspace packages that the project at `cwd` transitively
 * depends on. Walks up to the workspace root (bun/npm/yarn `workspaces` or
 * `pnpm-workspace.yaml`), matches `cwd`'s dependency graph against the
 * workspace's own packages, and follows workspace edges to a cycle-safe
 * closure. Returns an empty array when `cwd` is not inside a workspace.
 */
export const resolveWorkspaceClosure = Effect.fn(function* (
  cwd: string,
): Effect.fn.Return<
  WorkspacePackage[],
  PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const service = yield* Memo;
  return yield* service.resolveWorkspaceClosure(cwd);
});

/**
 * Hashes the inputs that determine whether a Vite-built Worker must rebuild:
 * the project directory (`cwd`, honoring `memo`) plus every workspace package
 * it transitively depends on. In a monorepo the app at `cwd` imports packages
 * that live outside it; hashing `cwd` alone makes changes to those packages
 * look like a no-op and silently skips the deploy. Each workspace package is
 * hashed with the same gitignore-respecting semantics as `cwd` (keyed by
 * package name so the hash is machine-independent), and folded into the
 * result. With no workspace dependencies the hash is identical to
 * {@link hashDirectory} of `cwd`, so non-monorepo Workers are unaffected.
 */
export const hashViteBuildInputs = Effect.fn(function* (props: {
  cwd?: string;
  memo?: MemoOptions;
}): Effect.fn.Return<string, PlatformError, FileSystem.FileSystem | Path.Path> {
  const service = yield* Memo;
  const path = yield* Path.Path;
  const rootDir = props.cwd ? path.resolve(props.cwd) : process.cwd();
  const [rootHash, closure] = yield* Effect.all(
    [
      hashDirectory({ cwd: rootDir, memo: props.memo }),
      service.resolveWorkspaceClosure(rootDir),
    ],
    { concurrency: "unbounded" },
  );
  if (closure.length === 0) {
    return rootHash;
  }
  // The root hash already folds in the nearest lockfile; skip it per package
  // so a shared monorepo lockfile isn't re-hashed once per closure member.
  const workspaceHashes = yield* Effect.forEach(
    closure,
    ({ name, dir }) =>
      hashDirectory({ cwd: dir, memo: { lockfile: false } }).pipe(
        Effect.map((hash) => `${name}:${hash}`),
      ),
    { concurrency: "unbounded" },
  );
  return yield* sha256Object({ root: rootHash, workspace: workspaceHashes });
});
