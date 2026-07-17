/**
 * The repository the factory manages — the resource IS the export: an
 * un-yielded `GitHub.Repository(...)` constructor Effect at module
 * scope, the ONE way this repository is named anywhere. Charters pass
 * it to the scoped event constructors, implementation Layers pass it to
 * the GitHub bindings (`GitHub.ListIssues(testAlchemy)`) and to
 * `consumeRepositoryEvents` — its declared identity (owner/name) is
 * readable statically, so none of that needs a Stack. The Stack in
 * alchemy.run.ts `yield*`s the same const to provision it — resources
 * are memoized by FQN, so every yield resolves the one instance.
 *
 * This is the `test-alchemy` SANDBOX: a repo we own and can reset, so
 * live iteration cuts issues here without touching production
 * codebases. Pointing the factory at the real alchemy repositories is a
 * one-line change to this file once the loop has proven itself.
 */
import * as GitHub from "alchemy/GitHub";

export const testAlchemy = GitHub.Repository("test-alchemy", {
  owner: "alchemy-run",
  name: "test-alchemy",
  description:
    "Sandbox repository managed by the alchemy-org software factory — cut issues here and the factory resolves them",
  hasIssues: true,
  deleteBranchOnMerge: true,
});
