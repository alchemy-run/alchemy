// Rebuilds workspace packages whose build output is missing or stale.
//
// Some packages are consumed from their build output even in the
// workspace: cloudflare-runtime's source imports its bundled workers from
// `dist/`, and frontend-frameworks only exports `dist/`. Commands that need
// them (tests, type checking, local deploys) run `ensure` first, which is a
// no-op unless a package or one of its workspace dependencies changed since
// its last build.
//
// Every successful `build:package` of these packages runs `stamp`
// (`postbuild:package`), recording the build in `<outDir>/.build-stamp`.
// A package is stale when that stamp is missing or older than any tracked or
// untracked-but-not-ignored file of the package or its workspace
// dependencies, test files excepted.
//
// Usage:
//   pnpm -w ensure:built                 # rebuild stale packages
//   pnpm -w build:stamp <package>        # from a package's postbuild:package
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command } from "effect/cli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

/** Packages consumed from their build output, by directory name under packages/. */
const packages = {
  "cloudflare-runtime": { outDir: "dist" },
  "frontend-frameworks": { outDir: "dist" },
} as const;

type PackageName = keyof typeof packages;
const packageNames = Object.keys(packages) as Array<PackageName>;

const stampFile = ".build-stamp";

/** Changes to tests never affect build output. */
const isTestFile = (file: string) =>
  /(^|\/)(test|tests|__tests__)\//.test(file) || /\.test\.[cm]?[jt]sx?$/.test(file);

const workspaceRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(import.meta.dirname, "..");
});

/** Directories of a package and all of its workspace dependencies. */
const dependencyDirectories = Effect.fn(function* (root: string, name: PackageName) {
  const spawner = yield* ChildProcessSpawner;
  const output = yield* spawner.string(
    ChildProcess.make(
      "pnpm",
      ["ls", "-r", "--filter", `{./packages/${name}}...`, "--depth", "-1", "--json"],
      { cwd: root },
    ),
  );
  return (JSON.parse(output) as Array<{ path: string }>).map((project) => project.path);
});

/** Newest modification time across a directory's source files. */
const newestSourceTime = Effect.fn(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;

  // `git -C` also works inside submodules, which the parent repo can't list.
  const files = yield* spawner.lines(
    ChildProcess.make(
      "git",
      ["-C", directory, "ls-files", "--cached", "--others", "--exclude-standard", "."],
      { cwd: directory },
    ),
  );
  const times = yield* Effect.forEach(
    files.filter((file) => file !== "" && !isTestFile(file)),
    (file) =>
      fs.stat(path.join(directory, file)).pipe(
        Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
        // Deleted but still-tracked files have nothing to compare.
        Effect.orElseSucceed(() => 0),
      ),
    { concurrency: 64 },
  );
  return Math.max(0, ...times);
});

const stampTime = Effect.fn(function* (root: string, name: PackageName) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.stat(path.join(root, "packages", name, packages[name].outDir, stampFile)).pipe(
    Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
    Effect.option,
  );
});

const isStale = Effect.fn(function* (root: string, name: PackageName) {
  const stamp = yield* stampTime(root, name);
  if (Option.isNone(stamp)) return true;
  const directories = yield* dependencyDirectories(root, name);
  const newest = yield* Effect.forEach(directories, newestSourceTime, { concurrency: "unbounded" });
  return Math.max(...newest) > stamp.value;
});

const ensure = Command.make(
  "ensure",
  {
    packages: Argument.Literals("package", packageNames).pipe(
      Argument.withDescription("Packages to check (defaults to all output-consumed packages)"),
      Argument.atLeast(0),
    ),
  },
  Effect.fn(function* ({ packages: selected }) {
    const root = yield* workspaceRoot;
    const spawner = yield* ChildProcessSpawner;

    const candidates = selected.length > 0 ? selected : packageNames;
    const stale = yield* Effect.filter(candidates, (name) => isStale(root, name), {
      concurrency: "unbounded",
    });
    if (stale.length === 0) return;

    yield* Effect.logInfo(`Rebuilding stale packages: ${stale.join(", ")}`);
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(
        "pnpm",
        [
          "-r",
          ...stale.flatMap((name) => ["--filter", `{./packages/${name}}...`]),
          "run",
          "build:package",
        ],
        { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      ),
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(new Error(`Build failed with exit code ${exitCode}`));
    }
  }),
).pipe(Command.withDescription("Rebuild packages whose build output is missing or stale"));

const stamp = Command.make(
  "stamp",
  {
    package: Argument.Literals("package", packageNames).pipe(
      Argument.withDescription("Package whose build just finished"),
    ),
  },
  Effect.fn(function* ({ package: name }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* workspaceRoot;
    const outDir = path.join(root, "packages", name, packages[name].outDir);
    yield* fs.makeDirectory(outDir, { recursive: true });
    yield* fs.writeFileString(path.join(outDir, stampFile), `${new Date().toISOString()}\n`);
  }),
).pipe(Command.withDescription("Record a successful build of a package"));

const command = Command.make("ensure-built").pipe(
  Command.withDescription("Keep build-output-consumed workspace packages up to date"),
  Command.withSubcommands([ensure, stamp]),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
