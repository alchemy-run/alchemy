/**
 * The org over LOCAL physics — the laptop provide-list: KernelMemory
 * fibers, GitHub by profile credentials and REST polling, bun:sqlite
 * for the book of record, and the coding tools on the process's own
 * FileSystem/shell over per-run git worktrees.
 *
 * A separate MODULE from OrgWorker.ts for bundle hygiene — this one
 * imports `bun:sqlite`; the Worker list never can.
 */
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import { perRun as runWorkspace } from "alchemy/Workspace";
import * as Layer from "effect/Layer";
import { ApprovalsLedger } from "./services/Approvals.ts";
import { SqliteLedger } from "./services/LedgerSqlite.ts";
import { DoctrineSkills, Org } from "./Org.ts";
import { testAlchemy } from "./Repos.ts";
import { CodingLocal } from "./skills/Coding.ts";
import { QualityAssuranceLocal } from "./skills/QualityAssurance.ts";
import { EventsLocal } from "./services/Events.ts";
import { Credentials, GitHubLocal } from "./services/GitHubBindings.ts";
import { KernelLocal, OrgChats } from "./services/Kernel.ts";
import { ToolOutputStoreLive } from "./lib/ToolOutputStore.ts";
import {
  ApproveRecorded,
  ApproveRequested,
  OpenPullRequestLive,
} from "./tools/index.ts";

/**
 * The workspaces ROOT — one directory holds the central clones and the
 * per-run worktrees (`Git.WorkspacesWorktree` populates it), and the
 * SAME directory is the toolbox's containment root: each run's tree is
 * a subdirectory the coding tools can reach but not escape.
 * `ORG_WORKSPACE` overrides the location.
 */
const workspaceRoot =
  process.env.ORG_WORKSPACE ?? `${process.cwd()}/.alchemy/workspaces`;

/**
 * Checkouts as a capability, LOCAL physics: central blobless clone +
 * one worktree per run key. ONE instance — the Engineer's turn, the
 * Reviewer's exploration, and the OpenPullRequest handler share the
 * checkout cache (same const, memoized by reference).
 */
const WorkspacesLive = Git.WorkspacesWorktree({ root: workspaceRoot }).pipe(
  Layer.provide(GitHub.GitCredentials),
  Layer.provide(Credentials),
);

/**
 * The AUTONOMY DIAL — which physics answers the Reviewer's `Approve`:
 *
 * - autonomous (default): {@link ApproveRecorded} writes the approvals
 *   ledger; the owner's merge ratifies against it — the factory runs
 *   the whole loop itself.
 * - supervised (`ORG_SUPERVISED=1`): {@link ApproveRequested} posts the
 *   verdict as a RECOMMENDATION and records nothing — the merge tool
 *   then only succeeds on a real APPROVED GitHub review from a human.
 */
const Approval =
  process.env.ORG_SUPERVISED === "1" ? ApproveRequested : ApproveRecorded;

export const OrgLocal = Org.pipe(
  Layer.provide([
    // the coding physics: the doctrine tree rides with the teaching
    CodingLocal.pipe(Layer.provideMerge(DoctrineSkills)),
    QualityAssuranceLocal,
    OpenPullRequestLive.pipe(Layer.provide(ToolOutputStoreLive)),
    Approval,
  ]),
  Layer.provide(KernelLocal),
  // one shared instance: init's checkout, the toolbox root, and the
  // PR tool all read the same cache, so they land in the same worktree
  Layer.provide(runWorkspace({ remote: GitHub.remote(testAlchemy) })),
  Layer.provide(WorkspacesLive),
  Layer.provide(EventsLocal),
  Layer.provideMerge(ApprovalsLedger),
  Layer.provideMerge(SqliteLedger(".alchemy/org-ledger.sqlite")),
  // the chat projection (same const the kernel bundle observes into)
  // and the comment binding surface — both consumed by the HTTP edge
  Layer.provideMerge(OrgChats),
  Layer.provideMerge(GitHubLocal),
  Layer.orDie,
);
