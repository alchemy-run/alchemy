// Rebuilds workspace packages whose build output is missing or stale.
//
// Some packages are consumed from their build output even in the
// workspace: cloudflare-runtime's source imports its bundled workers from
// `dist/`, and frontend-frameworks only exports `dist/`. Commands that need
// them (tests, type checking, local deploys) run `ensure` first, which is a
// no-op unless a package or one of its workspace dependencies changed since
// its last build.
//
// Every successful build of these packages records itself in
// `<outDir>/.build-stamp` (see package-build.ts). A package is stale when
// that stamp is missing or older than any tracked or untracked-but-not-ignored
// file of the package or its workspace dependencies, test files excepted.
//
// It also re-bundles distilled packages whose `lib/` the root `tsc -b`
// emitted but distilled's `bundle-lib` has not yet bundled (see
// `staleDistilledBundles`).
//
// Usage: pnpm -w ensure:built [package...]
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command } from "effect/cli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { stampFile } from "./package-build.ts";

/** Packages consumed from their build output, by directory name under packages/. */
const packages = {
  "cloudflare-runtime": { outDir: "dist" },
  "frontend-frameworks": { outDir: "dist" },
} as const;

// pnpm may be a `.cmd` shim on Windows, which only a shell can run.
const shell = process.platform === "win32";

type PackageName = keyof typeof packages;
const packageNames = Object.keys(packages) as Array<PackageName>;

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
      [
        "ls",
        "-r",
        "--filter",
        `{./packages/${name}}...`,
        "--depth",
        "-1",
        "--json",
        "--loglevel",
        "error",
      ],
      { cwd: root, shell },
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
      { cwd: directory, shell },
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

/**
 * distilled packages are emitted into their `lib/` by the root `tsc -b`, but
 * bundlers (a Lambda or Worker build) resolve them through the
 * `lib/services.full/` entry chunks that only distilled's own `bundle-lib`
 * step writes. A package is stale when it has a `lib/` but no bundle, or when
 * `tsc` re-emitted it (its `tsconfig.tsbuildinfo`) after the last bundle.
 */
const distilledBundleStamp = ".bundle-stamp";

const staleDistilledBundles = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packagesDir = path.join(root, "submodules", "distilled", "packages");
  if (!(yield* fs.exists(packagesDir))) return [];
  const mtime = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => Option.getOrElse(info.mtime, () => new Date(0)).getTime()),
      Effect.option,
    );
  const names = yield* fs.readDirectory(packagesDir);
  return yield* Effect.filter(
    names.filter((name) => name !== "core"),
    Effect.fn(function* (name) {
      const dir = path.join(packagesDir, name);
      if (!(yield* fs.exists(path.join(dir, "lib")))) return false;
      if (!(yield* fs.exists(path.join(dir, "src", "services")))) return false;
      const stamp = yield* mtime(path.join(dir, "lib", distilledBundleStamp));
      if (Option.isNone(stamp)) return true;
      const emitted = yield* mtime(path.join(dir, "tsconfig.tsbuildinfo"));
      return Option.isSome(emitted) && emitted.value > stamp.value;
    }),
    { concurrency: "unbounded" },
  );
});

const bundleDistilled = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;
  const stale = yield* staleDistilledBundles(root);
  if (stale.length === 0) return;
  yield* Effect.logInfo(`Bundling distilled packages: ${stale.join(", ")}`);
  const distilled = path.join(root, "submodules", "distilled");
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(
      "node",
      ["scripts/bundle-lib.ts", ...stale.map((name) => `packages/${name}`)],
      { cwd: distilled, shell, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
    ),
  );
  if (exitCode !== 0) {
    return yield* Effect.fail(new Error(`distilled bundle-lib failed with exit code ${exitCode}`));
  }
  yield* Effect.forEach(stale, (name) =>
    fs.writeFileString(
      path.join(distilled, "packages", name, "lib", distilledBundleStamp),
      new Date().toISOString(),
    ),
  );
});

const command = Command.make(
  "ensure-built",
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
    if (stale.length === 0) return yield* bundleDistilled(root);

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
        { cwd: root, shell, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
      ),
    );
    if (exitCode !== 0) {
      return yield* Effect.fail(new Error(`Build failed with exit code ${exitCode}`));
    }
    yield* bundleDistilled(root);
  }),
).pipe(Command.withDescription("Rebuild packages whose build output is missing or stale"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
