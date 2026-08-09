import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

function git(args: string[], cwd: string, capture = true) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });

  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stderr);
    }
    process.exit(result.status ?? 1);
  }

  return result.stdout?.trim() ?? "";
}

const root = git(["rev-parse", "--show-toplevel"], process.cwd());
const gitDir = git(["rev-parse", "--path-format=absolute", "--git-dir"], root);
const commonDir = git(
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  root,
);

// The hook may run again for a checkout in the primary worktree.
if (gitDir === commonDir) {
  process.exit(0);
}

const desiredCommit = git(["rev-parse", "HEAD:distilled"], root);
const sharedRepository = resolve(commonDir, "modules/distilled");
const checkout = resolve(root, "distilled");

if (!existsSync(sharedRepository)) {
  console.error(
    "Cannot bootstrap distilled: the primary checkout has not initialized the distilled submodule.\n" +
      "Run `git submodule update --init -- distilled` in the primary checkout first.",
  );
  process.exit(1);
}

const objectExists =
  spawnSync("git", ["cat-file", "-e", `${desiredCommit}^{commit}`], {
    cwd: sharedRepository,
    stdio: "ignore",
  }).status === 0;

if (!objectExists) {
  console.log(`Fetching distilled commit ${desiredCommit}...`);
  git(["fetch", "origin", desiredCommit], sharedRepository, false);
}

if (existsSync(checkout)) {
  const checkoutMetadata = resolve(checkout, ".git");
  const checkoutGitDir = existsSync(checkoutMetadata)
    ? spawnSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: checkout, encoding: "utf8", stdio: "pipe" },
      )
    : undefined;

  if (checkoutGitDir?.status === 0) {
    if (checkoutGitDir.stdout.trim() !== sharedRepository) {
      console.error(
        `Cannot bootstrap distilled: ${checkout} belongs to a different Git repository.`,
      );
      process.exit(1);
    }

    const currentCommit = git(["rev-parse", "HEAD"], checkout);
    if (currentCommit === desiredCommit) {
      process.exit(0);
    }

    if (git(["status", "--porcelain"], checkout) !== "") {
      console.error(
        `Cannot update distilled to ${desiredCommit}: ${checkout} has uncommitted changes.`,
      );
      process.exit(1);
    }

    console.log(`Updating distilled to ${desiredCommit}...`);
    git(["checkout", "--detach", desiredCommit], checkout, false);
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
git(
  ["worktree", "add", "--detach", checkout, desiredCommit],
  sharedRepository,
  false,
);
