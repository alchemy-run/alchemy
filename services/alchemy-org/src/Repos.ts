import * as GitHub from "alchemy/GitHub";

/**
 * The repository the org manages — the resource IS the export: an
 * un-yielded `GitHub.Repository(...)` constructor Effect at module
 * scope, the ONE way this repository is named anywhere. Charters pass
 * it to the scoped event constructors, implementation Layers pass it
 * to the GitHub bindings (`GitHub.GetPullRequest(testAlchemy)`) and to
 * `consumeRepositoryEvents` — its declared identity (owner/name) is
 * readable statically, so none of that needs a Stack. The Stack in
 * alchemy.run.ts `yield*`s the same const to provision it — resources
 * are memoized by FQN, so every yield resolves the one instance.
 *
 * This is the `test-alchemy` SANDBOX: a repo we own and can reset, so
 * live iteration opens pull requests here without touching production
 * codebases. Pointing the pipeline at the real alchemy repositories is
 * a one-line change to this file once the loop has proven itself.
 */
export const testAlchemy = GitHub.Repository("test-alchemy", {
  owner: "alchemy-run",
  name: "test-alchemy",
  description:
    "Sandbox repository managed by the alchemy-org review bot — open pull requests here and the bot reviews them",
  hasIssues: true,
  deleteBranchOnMerge: true,
});

/**
 * The alchemy repository itself — an IDENTITY HANDLE only, never
 * yielded under the Stack: the org contributes to this repository (the
 * baked sandbox worktree's origin — `SandboxBake.ts`) but must never
 * claim ownership of it. Deferred consts with static `owner`/`name`
 * resolve without provisioning (see `RepositoryLike`), which is
 * exactly how the publish bindings consume it.
 */
export const alchemy = GitHub.Repository("alchemy", {
  owner: "alchemy-run",
  name: "alchemy",
});

/**
 * The repositories this deploy may PUBLISH to (push branches, open
 * pull requests): each gets an authenticated `CreatePullRequest`
 * client bound at init; the session tree's `origin` picks the target
 * at call time (`tools/Publish.ts`).
 */
export const publishTargets = [alchemy, testAlchemy] as const;
