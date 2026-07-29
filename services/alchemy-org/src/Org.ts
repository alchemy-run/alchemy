/**
 * The ORG, substrate-neutral — the processes over their agents over
 * their tools, with every seam that differs between environments left
 * OPEN as a requirement:
 *
 * - the kernel (`AI.Kernel` + observer)   → services/Kernel.ts
 * - GitHub bindings (the API tags)        → services/GitHubBindings.ts
 * - event delivery (poll vs webhook)      → services/Events.ts
 * - the Ledger (sqlite vs D1)             → LedgerSqlite.ts / LedgerD1.ts
 * - the coding physics (Coding, QA,
 *   OpenPullRequest — local vs sandbox)   → skills/*, tools/*Toolbox.ts
 * - the approvals record                  → Approvals.ts
 *
 * `OrgLocal.ts` and `OrgWorker.ts` are the two provide-lists —
 * swapping environments is swapping which one the entrypoint builds
 * (the components doctrine). They are separate MODULES, not two
 * exports of one file, for bundle hygiene: the Worker must never see
 * `bun:sqlite`, the local process never needs the container plumbing.
 */
import * as Layer from "effect/Layer";
import { ReviewerLive } from "./agents/Reviewer.ts";
import { IssueEngineer, Issues, IssuesLive } from "./processes/Issues.ts";
import { PullRequests, PullRequestsLive } from "./processes/PullRequests.ts";
import { LiveTestingLive } from "./skills/LiveTesting.ts";
import { ResourceEngineeringLive } from "./skills/ResourceEngineering.ts";
import { TypedErrorsLive } from "./skills/TypedErrors.ts";
import {
  CloseIssueLive,
  CommentLive,
  LinkIssuesLive,
  MergePullRequestLive,
  ReadDiffLive,
  ReadIssueLive,
  SearchIssuesLive,
} from "./tools/index.ts";

export { Issues, PullRequests };

/**
 * The DOCTRINE skill tree — prose-only teachings, identical on every
 * substrate: Coding's teaching exposes ResourceEngineering, whose
 * teaching exposes TypedErrors and LiveTesting; each level is an
 * OUTPUT (provideMerge) so the kernel resolves the graph at
 * activation. The physics lists merge this under their Coding
 * flavor — the tree must ride WITH the teaching that references it,
 * into the Engineer's charter context.
 */
export const DoctrineSkills = ResourceEngineeringLive.pipe(
  Layer.provideMerge([TypedErrorsLive, LiveTestingLive]),
);

/**
 * The org's core: the desks over the Engineer and Reviewer, with the
 * GitHub-API tools (substrate-neutral — they resolve binding TAGS)
 * provided, and the physics seams flowing out as requirements.
 */
export const Org = Layer.mergeAll(IssuesLive, PullRequestsLive).pipe(
  // the owner's workers: the Engineer writes the fix in its own
  // thread; the Reviewer judges the artifact and records its verdict
  // (the SAME reviewer also judges unlinked foreign PRs — the router
  // dispatches it directly and ratifies the merge deterministically)
  Layer.provide([IssueEngineer, ReviewerLive]),
  Layer.provide([
    CommentLive,
    SearchIssuesLive,
    LinkIssuesLive,
    CloseIssueLive,
    MergePullRequestLive,
    ReadDiffLive,
    ReadIssueLive,
  ]),
);
