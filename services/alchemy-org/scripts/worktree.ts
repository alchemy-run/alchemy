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
 * distilled bootstrap — under a single lock directory, so the Worker
 * needs no lock of its own: workerd cancels a request that merely waits
 * on another request's promise ("Promise will never complete"), which
 * rules out in-Worker semaphores; a process on the host has no such
 * rule, and a Worker request that is abandoned mid-way leaves the
 * process running to completion.
 */
import { $ } from "bun";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

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
 *  is reported at the top level — never `process.exit` mid-flight,
 *  which skips every `finally`. */
class Failure extends Error {}
const fail = (message: string): never => {
  throw new Failure(message);
};
// bun reports a rejected top-level await here (verified): the reason
// alone on stderr — the Worker shows it to the operator verbatim
process.on("uncaughtException", (error) => {
  process.stderr.write(
    `${error instanceof Failure ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

const slug = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");

async function git(args: string[], cwd: string): Promise<string> {
  const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
  if (result.exitCode !== 0) {
    fail(
      `git ${args.join(" ")} exited ${result.exitCode}: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
    );
  }
  return result.text().trim();
}

async function tryGit(
  args: string[],
  cwd: string,
): Promise<string | undefined> {
  const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
  return result.exitCode === 0 ? result.text().trim() : undefined;
}

const [verb, key, ...flags] = process.argv.slice(2);
if (
  (verb !== "ensure" && verb !== "get" && verb !== "drop") ||
  key === undefined
) {
  fail("usage: worktree.ts <ensure|get|drop> <key> [--ref <ref>] [--fresh]");
}
const refFlag = flags.indexOf("--ref");
const ref = refFlag === -1 ? undefined : flags[refFlag + 1];
const fresh = flags.includes("--fresh");

const root = await git(["rev-parse", "--show-toplevel"], process.cwd());
const common = await git(
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  root,
);
const distilledRepo = resolve(common, "modules/distilled");
const name = slug(key!);
const treePath = `${WORKTREES}/${name}`;
const treeDir = resolve(root, treePath);
/** The fallback branch — the session's own, when the ref is no branch. */
const synthetic = `ws/${name}`;

const describe = async () => ({
  root: treeDir,
  path: treePath,
  branch: await git(["rev-parse", "--abbrev-ref", "HEAD"], treeDir),
});

const present = () => existsSync(resolve(treeDir, ".git"));

/** Whether `branch` is checked out by a worktree OTHER than ours. */
async function heldElsewhere(branch: string): Promise<boolean> {
  const listing = await git(["worktree", "list", "--porcelain"], root);
  let dir: string | undefined;
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && dir !== treeDir) {
      return true;
    }
  }
  return false;
}

/** The branch the tree checks out for `ref` (see the header). */
async function branchFor(ref: string | undefined): Promise<string> {
  if (ref === undefined || /^pull\/\d+\/head$/.test(ref)) return synthetic;
  return (await heldElsewhere(ref)) ? synthetic : ref;
}

/** Whether a process with `pid` is alive (signal 0 probes without
 *  sending; EPERM means alive-but-not-ours). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** A lock nobody holds any more: its owner's pid is dead, or it never
 *  got as far as claiming it. A dev server restart, a killed `bun`, a
 *  crash between mkdir and finally — none may wedge every session
 *  after it behind a five-minute wait. */
