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
 * This is the `test-alchemy` SANDBOX: a repo we own and can reset,
 * where the loop was proven before it moved to the real repository
 * ({@link connected}). Still provisioned by the Stack (dropping the
 * yield would orphan — and on the next deploy delete — the repo) but
 * no longer connected to the UI.
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
 * baked sandbox worktree's origin — the image clones it, see
 * `SandboxMicrovm.ts`) but must never claim ownership of it. Deferred consts with static `owner`/`name`
 * resolve without provisioning (see `RepositoryLike`), which is
 * exactly how the publish bindings consume it.
 */
export const alchemy = GitHub.Repository("alchemy", {
  owner: "alchemy-run",
  name: "alchemy",
});

/**
 * `distilled` — the Smithy-based SDK factory alchemy's providers call
 * (a submodule at `distilled/` in the alchemy tree, pinned by commit).
 * One unit with {@link alchemy}: a pull request that adds a provider
 * ships a COMPANION pull request here, the review checks the pin
 * points at it, and `process/Distillation.ts` is the loop that feeds
 * what alchemy's tests surface back here as patches. Identity handle
 * only.
 */
export const distilled = GitHub.Repository("distilled", {
  owner: "alchemy-run",
  name: "distilled",
});

/**
 * `floci` — the local AWS emulator alchemy's `alchemy dev` runs AWS
 * providers against (a reference-only vendor submodule at
 * `.vendor/floci`). One unit with {@link alchemy}: an AWS provider is
 * expected to arrive with its emulation, the review looks for the
 * companion pull request here, and `process/AwsEmulation.ts` is how
 * the org works in it. Identity handle only.
 */
export const floci = GitHub.Repository("floci", {
  owner: "alchemy-run",
  name: "floci",
});

/**
 * A repository's `owner/name`, read from its declared identity — the
 * way prose NAMES a repository by reference (`${nameOf(distilled)}`)
 * rather than by a string that rots when the const moves. Splicing the
 * constructor Effect itself renders the resource, not the name.
 */
export const nameOf = (repository: GitHub.RepositoryLike): string => {
  const identity = GitHub.repositoryIdentity(repository);
  if (identity === undefined) {
    throw new Error(
      "nameOf: the repository's owner/name are not plain strings — declare them statically in Repos.ts",
    );
  }
  return `${identity.owner}/${identity.repository}`;
};

/**
 * The repositories a pull request on {@link alchemy} may have a
 * COMPANION in — what `review/Companions.ts` searches by branch name.
 * `submodule` is the path the alchemy tree pins the companion at
 * (`undefined` for a reference-only vendor checkout nothing pins).
 */
export const companions = [
  { repository: distilled, submodule: "distilled" },
  { repository: floci, submodule: undefined },
] as const;

/**
 * The repositories this deploy may PUBLISH to (push branches, open
 * pull requests): each gets an authenticated `CreatePullRequest`
 * client bound at init; the session tree's `origin` picks the target
 * at call time (`coding/OpenPullRequest.ts`).
 */
export const publishTargets = [alchemy, testAlchemy] as const;

/**
 * The repositories CONNECTED to the org UI — STATIC CODE, the one
 * source of truth (never a runtime-editable database; connecting a
 * repository is a code change and a deploy). The UI's sidebar groups
 * are a read-only reflection of this list:
 *
 * - `sessions` — coding sessions may be created under the repo
 *   (session keys are `<owner>/<repo>/<name>`; threads within a
 *   session append `::<thread>` and share the session's sandbox).
 * - `reviews` — the Reviewer reviews every pull request opened on the
 *   repo (and re-reviews on every push) as PROPOSALS for the operator
 *   (review session keys are `<owner>/<repo>#<n>`).
 *
 * This is the REAL alchemy repository: nothing an agent does here
 * reaches GitHub without the operator — reviews, comments, merges, and
 * pull requests are PROPOSALS the operator accepts in the UI
 * (github/Proposals.ts); pushing a topic branch is the one direct
 * write.
 */
export const connected = [
  { repository: alchemy, sessions: true, reviews: true },
] as const;

/** The connected repository the review surface (board, PR pages,
 *  proposals) serves — ONE for now. */
export const primary = connected[0].repository;
