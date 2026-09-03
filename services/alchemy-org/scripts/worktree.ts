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
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { resolve } from "node:path";

const WORKTREES = ".alchemy/worktrees";
const BOOTSTRAP_DISTILLED = "scripts/bootstrap-distilled-worktree.ts";
const LOCK_WAIT_MS = 5 * 60_000;

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

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

/** One mutator at a time across every Worker request and session:
 *  `mkdir` is atomic, so the directory IS the lock. */
async function locked<A>(work: () => Promise<A>): Promise<A> {
  const lock = resolve(root, WORKTREES, ".lock");
  mkdirSync(resolve(root, WORKTREES), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > deadline) {
        fail(`another worktree operation has held ${lock} for over 5 minutes`);
      }
      await Bun.sleep(200);
    }
  }
  try {
    return await work();
  } finally {
    rmdirSync(lock);
  }
}

/** Never leave a distilled registration pointing at a tree that is
 *  gone — `worktree add` refuses the path until it is pruned. */
const pruneDistilled = () => tryGit(["worktree", "prune"], distilledRepo);

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
      if (present()) {
        // re-point onto the base: this is the session's own tree
        await git(["checkout", "--force", "-B", branch, base], treeDir);
      } else {
        await git(["worktree", "prune"], root);
        await git(["worktree", "add", "-B", branch, treePath, base], root);
      }
      await pruneDistilled();
      const bootstrap = await $`bun ${resolve(root, BOOTSTRAP_DISTILLED)}`
        .cwd(treeDir)
        .quiet()
        .nothrow();
      if (bootstrap.exitCode !== 0) {
        fail(
          `distilled bootstrap failed (${bootstrap.exitCode}): ${bootstrap.stderr.toString().trim() || bootstrap.stdout.toString().trim()}`,
        );
      }
      return describe();
    });
    console.log(JSON.stringify(result));
    break;
  }
  case "drop": {
    await locked(async () => {
      const branch = present()
        ? await tryGit(["rev-parse", "--abbrev-ref", "HEAD"], treeDir)
        : undefined;
      // already-gone is success: drops are idempotent
      await tryGit(["worktree", "remove", "--force", treePath], root);
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
    break;
  }
}