const stale = (lock: string): boolean => {
  try {
    const pid = Number(readFileSync(resolve(lock, "pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 && !alive(pid);
  } catch {
    // no pid file yet: fresh (its owner is about to write it) or crashed
    try {
      return Date.now() - statSync(lock).mtimeMs > LOCK_UNCLAIMED_MS;
    } catch {
      return false; // gone between our looks — the next mkdir tells
    }
  }
};

/** One mutator at a time across every Worker request and session:
 *  `mkdir` is atomic, so the directory IS the lock; the pid inside
 *  says who holds it, so a dead holder's lock can be broken. */
async function locked<A>(work: () => Promise<A>): Promise<A> {
  const lock = resolve(root, WORKTREES, ".lock");
  mkdirSync(resolve(root, WORKTREES), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(resolve(lock, "pid"), `${process.pid}\n`);
      break;
    } catch {
      if (stale(lock)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        fail(`another worktree operation has held ${lock} for over 5 minutes`);
      }
      await Bun.sleep(200);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Never leave a distilled registration pointing at a tree that is
 *  gone — `worktree add` refuses the path until it is pruned. */
const pruneDistilled = () => tryGit(["worktree", "prune"], distilledRepo);

/** Give the tree its distilled checkout: a linked worktree of the
 *  shared `.git/modules/distilled` at the commit the tree pins, via
 *  the repo's own bootstrap script. A tree whose branch has no
 *  `submodules/distilled` (or no script) predates the submodule and
 *  is left as is — sessions there have no distilled, which is what
 *  that commit had. */
async function bootstrapDistilled(previous: string | undefined) {
  const script = resolve(treeDir, BOOTSTRAP_DISTILLED);
  const pinned = await tryGit(["rev-parse", `HEAD:${DISTILLED_PATH}`], treeDir);
  if (pinned === undefined || !existsSync(script)) {
    process.stderr.write(
      `${treePath}: no ${DISTILLED_PATH} at HEAD — skipping the distilled bootstrap\n`,
    );
    return;
  }
  // the hook's contract: <old HEAD> <new HEAD> 1 (a branch checkout);
  // the script roots itself at its own location, i.e. the tree
  const head = await git(["rev-parse", "HEAD"], treeDir);
  const bootstrap = await $`node ${script} ${previous ?? head} ${head} 1`
    .cwd(treeDir)
    .quiet()
    .nothrow();
  if (bootstrap.exitCode !== 0) {
    fail(
      `distilled bootstrap failed (${bootstrap.exitCode}): ${bootstrap.stderr.toString().trim() || bootstrap.stdout.toString().trim()}`,
    );
  }
}

switch (verb) {
  case "get": {
    console.log(JSON.stringify(present() ? await describe() : null));
    break;
  }
  case "ensure": {
    const result = await locked(async () => {
      if (present() && !fresh) return describe();
      // the base: a pinned ref is fetched so it is current (a PR head,
      // `pull/N/head`, lands at refs/remotes/origin/pull/N/head); no
      // ref means the workspace's own HEAD — no network
      let base: string;
      if (ref === undefined) {
        base = await git(["rev-parse", "HEAD"], root);
      } else {
        await git(
          ["fetch", "origin", `+${ref}:refs/remotes/origin/${ref}`],
          root,
        );
        base = `origin/${ref}`;
      }
      // -B (re)points the branch at the base; a remote-tracking base
      // sets the upstream, so `git push` needs no arguments
      const branch = await branchFor(ref);
      // the HEAD the tree is leaving (none on a fresh tree) — the
      // bootstrap follows distilled's pin from it to the new HEAD
      const previous = present()
        ? await tryGit(["rev-parse", "HEAD"], treeDir)
        : undefined;
      if (present()) {
        // re-point onto the base: this is the session's own tree
        await git(["checkout", "--force", "-B", branch, base], treeDir);
      } else {
        await git(["worktree", "prune"], root);
        await git(["worktree", "add", "-B", branch, treePath, base], root);
      }
      await pruneDistilled();
      await bootstrapDistilled(previous);
      return describe();
    });
    console.log(JSON.stringify(result));
    break;
  }
  case "drop": {
    let reap = false;
    await locked(async () => {
      const branch = present()
        ? await tryGit(["rev-parse", "--abbrev-ref", "HEAD"], treeDir)
        : undefined;
      // The tree's FILES are not deleted here. A tree that has seen a
      // `pnpm install` is hundreds of thousands of files, and `worktree
      // remove` unlinks them inline — tens of seconds per tree, under
      // the lock, on the thread DELETE that drops several. Moving the
      // directory aside is one rename; git's registration is pruned
      // against the now-missing path, and the files are reaped by a
      // detached process once the lock is released (below). Already
      // gone is success: drops are idempotent.
      if (existsSync(treeDir)) {
        renameSync(
          treeDir,
          resolve(root, WORKTREES, `${TRASH_PREFIX}${name}-${Date.now()}`),
        );
        reap = true;
      }
      await tryGit(["worktree", "prune"], root);
      // the synthetic branch was ours to mint and ours to drop; a REAL
      // branch (a PR's head) is only let go when nothing on it is
      // unpushed — `-d` refuses otherwise, and the branch stays
      await tryGit(["branch", "-D", synthetic], root);
      if (branch !== undefined && branch !== synthetic && branch !== "HEAD") {
        await tryGit(["branch", "-d", branch], root);
      }
      await pruneDistilled();
      await tryGit(["branch", "-D", synthetic], distilledRepo);
    });
    // the reaper: every trashed tree (this drop's and any earlier reap
    // that was cut short), in a process this one does not wait for —
    // the Worker's exec returns the moment the lock is free. Each
    // trash directory has a unique name, so a reaper can never take a
    // later drop's rename target out from under it.
    if (reap) {
      const trashed = readdirSync(resolve(root, WORKTREES))
        .filter((entry) => entry.startsWith(TRASH_PREFIX))
        .map((entry) => resolve(root, WORKTREES, entry));
      Bun.spawn(["rm", "-rf", ...trashed], {
        stdio: ["ignore", "ignore", "ignore"],
      }).unref();
    }
    break;
  }
}
