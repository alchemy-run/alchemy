// Shared build plumbing for the workspace packages under packages/.
//
// Each package's `scripts/build.ts` (its `build:package` script) declares its
// options and compile steps and hands them to `build`, which:
//
// 1. Generates `publishConfig.exports` from the package's source `exports`.
//    In the workspace, `exports` points straight at `src/*.ts` so every
//    consumer runs from source without a build. Published tarballs swap in
//    `publishConfig.exports`, which resolves to the compiled output and keeps
//    the `bun` (and, where enabled, `worker`) conditions on source.
// 2. Copies the repository's LICENSE, NOTICE and, where needed,
//    THIRD_PARTY_LICENSES.md and README.md into the package.
// 3. Runs the compile steps in order.
// 4. For packages consumed from their build output, writes
//    `<outDir>/.build-stamp`, which `ensure-built.ts` compares against the
//    sources to decide whether a rebuild is needed.
//
// Every phase is timed. The timings are printed when the build finishes and
// appended to the package's `.cache/build-timings.jsonl`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner;

/** A named compile step, run with the package directory as cwd. */
export interface Step {
  readonly name: string;
  readonly run: (packageDirectory: string) => Effect.Effect<void, unknown, Services>;
}

export interface BuildOptions {
  /** Generate `publishConfig.exports` from `exports`. */
  readonly exports?: {
    /** Add a `worker` condition on source for Worker bundlers. */
    readonly worker?: boolean;
    /** Subpaths that resolve to source in every condition. */
    readonly sourceOnly?: ReadonlyArray<string>;
  };
  /** Copy THIRD_PARTY_LICENSES.md into the package. */
  readonly thirdPartyLicenses?: boolean;
  /** Copy README.md into the package. */
  readonly readme?: boolean;
  /**
   * Output directory consumed from its build output in the workspace. A
   * successful build writes its `.build-stamp` (see ensure-built.ts).
   */
  readonly stamp?: string;
  readonly steps: ReadonlyArray<Step>;
}

/** File recording a successful build inside a stamped output directory. */
export const stampFile = ".build-stamp";

const workspaceRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dirname, "..");
});

/** Run a command; fails when it exits non-zero. */
export const exec = (command: string, ...args: Array<string>): Step => ({
  name: [command, ...args].join(" "),
  run: Effect.fn(function* (packageDirectory) {
    const spawner = yield* ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(command, args, {
        cwd: packageDirectory,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(new Error(`${command} exited with code ${exitCode}`));
    }
  }),
});

/** Copy a file, paths relative to the package directory. */
export const copy = (from: string, to: string): Step => ({
  name: `copy ${from} → ${to}`,
  run: Effect.fn(function* (packageDirectory) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.copyFile(path.join(packageDirectory, from), path.join(packageDirectory, to));
  }),
});

const syncPublishExports = Effect.fn(function* (
  packageDirectory: string,
  options: NonNullable<BuildOptions["exports"]>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const packageJsonPath = path.join(packageDirectory, "package.json");
  const packageJson = JSON.parse(yield* fs.readFileString(packageJsonPath)) as {
    exports: Record<string, string | null>;
    publishConfig?: Record<string, unknown>;
  };
  const tsconfig = JSON.parse(
    yield* fs.readFileString(path.join(packageDirectory, "tsconfig.json")),
  ) as { compilerOptions: { outDir: string } };
  const outDir = `./${path.normalize(tsconfig.compilerOptions.outDir)}/`;

  const exports = Object.fromEntries(
    Object.entries(packageJson.exports).map(([subpath, source]) => {
      // Non-source entries (bin scripts, package.json) publish as-is.
      if (source === null || !source.startsWith("./src/")) {
        return [subpath, source];
      }
      if (options.sourceOnly?.includes(subpath)) {
        return [subpath, { types: source, bun: source, default: source }];
      }

      const output = source.replace(/^\.\/src\//, outDir);
      return [
        subpath,
        {
          types: output.replace(/\.tsx?$/, ".d.ts"),
          bun: source,
          ...(options.worker ? { worker: source } : {}),
          default: output.replace(/\.tsx?$/, ".js"),
        },
      ];
    }),
  );

  yield* fs.writeFileString(
    packageJsonPath,
    JSON.stringify(
      { ...packageJson, publishConfig: { ...packageJson.publishConfig, exports } },
      null,
      2,
    ) + "\n",
  );
});

const copyRepositoryFiles = Effect.fn(function* (packageDirectory: string, options: BuildOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* workspaceRoot;

  const files = [
    "LICENSE",
    "NOTICE",
    ...(options.thirdPartyLicenses ? ["THIRD_PARTY_LICENSES.md"] : []),
    ...(options.readme ? ["README.md"] : []),
  ];
  yield* Effect.forEach(files, (file) =>
    fs.copyFile(path.join(root, file), path.join(packageDirectory, file)),
  );
});

const writeStamp = Effect.fn(function* (packageDirectory: string, outDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(packageDirectory, outDir);
  yield* fs.makeDirectory(directory, { recursive: true });
  const at = yield* Effect.sync(() => new Date().toISOString());
  yield* fs.writeFileString(path.join(directory, stampFile), `${at}\n`);
});

const now = Effect.sync(() => Date.now());
const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

/** Build the package whose `scripts/` directory is `scriptsDirectory` (pass `import.meta.dirname`). */
export const build = (scriptsDirectory: string, options: BuildOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDirectory = path.resolve(scriptsDirectory, "..");
    const { name, version } = JSON.parse(
      yield* fs.readFileString(path.join(packageDirectory, "package.json")),
    ) as { name: string; version: string };

    const phases: Array<Step> = [
      {
        name: "sync package files",
        run: Effect.fn(function* (directory) {
          if (options.exports) yield* syncPublishExports(directory, options.exports);
          yield* copyRepositoryFiles(directory, options);
        }),
      },
      ...options.steps,
      ...(options.stamp
        ? [
            {
              name: "write build stamp",
              run: (directory: string) => writeStamp(directory, options.stamp!),
            },
          ]
        : []),
    ];

    yield* Console.log(`Building ${name}@${version}`);
    const startedAt = yield* now;
    const timings: Array<{ name: string; ms: number }> = [];
    for (const phase of phases) {
      const phaseStartedAt = yield* now;
      yield* phase.run(packageDirectory);
      timings.push({ name: phase.name, ms: (yield* now) - phaseStartedAt });
    }
    const total = (yield* now) - startedAt;

    const width = Math.max(...timings.map((timing) => timing.name.length));
    yield* Console.log(
      [
        `Built ${name} in ${formatSeconds(total)}`,
        ...timings.map(
          (timing) => `  ${timing.name.padEnd(width)}  ${formatSeconds(timing.ms).padStart(8)}`,
        ),
      ].join("\n"),
    );

    const cacheDirectory = path.join(packageDirectory, ".cache");
    yield* fs.makeDirectory(cacheDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(cacheDirectory, "build-timings.jsonl"),
      JSON.stringify({ at: new Date(startedAt).toISOString(), version, total, steps: timings }) +
        "\n",
      { flag: "a" },
    );
  }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
