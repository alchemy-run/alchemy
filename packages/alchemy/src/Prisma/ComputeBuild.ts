import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type { PlatformError } from "effect/PlatformError";
import type { Scope } from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { nodeFileTrace } from "@vercel/nft";
import { normalizeEntrypoint } from "./ComputeArchive.ts";

export type ComputeAutoBuildFramework =
  | "auto"
  | "nextjs"
  | "nuxt"
  | "astro"
  | "nestjs"
  | "tanstack-start"
  | "bun";

export interface ComputeAutoBuildOptions {
  /**
   * Application root.
   */
  appPath: string;
  /**
   * Entrypoint used by the Bun fallback strategy.
   */
  entrypoint?: string;
  /**
   * Framework to build. `auto` tries Next.js, Nuxt, Astro, TanStack Start,
   * then Bun.
   *
   * @default "auto"
   */
  framework?: ComputeAutoBuildFramework;
  /**
   * Environment variables supplied to the build command.
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
}

export interface ComputeBuildArtifact {
  /**
   * Directory to archive and upload.
   */
  directory: string;
  /**
   * Entrypoint relative to `directory`.
   */
  entrypoint: string;
  /**
   * Default HTTP port for framework conventions.
   */
  defaultPort?: number;
  /**
   * Removes temporary build output.
   */
  cleanup: Effect.Effect<void, never, FileSystem.FileSystem>;
}

interface BuildStrategy {
  name: Exclude<ComputeAutoBuildFramework, "auto">;
  canBuild: (appPath: string) => Effect.Effect<boolean, unknown, BuildServices>;
  execute: (
    options: Required<Pick<ComputeAutoBuildOptions, "appPath">> &
      Omit<ComputeAutoBuildOptions, "appPath">,
  ) => Effect.Effect<ComputeBuildArtifact, unknown, BuildServices>;
}

interface DirectoryEntry {
  name: string;
  type: "Directory" | "File" | "SymbolicLink" | "Other";
}

type BuildServices =
  | ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope;

export interface RunBuildCommandOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Run a shell build command, dying on non-zero exit. Local stand-in for the
 * removed `Build/Command.ts` helper, matching `Command.CommandExecutorLive`
 * spawn semantics (`shell: true`, env extended over `process.env`).
 */
export const runBuildCommand = Effect.fn(function* ({
  command,
  cwd,
  env,
}: RunBuildCommandOptions) {
  const spawner = yield* ChildProcessSpawner;
  const path = yield* Path.Path;
  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command, [], {
          cwd: path.resolve(cwd ?? "."),
          shell: true,
          env: env ?? {},
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: false,
        }),
      );
      return yield* Effect.all(
        {
          exitCode: handle.exitCode,
          stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
          stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
        },
        { concurrency: "unbounded" },
      );
    }),
  );

  if (result.exitCode !== 0) {
    return yield* Effect.fail(
      new Error(
        `Build command failed with exit code ${result.exitCode}${result.stderr ? `\n${result.stderr}` : ""}`,
      ),
    );
  }

  yield* Effect.logDebug("Build output", result.stdout);
  if (result.stderr) {
    yield* Effect.logDebug("Build stderr", result.stderr);
  }

  return result;
});

const NEXT_CONFIG_FILENAMES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.mts",
] as const;

const NUXT_CONFIG_FILENAMES = [
  "nuxt.config.js",
  "nuxt.config.mjs",
  "nuxt.config.cjs",
  "nuxt.config.ts",
  "nuxt.config.mts",
] as const;

const ASTRO_CONFIG_FILENAMES = [
  "astro.config.js",
  "astro.config.mjs",
  "astro.config.cjs",
  "astro.config.ts",
  "astro.config.mts",
] as const;

const NEST_CLI_FILENAME = "nest-cli.json";
const NEST_TSCONFIG_FILENAMES = [
  "tsconfig.build.json",
  "tsconfig.json",
] as const;
const NEST_DEFAULT_COMPILED_ENTRYPOINTS = [
  "dist/src/main.js",
  "dist/main.js",
] as const;

const TANSTACK_START_PACKAGES = [
  "@tanstack/react-start",
  "@tanstack/solid-start",
] as const;

