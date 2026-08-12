import { $ } from "bun";
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { resolve } from "node:path";

async function git(args: string[], cwd: string, capture = true) {
  const command = $`git ${args}`.cwd(cwd).nothrow();
  const result = capture ? await command.quiet() : await command;

  if (result.exitCode !== 0) {
    if (capture) {
      process.stderr.write(result.stderr);
    }
    process.exit(result.exitCode);
  }

  return result.text().trim();
}

async function tryGit(args: string[], cwd: string) {
  const result = await $`git ${args}`.cwd(cwd).quiet().nothrow();
  return result.exitCode === 0 ? result.text().trim() : undefined;
}

const root = await git(["rev-parse", "--show-toplevel"], process.cwd());
const gitDir = await git(
  ["rev-parse", "--path-format=absolute", "--git-dir"],
  root,
);
const commonDir = await git(
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  root,
);

// The hook may run again for a checkout in the primary worktree.
if (gitDir === commonDir) {
  process.exit(0);
}

const desiredCommit = await git(["rev-parse", "HEAD:distilled"], root);
const sharedRepository = resolve(commonDir, "modules/distilled");
const checkout = resolve(root, "distilled");

// Mirror the parent worktree's branch onto the distilled worktree so it isn't
// left on a dangling detached HEAD. A detached parent stays detached.
const desiredBranch = await tryGit(
  ["symbolic-ref", "--short", "-q", "HEAD"],
  root,
);

async function branchInUseElsewhere(): Promise<boolean> {
  const list = await tryGit(
    ["worktree", "list", "--porcelain"],
    sharedRepository,
  );
  return (
    list !== undefined &&
    list.split("\n").includes(`branch refs/heads/${desiredBranch}`)
  );
}

if (!existsSync(sharedRepository)) {
  console.error(
    "Cannot bootstrap distilled: the primary checkout has not initialized the distilled submodule.\n" +
      "Run `git submodule update --init -- distilled` in the primary checkout first.",
  );
  process.exit(1);
}

const objectExists =
  (await tryGit(
    ["cat-file", "-e", `${desiredCommit}^{commit}`],
    sharedRepository,
  )) !== undefined;

if (!objectExists) {
  console.log(`Fetching distilled commit ${desiredCommit}...`);
  await git(["fetch", "origin", desiredCommit], sharedRepository, false);
}

if (existsSync(checkout)) {
  const checkoutGitDir = existsSync(resolve(checkout, ".git"))
    ? await tryGit(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        checkout,
      )
    : undefined;

  if (checkoutGitDir !== undefined) {
    if (checkoutGitDir !== sharedRepository) {
      console.error(
        `Cannot bootstrap distilled: ${checkout} belongs to a different Git repository.`,
      );
      process.exit(1);
    }

    const currentCommit = await git(["rev-parse", "HEAD"], checkout);
    const currentBranch = await tryGit(
      ["symbolic-ref", "--short", "-q", "HEAD"],
      checkout,
    );
    if (currentCommit === desiredCommit) {
      if (
        desiredBranch !== undefined &&
        currentBranch !== desiredBranch &&
        !(await branchInUseElsewhere())
      ) {
        // Same commit, wrong (or detached) HEAD — just move the branch over.
        await git(
          ["checkout", "-B", desiredBranch, desiredCommit],
          checkout,
          false,
        );
      }
      process.exit(0);
    }

    if ((await git(["status", "--porcelain"], checkout)) !== "") {
      console.error(
        `Cannot update distilled to ${desiredCommit}: ${checkout} has uncommitted changes.`,
      );
      process.exit(1);
    }

    console.log(`Updating distilled to ${desiredCommit}...`);
    if (
      desiredBranch !== undefined &&
      (currentBranch === desiredBranch || !(await branchInUseElsewhere()))
    ) {
      await git(
        ["checkout", "-B", desiredBranch, desiredCommit],
        checkout,
        false,
      );
    } else {
      await git(["checkout", "--detach", desiredCommit], checkout, false);
    }
    process.exit(0);
  }

  if (readdirSync(checkout).length !== 0) {
    console.error(
      `Cannot bootstrap distilled: ${checkout} exists and is not an empty directory.`,
    );
    process.exit(1);
  }

  rmdirSync(checkout);
}

console.log(`Creating distilled worktree at ${desiredCommit}...`);
await git(
  desiredBranch !== undefined && !(await branchInUseElsewhere())
    ? ["worktree", "add", "-B", desiredBranch, checkout, desiredCommit]
    : ["worktree", "add", "--detach", checkout, desiredCommit],
  sharedRepository,
  false,
);
