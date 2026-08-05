/**
 * The review bot over LOCAL physics — the laptop provide-list:
 * KernelMemory fibers, GitHub by profile credentials and REST
 * polling, bun:sqlite for event dedupe, and the read/run toolbox on
 * the process's own FileSystem/shell over per-PR git worktrees.
 */
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import { perRun as runWorkspace } from "alchemy/Workspace";
import * as Layer from "effect/Layer";
import { ReviewBotEvents, ReviewBotLive } from "./ReviewBot.ts";
import { EventsLocal } from "./services/Events.ts";
import { Credentials, GitHubLocal } from "./services/GitHubLocal.ts";
import { BotChats, KernelLocal } from "./services/Kernel.ts";
import { SqliteLedger } from "./services/LedgerSqlite.ts";
import { QualityAssuranceLocal } from "./skills/QualityAssurance.ts";
import { ReadDiffLive, ReadIssueLive } from "./tools/index.ts";

/**
 * The workspaces ROOT — one directory holds the central clone and the
 * per-PR worktrees (`Git.WorkspacesWorktree` populates it), and the
 * SAME directory is the toolbox's containment root: each review's
 * tree is a subdirectory the tools can reach but not escape.
 * `ORG_WORKSPACE` overrides the location.
 */
const workspaceRoot =
  process.env.ORG_WORKSPACE ?? `${process.cwd()}/.alchemy/workspaces`;

/** Checkouts as a capability: central blobless clone + one worktree
 *  per PR. ONE instance — the charter's init checkout and the toolbox
 *  root share the cache (same const, memoized by reference). */
const WorkspacesLive = Git.WorkspacesWorktree({ root: workspaceRoot }).pipe(
  Layer.provide(GitHub.GitCredentials),
  Layer.provide(Credentials),
);

export const Local = ReviewBotEvents.pipe(
  // provideMERGE: the HTTP edge addresses the bot too (the operator's
  // click-to-review sends it a synthetic opened event)
  Layer.provideMerge(Layer.suspend(() => ReviewBotLive)),
  Layer.provide([QualityAssuranceLocal, ReadDiffLive, ReadIssueLive]),
  // provideMERGE: the HTTP edge (Server.ts) consumes AgentGateway for
  // the run-socket `/attach` door, so the kernel bundle must be exported
  Layer.provideMerge(KernelLocal),
  // the toolbox resolves each run's tree from the shared checkout cache
  Layer.provide(runWorkspace()),
  Layer.provideMerge(WorkspacesLive),
  Layer.provide(EventsLocal),
  Layer.provideMerge(SqliteLedger(".alchemy/review-ledger.sqlite")),
  // the chat projection (same const the kernel bundle observes into)
  // — consumed by the HTTP edge for the thread list and transcripts
  Layer.provideMerge(BotChats),
  Layer.provideMerge(GitHubLocal),
  Layer.orDie,
);