const strategies: readonly BuildStrategy[] = [
  {
    name: "nextjs",
    canBuild: (appPath) =>
      Effect.gen(function* () {
        return (
          (yield* hasRootFile(appPath, NEXT_CONFIG_FILENAMES)) ||
          (yield* hasPackageDependency(appPath, ["next"]))
        );
      }),
    execute: (options) =>
      buildFramework({
        appPath: options.appPath,
        env: options.env,
        cliName: "next",
        args: ["build"],
        failurePrefix: "Next.js",
        missingMessage:
          "Could not find the Next.js CLI. Install it with `npm install next` or ensure npx/bunx is available.",
        sourceDir: ".next/standalone",
        entrypoint: "server.js",
        defaultPort: 3000,
        allowNestedEntrypoint: true,
        extrasRelativeToEntrypoint: true,
        missingOutputMessage:
          'Next.js build did not produce standalone output. Add output: "standalone" to your next.config file.',
        extras: [
          { from: "public", to: "public" },
          { from: ".next/static", to: ".next/static" },
        ],
      }),
  },
  {
    name: "nuxt",
    canBuild: (appPath) =>
      Effect.gen(function* () {
        return (
          (yield* hasRootFile(appPath, NUXT_CONFIG_FILENAMES)) ||
          (yield* hasPackageDependency(appPath, ["nuxt"]))
        );
      }),
    execute: (options) =>
      buildFramework({
        appPath: options.appPath,
        env: options.env,
        cliName: "nuxt",
        args: ["build"],
        failurePrefix: "Nuxt",
        missingMessage:
          "Could not find the Nuxt CLI. Install it with `npm install nuxt` or ensure npx/bunx is available.",
        sourceDir: ".output",
        entrypoint: "server/index.mjs",
        defaultPort: 3000,
        requiredFile: ".output/server/index.mjs",
        missingOutputMessage:
          "Nuxt build did not produce a Nitro node server entrypoint at .output/server/index.mjs. Ensure nitro.preset is 'node-server' (the default).",
      }),
  },
  {
    name: "astro",
    canBuild: (appPath) =>
      Effect.gen(function* () {
        return (
          (yield* hasRootFile(appPath, ASTRO_CONFIG_FILENAMES)) ||
          (yield* hasPackageDependency(appPath, ["astro"]))
        );
      }),
    execute: (options) =>
      buildFramework({
        appPath: options.appPath,
        env: options.env,
        cliName: "astro",
        args: ["build"],
        failurePrefix: "Astro",
        missingMessage:
          "Could not find the Astro CLI. Install it with `npm install astro` or ensure npx/bunx is available.",
        sourceDir: "dist",
        entrypoint: "server/entry.mjs",
        defaultPort: 4321,
        requiredFile: "dist/server/entry.mjs",
        missingOutputMessage:
          'Astro build did not produce a standalone server entrypoint. Install @astrojs/node and configure it with adapter: node({ mode: "standalone" }) in your astro.config file.',
      }),
  },
  {
    name: "nestjs",
    canBuild: (appPath) =>
      Effect.gen(function* () {
        return (
          (yield* hasRootFile(appPath, [NEST_CLI_FILENAME])) ||
          (yield* hasPackageDependency(appPath, ["@nestjs/core"]))
        );
      }),
    execute: (options) => buildNestjs(options),
  },
  {
    name: "tanstack-start",
    canBuild: (appPath) =>
      hasPackageDependency(appPath, TANSTACK_START_PACKAGES),
    execute: (options) =>
      buildFramework({
        appPath: options.appPath,
        env: options.env,
        cliName: "vite",
        args: ["build"],
        failurePrefix: "TanStack Start",
        missingMessage:
          "Could not find the Vite CLI. Install it with `npm install vite` or ensure npx/bunx is available.",
        sourceDir: ".output",
        entrypoint: "server/index.mjs",
        defaultPort: 3000,
        requiredFile: ".output/server/index.mjs",
        missingOutputMessage:
          "TanStack Start build did not produce a Nitro node server entrypoint at .output/server/index.mjs. Ensure your vite.config includes the TanStack Start and Nitro plugins with the default node preset.",
      }),
  },
  {
    name: "bun",
    canBuild: () => Effect.succeed(true),
    execute: (options) => buildBun(options),
  },
] as const;

