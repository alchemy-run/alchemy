import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

// Git hooks export repository-specific variables. Do not pass those through to
// commands operating on distilled or a different Alchemy worktree.
const env = { ...process.env };
for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")) {
  delete env[name];
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function tryGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function bootstrap(root, previousHead) {
  // Use the index, just like `git submodule update`, including a staged pin.
  const pin = git(["rev-parse", ":submodules/distilled"], root);
  const checkout = resolve(root, "submodules/distilled");
  const commonDir = git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    root,
  );
  const gitDir = git(
    ["rev-parse", "--path-format=absolute", "--git-dir"],
    root,
  );

  if (existsSync(resolve(checkout, ".git"))) {
    if (
      realpathSync(git(["rev-parse", "--show-toplevel"], checkout)) !==
      realpathSync(checkout)
    ) {
      throw new Error(
        `Cannot bootstrap distilled: invalid checkout at ${checkout}`,
      );
    }
    const current = git(["rev-parse", "HEAD"], checkout);
    if (current === pin) return;

    const previousPin = previousHead
      ? tryGit(["rev-parse", `${previousHead}:submodules/distilled`], root)
      : undefined;
    // Only follow an Alchemy checkout when distilled is still at its old pin.
    // Installs and intentional distilled development never move an existing HEAD.
    if (
      current !== previousPin ||
      tryGit(["symbolic-ref", "--quiet", "HEAD"], checkout) !== undefined ||
      git(["status", "--porcelain"], checkout) !== ""
    ) {
      console.warn(
        `Preserving distilled at ${current}; Alchemy pins ${pin}. To sync explicitly, run: git -C "${root}" submodule update --init --checkout -- submodules/distilled`,
      );
      return;
    }
    ensureCommit(checkout, pin);
    git(["checkout", "--detach", pin], checkout);
    return;
  }

  if (existsSync(checkout) && readdirSync(checkout).length !== 0) {
    throw new Error(
      `Cannot bootstrap distilled: ${checkout} is nonempty but has no .git entry`,
    );
  }

  if (gitDir === commonDir) {
    git(
      [
        "submodule",
        "update",
        "--init",
        "--checkout",
        "--",
        "submodules/distilled",
      ],
      root,
    );
    return;
  }

  // Initialize the primary checkout at its own pin first. Every linked checkout
  // then gets an independent detached HEAD backed by that same object database.
  const mainRoot = git(["worktree", "list", "--porcelain", "-z"], root)
    .split("\0")[0]
    .slice("worktree ".length);
  bootstrap(mainRoot);
  const mainCheckout = resolve(mainRoot, "submodules/distilled");
  ensureCommit(mainCheckout, pin);
  // The destination was checked above: it is missing or empty. One --force
  // replaces only its stale registration; Git still refuses locked worktrees
  // (overriding a lock would require --force twice). Do not prune other entries.
  git(["worktree", "add", "--force", "--detach", checkout, pin], mainCheckout);
  git(["submodule", "init", "--", "submodules/distilled"], root);
}

function ensureCommit(checkout, pin) {
  if (tryGit(["cat-file", "-e", `${pin}^{commit}`], checkout) === undefined) {
    // Never replace an unavailable pin with a branch tip.
    git(["fetch", "origin", pin], checkout);
    git(["cat-file", "-e", `${pin}^{commit}`], checkout);
  }
}

// The same dependency-free Node script runs before pnpm workspace discovery and
// from post-checkout (whose arguments are old HEAD, new HEAD, branch checkout).
if (import.meta.main && process.argv[4] !== "0") {
  bootstrap(
    resolve(import.meta.dirname, ".."),
    process.argv[4] === "1" ? process.argv[2] : undefined,
  );
}
