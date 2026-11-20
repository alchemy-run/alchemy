import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { exec } from "alchemy/Util/exec";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcess } from "effect/process";
import * as Semaphore from "effect/Semaphore";

/**
 * Upgrades from a released alchemy to this workspace, as a user makes them.
 *
 * A test deploys `fixtures/alchemy.run.ts` with the released CLI from a
 * project that has the released packages installed from npm, then with
 * this workspace's CLI from a project linked to the workspace packages,
 * both against the same state store. The two runs share a working directory
 * too, so a local store's `.alchemy/state` is shared like any other store.
 */

/** The last release before state encryption. Upgrades from it are the ones users make. */
export const RELEASED = "2.0.0-beta.85";

/** Outside the repository, so nothing resolves from the workspace by accident. */
const ROOT = "/tmp/alchemy-state-upgrade";

const FIXTURE = fileURLToPath(new URL("./fixtures/alchemy.run.ts", import.meta.url));

/** `packages/`; this file lives at `packages/integration-tests/test/StateUpgrade/`. */
const PACKAGES = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/$/, "");

/**
 * This checkout, so two worktrees running the suites at once never share a
 * linked project or a working directory.
 */
const CHECKOUT = createHash("sha256").update(PACKAGES).digest("hex").slice(0, 8);

/** The workspace's `effect`, which the linked packages resolve too. */
const WORKSPACE_DEPENDENCIES = ["effect", "@effect/platform-node", "@effect/platform-bun"];

export interface Project {
  /** `released` or `current`. */
  readonly label: string;
  readonly dir: string;
  /** The project's own copy of the fixture. */
  readonly main: string;
  readonly cli: string;
}

/**
 * The released packages a user of {@link RELEASED} has installed, at exact
 * versions so every run installs the same tree.
 */
const releasedDependencies = (version: string) => ({
  alchemy: version,
  "@alchemy.run/aws": version,
  "@alchemy.run/cloudflare": version,
  "@alchemy.run/gcp": version,
  "@alchemy.run/sql": version,
  effect: "4.1.0",
  "@effect/platform-node": "4.1.0",
  "@effect/platform-bun": "4.1.0",
  "@effect/sql-pg": "4.1.0",
  pg: "8.22.0",
});

const copyFixture = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.copyFile(FIXTURE, `${dir}/alchemy.run.ts`);
});

const manifest = (version: string) =>
  JSON.stringify({
    name: "alchemy-state-upgrade-released",
    private: true,
    type: "module",
    dependencies: releasedDependencies(version),
  });

/** Whether `dir` holds a finished install of exactly these dependencies. */
const installed = (dir: string, version: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      Effect.all([
        fs.readFileString(`${dir}/package.json`),
        fs.exists(`${dir}/node_modules/alchemy/package.json`),
      ]),
    ),
    Effect.map(([text, done]) => done && text === manifest(version)),
    Effect.orElseSucceed(() => false),
  );

/**
 * Suites run in one process and start together: setting up the shared
 * projects one at a time keeps one suite from reinstalling or relinking a
 * project another is running.
 */
const setup = Semaphore.makeUnsafe(1);

/**
 * A project with `version` installed from npm. The install happens once per
 * machine: it is made in a scratch directory and renamed into place, so an
 * interrupted install never leaves a half-installed tree behind.
 */
export const released = (version: string = RELEASED) =>
  setup.withPermits(1)(installReleased(version));