export const runComputeAutoBuild = Effect.fn(function* (
  options: ComputeAutoBuildOptions,
) {
  const requested = options.framework ?? "auto";
  const candidates =
    requested === "auto"
      ? strategies
      : strategies.filter((strategy) => strategy.name === requested);

  for (const strategy of candidates) {
    if (yield* strategy.canBuild(options.appPath)) {
      return yield* strategy.execute(options);
    }
  }

  return yield* Effect.fail(
    new Error("No suitable Prisma Compute auto-build strategy found."),
  );
});

const buildFramework = Effect.fn(function* (options: {
  appPath: string;
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
  cliName: string;
  args: string[];
  failurePrefix: string;
  missingMessage: string;
  sourceDir: string;
  entrypoint: string;
  defaultPort: number;
  allowNestedEntrypoint?: boolean;
  requiredFile?: string;
  missingOutputMessage: string;
  extrasRelativeToEntrypoint?: boolean;
  extras?: ReadonlyArray<{ from: string; to: string }>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* runBuildCommand({
    command: yield* packageCliCommand(
      options.appPath,
      options.cliName,
      options.args,
      options.missingMessage,
    ),
    cwd: options.appPath,
    env: processBuildEnv(options.env),
  });

  const requiredPath = path.join(
    options.appPath,
    options.requiredFile ?? options.sourceDir,
  );
  if (!(yield* fs.exists(requiredPath))) {
    return yield* Effect.fail(new Error(options.missingOutputMessage));
  }

  const temp = yield* makeTempArtifactDir();
  const build = Effect.gen(function* () {
    yield* copyDirectoryPreserveSymlinks(
      path.join(options.appPath, options.sourceDir),
      temp.artifactDir,
    );
    yield* materializeBunNodeModuleAliases(
      temp.artifactDir,
      path.join(options.appPath, options.sourceDir),
    );
    const entrypoint = yield* resolveFrameworkEntrypoint(
      temp.artifactDir,
      options.entrypoint,
      options.allowNestedEntrypoint ?? false,
    );
    const extrasBaseDir = options.extrasRelativeToEntrypoint
      ? path.dirname(path.join(temp.artifactDir, entrypoint))
      : temp.artifactDir;
    for (const extra of options.extras ?? []) {
      const extraSource = path.join(options.appPath, extra.from);
      if (yield* directoryExists(extraSource)) {
        const extraTarget = path.join(extrasBaseDir, extra.to);
        yield* copyDirectoryPreserveSymlinks(extraSource, extraTarget);
      }
    }
    return {
      directory: temp.artifactDir,
      entrypoint,
      defaultPort: options.defaultPort,
      cleanup: temp.cleanup,
    };
  });

  return yield* build.pipe(
    Effect.catch((error) =>
      temp.cleanup.pipe(Effect.andThen(Effect.fail(error))),
    ),
  );
});

const buildNestjs = Effect.fn(function* (options: ComputeAutoBuildOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const buildScript = yield* readPackageScript(options.appPath, "build");

  yield* runBuildCommand({
    command:
      buildScript === undefined
        ? yield* packageCliCommand(
            options.appPath,
            "nest",
            ["build"],
            "Could not find the Nest CLI. Add a `build` script to package.json, install @nestjs/cli, or ensure npx/bunx is available.",
          )
        : packageScriptCommand("build"),
    cwd: options.appPath,
    env: processBuildEnv(options.env),
  });

  const compiledEntry = yield* resolveNestjsCompiledEntrypoint(options.appPath);
  const temp = yield* makeTempArtifactDir();
  const build = Effect.gen(function* () {
    const entrypoint = yield* stageTracedNestjsArtifact({
      appPath: options.appPath,
      artifactDir: temp.artifactDir,
      compiledEntry,
    });
    return {
      directory: temp.artifactDir,
      entrypoint,
      defaultPort: 3000,
      cleanup: temp.cleanup,
    };
  });

  return yield* build.pipe(
    Effect.catch((error) =>
      fs
        .remove(path.dirname(temp.artifactDir), { recursive: true })
        .pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
    ),
  );
});

const resolveNestjsCompiledEntrypoint = Effect.fn(function* (appPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates = [
    yield* readPackageMain(appPath),
    yield* configuredNestjsCompiledEntrypoint(appPath),
    ...NEST_DEFAULT_COMPILED_ENTRYPOINTS,
  ].flatMap((candidate) => {
    if (candidate === undefined) return [];
    const normalized = normalizeRelativePath(candidate);
    return normalized === undefined ? [] : [normalized];
  });

  for (const candidate of candidates) {
    const stat = yield* fs
      .stat(path.join(appPath, candidate))
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (stat?.type === "File") return candidate;
  }

  return yield* Effect.fail(
    new Error(
      `NestJS build did not produce a compiled entrypoint. Looked for ${candidates.join(", ")} under ${appPath}. Ensure \`nest build\` ran and check package.json main, nest-cli.json, or tsconfig outDir.`,
    ),
  );
});

const configuredNestjsCompiledEntrypoint = Effect.fn(function* (
  appPath: string,
) {
  const path = yield* Path.Path;
  const config = yield* readNestCliConfig(appPath);
  const sourceRoot = normalizeRelativePath(config.sourceRoot ?? "src") ?? "src";
  const entryFile = config.entryFile ?? "main";
  const outDir = yield* readNestjsOutDir(appPath);
  return sourceRoot === "."
    ? path.join(outDir, `${entryFile}.js`)
    : path.join(outDir, sourceRoot, `${entryFile}.js`);
});

const stageTracedNestjsArtifact = Effect.fn(function* (options: {
  appPath: string;
  artifactDir: string;
  compiledEntry: string;
}) {
  const path = yield* Path.Path;
  const sourceRoot = yield* resolveSourceRoot(options.appPath);
  const entry = path.join(options.appPath, options.compiledEntry);
  const entrypoint = path.relative(sourceRoot, entry).replaceAll("\\", "/");
  const fileList = yield* Effect.tryPromise({
    try: () =>
      nodeFileTrace([entry], { base: sourceRoot }).then((result) =>
        Array.from(result.fileList),
      ),
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error(`Failed to trace NestJS artifact: ${String(cause)}`),
  });

  const sortedFiles = fileList.sort((a, b) => a.localeCompare(b));
  for (const file of sortedFiles) {
    yield* stageTracedPath(
      path.join(sourceRoot, file),
      path.join(options.artifactDir, file),
    );
  }

  return entrypoint;
});

const copyDirectoryPreserveSymlinks: (
  sourceDir: string,
  targetDir: string,
) => Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path> =
  Effect.fn(function* (sourceDir, targetDir) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(targetDir, { recursive: true });

    const entries = (yield* readDirectoryEntries(sourceDir)).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const source = path.join(sourceDir, entry.name);
      const target = path.join(targetDir, entry.name);
      if (entry.type === "SymbolicLink") {
        const symlinkTarget = (yield* fs.readLink(source)).replaceAll(
          "\\",
          "/",
        );
        yield* fs.remove(target, { recursive: true, force: true });
        yield* fs.symlink(symlinkTarget, target);
        continue;
      }

      if (entry.type === "Directory") {
        yield* copyDirectoryPreserveSymlinks(source, target);
      } else if (entry.type === "File") {
        const stat = yield* fs.stat(source);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.copyFile(source, target);
        yield* fs.chmod(target, stat.mode & 0o777);
      }
    }
  });

