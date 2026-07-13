/**
 * The REAL repositories the org maintains — the resource-first form:
 * each export IS the un-yielded `GitHub.Repository(...)` constructor
 * Effect. Charters pass these to the scoped event constructors directly
 * (the deferred form, resolved in-Effect by the consuming Layer), and
 * the Stack in alchemy.run.ts `yield*`s the same consts to provision
 * them — resources are memoized by FQN, so every yield resolves the one
 * instance.
 */
import * as GitHub from "alchemy/GitHub";

export const alchemyEffect = GitHub.Repository("alchemy-effect", {
  owner: "alchemy-run",
  name: "alchemy-effect",
  description: "Infrastructure-as-Effects",
  hasIssues: true,
  deleteBranchOnMerge: true,
});

/**
 * distilled is embedded in the alchemy-effect workspace as a git
 * submodule (`./distilled`): one issue's fix may produce a PR here too —
 * distilled merges first, then the superproject bumps the submodule
 * pointer.
 */
export const distilled = GitHub.Repository("distilled", {
  owner: "alchemy-run",
  name: "distilled",
  description:
    "Typed cloud SDKs, distilled from OpenAPI — embedded in the alchemy-effect workspace as a git submodule",
  hasIssues: true,
  deleteBranchOnMerge: true,
});
