/**
 * Session worktrees for `alchemy dev` — the host half of
 * `src/sandbox/CheckoutsWorktree.ts`. Run at the repository root (the
 * dev sandbox's root) by the Worker, over the sandbox's `exec`:
 *
 * ```
 * bun services/alchemy-org/scripts/worktree.ts ensure <key> [--ref <ref>] [--fresh]
 * bun services/alchemy-org/scripts/worktree.ts get <key>
 * bun services/alchemy-org/scripts/worktree.ts drop <key>
 * ```
 *
 * `ensure`/`get` print the tree as JSON (`{ root, path, branch }`;
 * `get` prints `null` when there is none); `drop` prints nothing.
 * Failures exit non-zero with the reason on stderr.
 *
 * An Effect program over the platform services (`FileSystem`, `Path`,
 * `ChildProcess`), provided by `BunServices` — the exec harness runs
 * it under bun, but the code is platform-agnostic except the ONE
 * `clonefile(2)` leaf (see {@link cloneTree}).
 *
 * THE BRANCH: a `--ref` that names a branch on origin (a pull request's
 * head in this repository) is checked out AS THAT BRANCH, tracking
 * `origin/<ref>` — `git status` says the PR's name and `git push` lands
 * in the PR, the same as the microVM sandbox (CheckoutsSandbox.ts).
 * A synthetic `ws/<key>` branch is minted only where no real branch can
 * be taken: no ref (the tree bases on the workspace's own HEAD, whose
 * branch this checkout holds), a fork's `pull/N/head` (not a branch),
 * or a branch already checked out in another worktree (git refuses).
 *
 * ONE process does the whole job — fetch, `worktree add`, the
 * distilled bootstrap, the node_modules seed — under a single lock
 * directory, so the Worker needs no lock of its own: workerd cancels a
 * request that merely waits on another request's promise ("Promise
 * will never complete"), which rules out in-Worker semaphores; a
 * process on the host has no such rule, and a Worker request that is
 * abandoned mid-way leaves the process running to completion.
 */
import { BunServices } from "@effect/platform-bun";
// the ONE non-node import: node exposes no directory clone (only the
// per-file COPYFILE_FICLONE flag, measured 5x slower over 222k files),
// so the clonefile(2) syscall is reached through bun's FFI — the exec
// harness (CheckoutsWorktree.ts) runs this script under bun regardless
import { dlopen, FFIType, suffix } from "bun:ffi";
import { spawn } from "node:child_process";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";

const WORKTREES = ".alchemy/worktrees";
/** A dropped tree's files wait for the reaper under this prefix, beside
 *  the live trees (see `drop`). */
const TRASH_PREFIX = ".trash-";
/** The repo's own distilled bootstrap (the `post-checkout` hook's
 *  script), run from the TREE's copy so it matches the tree's layout. */
const BOOTSTRAP_DISTILLED = "scripts/bootstrap-distilled.mjs";
/** Where the tree pins distilled — absent on a branch that predates
 *  the submodule (nothing to bootstrap then). */
const DISTILLED_PATH = "submodules/distilled";
const LOCK_WAIT_MS = 5 * 60_000;
/** A lock whose owner has not written its pid by now is a crashed
 *  mkdir — the pid file follows the mkdir within the same tick. */
const LOCK_UNCLAIMED_MS = 5_000;

/** A failure UNWINDS (so a held lock is released on the way out) and
 *  is reported at the top level — its reason alone on stderr, exit 1:
 *  the Worker shows stderr to the operator verbatim. */
class Failure extends Data.TaggedError("Failure")<{
  readonly message: string;
}> {}

const slug = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");

/** One clonefile(2) — APFS copy-on-write: a directory hierarchy is
 *  cloned in one syscall, sharing every data block with the source
 *  (~10s / ~75MB for this repo's 3.2GB root node_modules, vs ~30s /
 *  ~180MB for a store-hardlinking `pnpm install`), and writes stay
 *  private to the clone (no hardlink write-through). Darwin-only. */