const installReleased = Effect.fn(function* (version: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${ROOT}/released-${version}`;
  if (!(yield* installed(dir, version))) {
    yield* fs.makeDirectory(ROOT, { recursive: true });
    const scratch = yield* fs.makeTempDirectory({ directory: ROOT, prefix: "install-" });
    yield* fs.writeFileString(`${scratch}/package.json`, manifest(version));
    const install = yield* exec(
      ChildProcess.make("bun", ["install"], { cwd: scratch, stdout: "pipe", stderr: "pipe" }),
    );
    if (install.exitCode !== 0) {
      return yield* Effect.die(`bun install of alchemy@${version} failed:\n${install.stderr}`);
    }
    yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
    yield* fs.rename(scratch, dir);
  }
  yield* copyFixture(dir);
  return {
    label: `released ${version}`,
    dir,
    main: `${dir}/alchemy.run.ts`,
    cli: `${dir}/node_modules/alchemy/bin/cli.js`,
  } satisfies Project;
});

/** A project whose `alchemy` and provider packages are links to this workspace. */
export const current = () => setup.withPermits(1)(linkCurrent());

const linkCurrent = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${ROOT}/current-${CHECKOUT}`;
  yield* fs.makeDirectory(`${dir}/node_modules/@alchemy.run`, { recursive: true });
  yield* fs.makeDirectory(`${dir}/node_modules/@effect`, { recursive: true });
  const link = Effect.fn(function* (name: string, target: string) {
    const path = `${dir}/node_modules/${name}`;
    const existing = yield* fs.readLink(path).pipe(Effect.orElseSucceed(() => undefined));
    if (existing === target) return;
    yield* fs.remove(path, { recursive: true }).pipe(Effect.ignore);
    yield* fs.symlink(target, path);
  });
  for (const pkg of ["alchemy", "aws", "cloudflare", "gcp", "sql"]) {
    yield* link(pkg === "alchemy" ? pkg : `@alchemy.run/${pkg}`, `${PACKAGES}/${pkg}`);
  }
  for (const dependency of WORKSPACE_DEPENDENCIES) {
    yield* link(dependency, yield* fs.realPath(`${PACKAGES}/alchemy/node_modules/${dependency}`));
  }
  yield* fs.writeFileString(
    `${dir}/package.json`,
    JSON.stringify({ name: "alchemy-state-upgrade-current", private: true, type: "module" }),
  );
  yield* copyFixture(dir);
  return {
    label: "current",
    dir,
    main: `${dir}/alchemy.run.ts`,
    cli: `${PACKAGES}/alchemy/bin/cli.js`,
  } satisfies Project;
});

/**
 * The working directory a test's runs share, emptied first. A local store
 * keeps its state here.
 */
export const workdir = Effect.fn(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${ROOT}/work/${CHECKOUT}/${name}`;
  yield* fs.remove(dir, { recursive: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(dir, { recursive: true });
  return dir;
});

export interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr together, for assertions on what the user sees. */
  readonly output: string;
}

export interface RunOptions {
  /** The shared working directory, from {@link workdir}. */
  readonly cwd: string;
  /** The fixture's `UPGRADE_*` settings. */
  readonly env: Record<string, string>;
  /** Run as a CI job does. */
  readonly ci?: boolean;
}

/** Stands for the project's copy of the fixture in a command's arguments. */
export const MAIN = "<main>";

/**
 * Run `alchemy <args>` with the project's CLI, {@link MAIN} replaced by the
 * project's copy of the fixture. The profile
 * comes from the test run's `ALCHEMY_PROFILE`, as a user's shell would
 * provide it.
 */
export const alchemy = Effect.fn(function* (
  project: Project,
  args: ReadonlyArray<string>,
  options: RunOptions,
) {
  const argv = args.map((arg) => (arg === MAIN ? project.main : arg));
  const result = yield* exec(
    ChildProcess.make("node", [project.cli, ...argv], {
      cwd: options.cwd,
      env: { ...options.env, CI: options.ci === true ? "true" : "false" },
      extendEnv: true,
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGKILL",
    }),
  );
  return {
    exitCode: Number(result.exitCode),
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}\n${result.stderr}`,
  } satisfies Run;
});

const describeRun = (project: Project, args: ReadonlyArray<string>, run: Run) =>
  `alchemy ${args.join(" ")} (${project.label}) exited ${run.exitCode}:\n${run.output}`;

/** Run `alchemy <args>`, failing the test with its output unless it succeeds. */
export const succeeds = Effect.fn(function* (
  project: Project,
  args: ReadonlyArray<string>,
  options: RunOptions,
) {
  const run = yield* alchemy(project, args, options);
  if (run.exitCode !== 0) return yield* Effect.die(describeRun(project, args, run));
  return run;
});

/** Run `alchemy <args>`, failing the test unless it fails. */
export const fails = Effect.fn(function* (
  project: Project,
  args: ReadonlyArray<string>,
  options: RunOptions,
) {
  const run = yield* alchemy(project, args, options);
  if (run.exitCode === 0) {
    return yield* Effect.die(`expected a failure, but ${describeRun(project, args, run)}`);
  }
  return run;
});

/** `deploy <main> --stage <stage> --yes`. */
export const deployArgs = (stage: string, ...extra: ReadonlyArray<string>) => [
  "deploy",
  MAIN,
  "--stage",
  stage,
  "--yes",
  ...extra,
];

/** The plan line of a deploy's output. */
export const planLine = (run: Run) => run.output.match(/Plan: [^\n]*/)?.[0];