const readDirectoryEntries = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(directory);
  return yield* Effect.forEach(names, (name) =>
    Effect.gen(function* () {
      const file = path.join(directory, name);
      const isSymlink = yield* fs.readLink(file).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      if (isSymlink) {
        return { name, type: "SymbolicLink" } satisfies DirectoryEntry;
      }
      const stat = yield* fs.stat(file);
      return {
        name,
        type:
          stat.type === "Directory" || stat.type === "File"
            ? stat.type
            : "Other",
      } satisfies DirectoryEntry;
    }),
  );
});

const materializeBunNodeModuleAliases = Effect.fn(function* (
  artifactDir: string,
  sourceDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nodeModules = path.join(artifactDir, "node_modules");
  const aliasRoot = path.join(nodeModules, ".bun", "node_modules");
  if (!(yield* directoryExists(aliasRoot))) return;
  const allowedRoots = [
    yield* fs.realPath(artifactDir),
    yield* fs.realPath(sourceDir),
  ];

  for (const entry of yield* fs.readDirectory(aliasRoot)) {
    const source = path.join(aliasRoot, entry);
    const stat = yield* fs
      .stat(source)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (stat?.type !== "Directory") continue;

    if (entry.startsWith("@")) {
      const targetScope = path.join(nodeModules, entry);
      yield* fs.makeDirectory(targetScope, { recursive: true });
      for (const packageName of yield* fs.readDirectory(source)) {
        yield* copyAliasIfMissing(
          allowedRoots,
          path.join(source, packageName),
          path.join(targetScope, packageName),
        );
      }
    } else {
      yield* copyAliasIfMissing(
        allowedRoots,
        source,
        path.join(nodeModules, entry),
      );
    }
  }
});