const cloneTree = (() => {
  if (process.platform !== "darwin") return undefined;
  const lib = dlopen(`libSystem.${suffix}`, {
    clonefile: {
      args: [FFIType.cstring, FFIType.cstring, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  return (src: string, dst: string) =>
    Effect.sync(
      () =>
        lib.symbols.clonefile(
          Buffer.from(`${src}\0`, "utf8"),
          Buffer.from(`${dst}\0`, "utf8"),
          0,
        ) === 0,
    );
})();

const [verb, key, ...flags] = process.argv.slice(2);

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (
    (verb !== "ensure" && verb !== "get" && verb !== "drop") ||
    key === undefined
  ) {
    return yield* new Failure({
      message: "usage: worktree.ts <ensure|get|drop> <key> [--ref <ref>] [--fresh]",
    });
  }
  const refFlag = flags.indexOf("--ref");
  const ref = refFlag === -1 ? undefined : flags[refFlag + 1];
  const fresh = flags.includes("--fresh");

  /** Run one process to completion; captured output, any exit code.
   *  Spawn errors (missing cwd, missing binary) are failures too. */
  const run = Effect.fn(function* (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ) {
    const outcome = yield* Effect.result(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make(command, args, { cwd });
          const [exitCode, stdout, stderr] = yield* Effect.all(
            [
              handle.exitCode,
              Stream.mkString(Stream.decodeText(handle.stdout)),
              Stream.mkString(Stream.decodeText(handle.stderr)),
            ] as const,
            { concurrency: 3 },
          );
          return {
            exitCode,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          };
        }),
      ),
    );
    if (Result.isFailure(outcome)) {
      return yield* new Failure({
        message: `${command} ${args.join(" ")}: ${String(outcome.failure)}`,
      });
    }
    return outcome.success;
  });

  const git = Effect.fn(function* (
    args: ReadonlyArray<string>,
    cwd: string,
  ) {
    const result = yield* run("git", args, cwd);
    if (result.exitCode !== 0) {
      return yield* new Failure({
        message: `git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr || result.stdout}`,
      });
    }
    return result.stdout;
  });

  const tryGit = (args: ReadonlyArray<string>, cwd: string) =>
    git(args, cwd).pipe(Effect.option);

  const note = (message: string) =>
    Effect.sync(() => process.stderr.write(`${message}\n`));
  const print = (value: unknown) =>
    Effect.sync(() => console.log(JSON.stringify(value)));
  const now = Effect.sync(() => Date.now());
  const exists = (target: string) => fs.exists(target).pipe(Effect.orDie);

  const cwd = yield* Effect.sync(() => process.cwd());
  const root = yield* git(["rev-parse", "--show-toplevel"], cwd);
  const common = yield* git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    root,
  );
  const distilledRepo = path.resolve(common, "modules/distilled");
  const name = slug(key);
  const treePath = `${WORKTREES}/${name}`;
  const treeDir = path.resolve(root, treePath);
  const worktreesDir = path.resolve(root, WORKTREES);
  const lockDir = path.resolve(worktreesDir, ".lock");
  /** The fallback branch — the session's own, when the ref is no branch. */
  const synthetic = `ws/${name}`;

  const present = exists(path.resolve(treeDir, ".git"));

  const describe = Effect.gen(function* () {
    return {
      root: treeDir,
      path: treePath,
      branch: yield* git(["rev-parse", "--abbrev-ref", "HEAD"], treeDir),
    };
  });

  /** Whether `branch` is checked out by a worktree OTHER than ours. */
  const heldElsewhere = Effect.fn(function* (branch: string) {
    const listing = yield* git(["worktree", "list", "--porcelain"], root);
    let dir: string | undefined;
    for (const line of listing.split("\n")) {
      if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
      else if (line === `branch refs/heads/${branch}` && dir !== treeDir) {
        return true;
      }
    }
    return false;
  });

  /** The branch the tree checks out for `ref` (see the header). */
  const branchFor = Effect.fn(function* (wanted: string | undefined) {
    if (wanted === undefined || /^pull\/\d+\/head$/.test(wanted)) {
      return synthetic;
    }
    return (yield* heldElsewhere(wanted)) ? synthetic : wanted;
  });

  /** Whether a process with `pid` is alive (signal 0 probes without
   *  sending; EPERM means alive-but-not-ours). */
  const alive = (pid: number) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    });

  /** A lock nobody holds any more: its owner's pid is dead, or it never
   *  got as far as claiming it. A dev server restart, a killed run, a
   *  crash between mkdir and the release — none may wedge every session
   *  after it behind a five-minute wait. */
  const stale = Effect.gen(function* () {
    const pidText = yield* fs
      .readFileString(path.resolve(lockDir, "pid"))
      .pipe(Effect.option);
    if (Option.isSome(pidText)) {
      const pid = Number(pidText.value.trim());
      return Number.isInteger(pid) && pid > 0 && !(yield* alive(pid));
    }
    // no pid file yet: fresh (its owner is about to write it) or crashed
    const info = yield* fs.stat(lockDir).pipe(Effect.option);
    if (Option.isNone(info)) return false; // gone between our looks
    const mtime = Option.getOrUndefined(info.value.mtime);
    return (
      mtime !== undefined && (yield* now) - mtime.getTime() > LOCK_UNCLAIMED_MS
    );
  });

  /** One mutator at a time across every Worker request and session:
   *  `makeDirectory` (non-recursive) is atomic, so the directory IS the
   *  lock; the pid inside says who holds it, so a dead holder's lock
   *  can be broken. */
  const acquireLock = Effect.gen(function* () {
    yield* fs.makeDirectory(worktreesDir, { recursive: true }).pipe(Effect.orDie);
    const deadline = (yield* now) + LOCK_WAIT_MS;
    for (;;) {
      const claimed = yield* Effect.result(fs.makeDirectory(lockDir));
      if (Result.isSuccess(claimed)) {
        yield* fs
          .writeFileString(path.resolve(lockDir, "pid"), `${process.pid}\n`)
          .pipe(Effect.orDie);
        return;
      }
      if (yield* stale) {
        yield* fs
          .remove(lockDir, { recursive: true, force: true })
          .pipe(Effect.ignore);
        continue;
      }
      if ((yield* now) > deadline) {
        return yield* new Failure({
          message: `another worktree operation has held ${lockDir} for over 5 minutes`,
        });
      }
      yield* Effect.sleep("200 millis");
    }
  });
  const releaseLock = fs
    .remove(lockDir, { recursive: true, force: true })
    .pipe(Effect.ignore);
  const locked = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    acquireLock.pipe(
      Effect.flatMap(() => work.pipe(Effect.ensuring(releaseLock))),
    );

  /** Never leave a distilled registration pointing at a tree that is
   *  gone — `worktree add` refuses the path until it is pruned. */
  const pruneDistilled = tryGit(["worktree", "prune"], distilledRepo);

  /** Give the tree its distilled checkout: a linked worktree of the
   *  shared `.git/modules/distilled` at the commit the tree pins, via
   *  the repo's own bootstrap script. A tree whose branch has no
   *  `submodules/distilled` (or no script) predates the submodule and
   *  is left as is — sessions there have no distilled, which is what
   *  that commit had. */
  const bootstrapDistilled = Effect.fn(function* (
    previous: string | undefined,
  ) {
    const script = path.resolve(treeDir, BOOTSTRAP_DISTILLED);
    const pinned = yield* tryGit(
      ["rev-parse", `HEAD:${DISTILLED_PATH}`],
      treeDir,
    );
    if (Option.isNone(pinned) || !(yield* exists(script))) {
      yield* note(
        `${treePath}: no ${DISTILLED_PATH} at HEAD — skipping the distilled bootstrap`,
      );
      return;
    }
    // the hook's contract: <old HEAD> <new HEAD> 1 (a branch checkout);
    // the script roots itself at its cwd, i.e. the tree
    const head = yield* git(["rev-parse", "HEAD"], treeDir);
    const bootstrap = yield* run(
      "node",
      [script, previous ?? head, head, "1"],
      treeDir,
    );
    if (bootstrap.exitCode !== 0) {
      return yield* new Failure({
        message: `distilled bootstrap failed (${bootstrap.exitCode}): ${bootstrap.stderr || bootstrap.stdout}`,
      });
    }
  });

  /** Seed the tree's `node_modules` from the workspace's: for every
   *  package.json the TREE tracks (superproject and distilled), clone
   *  the workspace's sibling node_modules if the tree has none yet.
   *  The session's `pnpm install` then finds the workspace's installed
   *  (and already script-built) state and reconciles only the tree's
   *  own lockfile delta. Best-effort: a tree without seeding is merely
   *  slower, never wrong — failures are noted, never fatal. */
  const seedNodeModules = Effect.gen(function* () {
    if (cloneTree === undefined) return;
    const started = yield* now;
    let cloned = 0;
    let failed = 0;
    const repos = [[treeDir, root]];
    const distilledTree = path.resolve(treeDir, DISTILLED_PATH);
    if (yield* exists(path.resolve(distilledTree, ".git"))) {
      repos.push([distilledTree, path.resolve(root, DISTILLED_PATH)]);
    }
    for (const [tree, source] of repos) {
      const manifests = yield* tryGit(
        ["ls-files", "package.json", "*/package.json"],
        tree!,
      );
      if (Option.isNone(manifests)) continue;
      for (const manifest of manifests.value.split("\n")) {
        if (manifest === "") continue;
        const dir = path.dirname(manifest);
        const src = path.resolve(source!, dir, "node_modules");
        const dst = path.resolve(tree!, dir, "node_modules");
        if (!(yield* exists(src))) continue;
        if (yield* exists(dst)) continue;
        if (!(yield* exists(path.dirname(dst)))) continue;
        if (yield* cloneTree(src, dst)) cloned++;
        else failed++;
      }
    }
    if (cloned > 0 || failed > 0) {
      yield* note(
        `${treePath}: seeded ${cloned} node_modules in ${(yield* now) - started}ms${failed > 0 ? ` (${failed} failed)` : ""}`,
      );
    }
  });

  switch (verb) {
    case "get": {
      yield* print((yield* present) ? yield* describe : null);
      return;
    }
    case "ensure": {
      const result = yield* locked(
        Effect.gen(function* () {
          if ((yield* present) && !fresh) {
            // adopted as-is — but a tree dropped mid-provision (or made
            // by an older script) may still lack its node_modules seed
            yield* seedNodeModules;
            return yield* describe;
          }
          // the base: a pinned ref is fetched so it is current (a PR
          // head, `pull/N/head`, lands at refs/remotes/origin/pull/N/
          // head); no ref means the workspace's own HEAD — no network
          let base: string;
          if (ref === undefined) {
            base = yield* git(["rev-parse", "HEAD"], root);
          } else {
            yield* git(
              ["fetch", "origin", `+${ref}:refs/remotes/origin/${ref}`],
              root,
            );
            base = `origin/${ref}`;
          }
          // -B (re)points the branch at the base; a remote-tracking base
          // sets the upstream, so `git push` needs no arguments
          const branch = yield* branchFor(ref);
          // the HEAD the tree is leaving (none on a fresh tree) — the
          // bootstrap follows distilled's pin from it to the new HEAD
          const previous = (yield* present)
            ? Option.getOrUndefined(yield* tryGit(["rev-parse", "HEAD"], treeDir))
            : undefined;
          if (yield* present) {
            // re-point onto the base: this is the session's own tree
            yield* git(["checkout", "--force", "-B", branch, base], treeDir);
          } else {
            yield* git(["worktree", "prune"], root);
            yield* git(["worktree", "add", "-B", branch, treePath, base], root);
          }
          yield* pruneDistilled;
          yield* bootstrapDistilled(previous);
          yield* seedNodeModules;
          return yield* describe;
        }),
      );
      yield* print(result);
      return;
    }
    case "drop": {
      const reap = yield* locked(
        Effect.gen(function* () {
          const branch = (yield* present)
            ? Option.getOrUndefined(
                yield* tryGit(["rev-parse", "--abbrev-ref", "HEAD"], treeDir),
              )
            : undefined;
          // The tree's FILES are not deleted here. A tree that has seen
          // a `pnpm install` (or the node_modules seed) is hundreds of
          // thousands of files, and `worktree remove` unlinks them
          // inline — tens of seconds per tree, under the lock, on the
          // thread DELETE that drops several. Moving the directory
          // aside is one rename; git's registration is pruned against
          // the now-missing path, and the files are reaped by a
          // detached process once the lock is released (below). Already
          // gone is success: drops are idempotent.
          let moved = false;
          if (yield* exists(treeDir)) {
            yield* fs
              .rename(
                treeDir,
                path.resolve(
                  worktreesDir,
                  `${TRASH_PREFIX}${name}-${yield* now}`,
                ),
              )
              .pipe(Effect.orDie);
            moved = true;
          }
          yield* tryGit(["worktree", "prune"], root);
          // the synthetic branch was ours to mint and ours to drop; a
          // REAL branch (a PR's head) is only let go when nothing on it
          // is unpushed — `-d` refuses otherwise, and the branch stays
          yield* tryGit(["branch", "-D", synthetic], root);
          if (
            branch !== undefined &&
            branch !== synthetic &&
            branch !== "HEAD"
          ) {
            yield* tryGit(["branch", "-d", branch], root);
          }
          yield* pruneDistilled;
          yield* tryGit(["branch", "-D", synthetic], distilledRepo);
          return moved;
        }),
      );
      // the reaper: every trashed tree (this drop's and any earlier reap
      // that was cut short), in a process this one does not wait for —
      // the Worker's exec returns the moment the lock is free. Each
      // trash directory has a unique name, so a reaper can never take a
      // later drop's rename target out from under it. Detached+unref is
      // exactly what the platform ChildProcess (scoped to THIS process)
      // must not do, so this one spawn is the raw node primitive.
      if (reap) {
        const entries = yield* fs.readDirectory(worktreesDir).pipe(Effect.orDie);
        const trashed = entries
          .filter((entry) => entry.startsWith(TRASH_PREFIX))
          .map((entry) => path.resolve(worktreesDir, entry));
        yield* Effect.sync(() => {
          spawn("rm", ["-rf", ...trashed], {
            detached: true,
            stdio: "ignore",
          }).unref();
        });
      }
      return;
    }
  }
});

// a Failure is the script's ONE reportable outcome: reason on stderr,
// exit 1 — the Worker (CheckoutsWorktree.ts) surfaces it verbatim.
// Anything else (a defect) is environmental and reported as-is.
const main = program.pipe(
  Effect.catchTag("Failure", (failure: Failure) =>
    Effect.sync(() => {
      process.stderr.write(`${failure.message}\n`);
      process.exitCode = 1;
    }),
  ),
  Effect.provide(BunServices.layer),
);

Effect.runPromise(main as Effect.Effect<void>).catch((defect) => {
  process.stderr.write(`${String(defect)}\n`);
  process.exit(1);
});
