import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import type { Scope } from "effect/Scope";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { runBuildCommand } from "../Build/Command.ts";
import { normalizeEntrypoint } from "./ComputeArchive.ts";

export type ComputeAutoBuildFramework =
  | "auto"
  | "nextjs"
  | "nuxt"
  | "astro"
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

type BuildServices =
  | ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Scope;

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
    yield* fs.copy(
      path.join(options.appPath, options.sourceDir),
      temp.artifactDir,
      { overwrite: true },
    );
    for (const extra of options.extras ?? []) {
      const extraSource = path.join(options.appPath, extra.from);
      if (yield* directoryExists(extraSource)) {
        const extraTarget = path.join(temp.artifactDir, extra.to);
        yield* fs.makeDirectory(path.dirname(extraTarget), {
          recursive: true,
        });
        yield* fs.copy(extraSource, extraTarget, { overwrite: true });
      }
    }
    yield* materializeBunNodeModuleAliases(
      temp.artifactDir,
      path.join(options.appPath, options.sourceDir),
    );
    const entrypoint = yield* resolveFrameworkEntrypoint(
      temp.artifactDir,
      options.entrypoint,
      options.allowNestedEntrypoint ?? false,
    );
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
  if (!allowNested || (yield* fs.exists(path.join(artifactDir, entrypoint)))) {
    return entrypoint;
  }

  const entrypointFile = path.basename(entrypoint);
  const candidates = (yield* fs.readDirectory(artifactDir, { recursive: true }))
    .filter((file) => {
      const parts = file.split(/[\\/]/);
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

  if (candidates[0]) return candidates[0];

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

const directoryExists = Effect.fn(function* (dirPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs
    .stat(dirPath)
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  return stat?.type === "Directory";
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

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