const copyAliasIfMissing = Effect.fn(function* (
  allowedRoots: readonly string[],
  source: string,
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (yield* fs.exists(target)) return;
  const realSource = yield* fs.realPath(source);
  const insideAllowedRoot = allowedRoots.some((root) => {
    const relative = path.relative(root, realSource);
    return (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  });
  if (!insideAllowedRoot) {
    return yield* Effect.fail(
      new Error(`Bun package alias escapes compute artifact root: ${source}`),
    );
  }
  yield* fs.copy(realSource, target, { overwrite: false });
});

const resolveFrameworkEntrypoint = Effect.fn(function* (
  artifactDir: string,
  entrypoint: string,
  allowNested: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!allowNested) {
    return entrypoint;
  }

  const entrypointFile = path.basename(entrypoint);
  const candidates = (yield* fs.readDirectory(artifactDir, { recursive: true }))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => {
      const parts = file.split("/");
      return (
        path.basename(file) === entrypointFile &&
        !parts.includes("node_modules") &&
        !parts.includes(".next")
      );
    })
    .sort((a, b) => {
      const depth = a.split(/[\\/]/).length - b.split(/[\\/]/).length;
      return depth === 0 ? a.localeCompare(b) : depth;
    });

  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    return yield* Effect.fail(
      new Error(
        `Next.js standalone output has multiple ${entrypointFile} files (${candidates.join(", ")}). Cannot determine the application entrypoint.`,
      ),
    );
  }

  return yield* Effect.fail(
    new Error(
      `Could not find framework entrypoint ${entrypoint} inside ${artifactDir}.`,
    ),
  );
});

function buildBun(options: ComputeAutoBuildOptions) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entrypoint = yield* resolveBunEntrypoint(
      options.appPath,
      options.entrypoint,
    );
    const absoluteEntrypoint = path.join(options.appPath, entrypoint);
    const temp = yield* makeTempArtifactDir("bundle");

    const build = Effect.gen(function* () {
      yield* runBuildCommand({
        command: [
          "bun",
          "build",
          shellQuote(absoluteEntrypoint),
          "--outdir",
          shellQuote(temp.artifactDir),
          "--target",
          "bun",
          "--sourcemap=external",
        ].join(" "),
        cwd: options.appPath,
        env: processBuildEnv(options.env),
      });

      const outputFiles = (yield* fs.readDirectory(temp.artifactDir))
        .filter((file) => file.endsWith(".js"))
        .sort();
      if (outputFiles.length === 0) {
        return yield* Effect.fail(
          new Error("Bun build produced no JavaScript output."),
        );
      }

      const expected = `${path.basename(
        absoluteEntrypoint,
        path.extname(absoluteEntrypoint),
      )}.js`;
      return {
        directory: temp.artifactDir,
        entrypoint: outputFiles.includes(expected) ? expected : outputFiles[0]!,
        cleanup: temp.cleanup,
      };
    });

    return yield* build.pipe(
      Effect.catch((error) =>
        temp.cleanup.pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  });
}

