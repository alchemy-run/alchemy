/**
 * The CONTRIVED repository this fixture org manages — a sandbox we can
 * provision, cut issues on, and iterate against for real (see stack.ts)
 * without touching production codebases. The actual alchemy-effect +
 * distilled flywheel lives in `services/alchemy-org`.
 *
 * The resource IS the export: an un-yielded `GitHub.Repository(...)`
 * constructor Effect at module scope. Charters pass it to the scoped
 * event constructors directly (the DEFERRED form — resolved in-Effect
 * by the consuming Layer), and the Stack `yield*`s the same const to
 * provision it — resources are memoized by FQN, so every yield of this
 * export resolves the one instance.
 */
import * as GitHub from "@/GitHub/index.ts";

export const testAlchemy = GitHub.Repository("test-alchemy", {
  owner: "alchemy-run",
  name: "test-alchemy",
  description:
    "Contrived sandbox for the AI org fixture — cut issues here and iterate for real; the actual alchemy+distilled flywheel lives in services/alchemy-org",
  hasIssues: true,
  deleteBranchOnMerge: true,
});