const resolveBunEntrypoint = Effect.fn(function* (
  appPath: string,
  entrypoint: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidate = entrypoint ?? (yield* readPackageMain(appPath));
  if (!candidate) {
    return yield* Effect.fail(
      new Error(
        "Prisma Compute auto-build needs an entrypoint for Bun apps. Set `entrypoint` or package.json `main`.",
      ),
    );
  }
  const normalized = yield* normalizeEntrypoint(candidate);
  const entrypointPath = path.join(appPath, normalized);
  if (!(yield* fs.exists(entrypointPath))) {
    return yield* Effect.fail(
      new Error(`Entrypoint file does not exist: ${entrypointPath}`),
    );
  }
  return normalized;
});

const makeTempArtifactDir = Effect.fn(function* (leaf = "app") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectory({
    prefix: "alchemy-prisma-compute-build-",
  });
  const artifactDir = path.join(tempDir, leaf);
  yield* fs.makeDirectory(artifactDir, { recursive: true });
  return {
    artifactDir,
    cleanup: fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore),
  };
});

const hasRootFile = Effect.fn(function* (
  appPath: string,
  filenames: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* fs
    .readDirectory(appPath)
    .pipe(Effect.catch(() => Effect.succeed([] as string[])));
  return entries.some((entry) => filenames.includes(entry));
});

const hasPackageDependency = Effect.fn(function* (
  appPath: string,
  packageNames: readonly string[],
) {
  const parsed = yield* readPackageJson(appPath);
  if (!parsed) return false;
  const deps = isRecord(parsed.dependencies) ? parsed.dependencies : {};
  const devDeps = isRecord(parsed.devDependencies)
    ? parsed.devDependencies
    : {};
  return packageNames.some((name) => name in deps || name in devDeps);
});

const readPackageMain = Effect.fn(function* (appPath: string) {
  const parsed = yield* readPackageJson(appPath);
  return typeof parsed?.main === "string" ? parsed.main : undefined;
});

const readPackageScript = Effect.fn(function* (
  appPath: string,
  scriptName: string,
) {
  const parsed = yield* readPackageJson(appPath);
  const scripts = isRecord(parsed?.scripts) ? parsed.scripts : undefined;
  const script = scripts?.[scriptName];
  return typeof script === "string" && script.trim() !== ""
    ? script
    : undefined;
});

const readPackageJson = Effect.fn(function* (appPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packagePath = path.join(appPath, "package.json");
  const text = yield* fs
    .readFileString(packagePath)
    .pipe(
      Effect.catch((error) =>
        error._tag === "PlatformError" && error.reason._tag === "NotFound"
          ? Effect.succeed(undefined)
          : Effect.fail(error),
      ),
    );
  if (!text) return undefined;
  return yield* Effect.try({
    try: () => JSON.parse(text) as Record<string, unknown>,
    catch: (cause) =>
      new Error(`Failed to parse package.json in ${appPath}: ${cause}`),
  });
});

const readNestCliConfig = Effect.fn(function* (appPath: string) {
  const parsed = yield* readJsonObjectFile(appPath, NEST_CLI_FILENAME);
  return {
    sourceRoot:
      typeof parsed?.sourceRoot === "string" ? parsed.sourceRoot : undefined,
    entryFile:
      typeof parsed?.entryFile === "string" ? parsed.entryFile : undefined,
  };
});

const readNestjsOutDir = Effect.fn(function* (appPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const fileName of NEST_TSCONFIG_FILENAMES) {
    const filePath = path.join(appPath, fileName);
    const text = yield* fs
      .readFileString(filePath)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (text === undefined) continue;
    const outDir = yield* parseTsconfigOutDir(text);
    if (outDir !== undefined) return outDir;
  }
  return "dist";
});

const parseTsconfigOutDir = Effect.fn(function* (content: string) {
  const parsed = yield* Effect.try({
    try: () =>
      JSON.parse(stripJsonComments(content)) as {
        compilerOptions?: { outDir?: unknown };
      },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  const outDir = parsed?.compilerOptions?.outDir;
  return typeof outDir === "string" ? normalizeRelativePath(outDir) : undefined;
});

const readJsonObjectFile = Effect.fn(function* (
  directory: string,
  fileName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(directory, fileName))
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (text === undefined) return undefined;
  return yield* Effect.try({
    try: () => {
      const parsed = JSON.parse(text) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
});

const directoryExists = Effect.fn(function* (dirPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs
    .stat(dirPath)
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return stat?.type === "Directory";
});

const stageTracedPath = Effect.fn(function* (
  sourcePath: string,
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const symlinkTarget = yield* fs
    .readLink(sourcePath)
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  const stat = yield* fs
    .stat(sourcePath)
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  if (stat === undefined && symlinkTarget === undefined) return;

  yield* fs.makeDirectory(path.dirname(destinationPath), { recursive: true });
  if (symlinkTarget !== undefined) {
    yield* fs.remove(destinationPath, { recursive: true, force: true });
    yield* fs.symlink(symlinkTarget, destinationPath);
    return;
  }

  if (stat?.type === "File") {
    yield* fs.copyFile(sourcePath, destinationPath);
    yield* fs.chmod(destinationPath, stat.mode & 0o777);
  }
});

const resolveSourceRoot = Effect.fn(function* (startPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const original = path.resolve(startPath);
  let current = original;

  while (true) {
    if (
      (yield* fs.exists(path.join(current, ".git"))) ||
      (yield* fs.exists(path.join(current, "pnpm-workspace.yaml"))) ||
      (yield* fs.exists(path.join(current, "bun.lock"))) ||
      (yield* fs.exists(path.join(current, "bun.lockb"))) ||
      (yield* packageJsonDeclaresWorkspaces(current))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return original;
    current = parent;
  }
});

const packageJsonDeclaresWorkspaces = Effect.fn(function* (directory: string) {
  const parsed = yield* readJsonObjectFile(directory, "package.json");
  return parsed?.workspaces !== undefined;
});

const packageCliCommand = Effect.fn(function* (
  appPath: string,
  cliName: string,
  args: readonly string[],
  missingMessage: string,
) {
  const path = yield* Path.Path;
  const localBin = path.join(appPath, "node_modules", ".bin", cliName);
  const argText = args.map(shellQuote).join(" ");
  return [
    `if [ -x ${shellQuote(localBin)} ]; then`,
    `${shellQuote(localBin)} ${argText};`,
    "elif command -v npx >/dev/null 2>&1; then",
    `npx ${shellQuote(cliName)} ${argText};`,
    "elif command -v bunx >/dev/null 2>&1; then",
    `bunx ${shellQuote(cliName)} ${argText};`,
    "else",
    `echo ${shellQuote(missingMessage)} >&2; exit 127;`,
    "fi",
  ].join(" ");
});

const packageScriptCommand = (scriptName: string) =>
  [
    "if command -v bun >/dev/null 2>&1; then",
    `bun run ${shellQuote(scriptName)};`,
    "elif command -v npm >/dev/null 2>&1; then",
    `npm run ${shellQuote(scriptName)};`,
    "else",
    `echo ${shellQuote("Could not find bun or npm to run package scripts.")} >&2; exit 127;`,
    "fi",
  ].join(" ");

const processBuildEnv = (
  env: Record<string, string | Redacted.Redacted<string> | undefined> = {},
) =>
  Object.fromEntries(
    Object.entries(env).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [[key, Redacted.isRedacted(value) ? Redacted.value(value) : value]],
    ),
  ) as Record<string, string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeRelativePath = (value: string) => {
  const raw = value.trim().replaceAll("\\", "/");
  if (raw.length === 0 || raw.startsWith("/") || /^[a-zA-Z]:\//.test(raw)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/") || ".";
};

const stripJsonComments = (content: string) => {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    const next = content[i + 1];
    if (char === "/" && next === "/") {
      while (i < content.length && content[i] !== "\n") {
        i++;
      }
      if (i < content.length) result += content[i];
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (
        i < content.length &&
        !(content[i] === "*" && content[i + 1] === "/")
      ) {
        i++;
      }
      i++;
      continue;
    }

    result += char;
  }

  return result;
};

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
