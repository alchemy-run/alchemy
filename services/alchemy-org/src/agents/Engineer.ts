/**
 * The Engineer — the ROLE: an agent that writes code and answers with
 * a pull request. The DECLARATION is a bare tag (the contract callers
 * depend on: the verbs, the authority envelope — ${OpenPullRequest}
 * and never merge/approve — and a PR-shaped reply); the MISSION is
 * the binding, defined WITH the desk that staffs it:
 *
 * - `IssueEngineer` (processes/Issues.ts) — works one issue's thread.
 * - `DistilledEngineer` (processes/Distilled.ts) — keeps the
 *   ./distilled submodule tracking upstream.
 *
 * Each composition subtree staffs its own — the kernel resolves a
 * charter's ${Engineer} mention from THAT charter's Layer graph, so
 * two missions coexist in one runtime. Bindings may vary mission,
 * skills, and model; they must NOT vary the authority envelope (a
 * `Layer<Engineer>` splicing ${Approve} betrays the role — the audit
 * greps charters per binding). Each mission wraps the shared
 * {@link OpenPullRequest} physics in its OWN inline tool — the prose
 * (cite the issue vs. summarize the sync pass) is mission-specific,
 * and each wrapper calls `AI.reply(created.pr)` the moment the pull
 * request provably exists: a round ends on EVIDENCE, never on the
 * model's claim.
 *
 * The Engineer's WORKTREE is not acquired here: `Workspace.perRun`
 * (the entrypoint's layer) binds run key → checkout lazily on first
 * tool use — ONE site owns that join, and `Git.Workspaces` memoizes
 * by key so the PR tool lands in the same tree.
 */
import * as AI from "alchemy/AI";
import type { PullRequestRef } from "../Vocabulary.ts";

export class Engineer extends AI.Agent<Engineer>()("Engineer") {}

/** The artifact a round answers with: the created pull request. */
export type Pr = typeof PullRequestRef.Type;

/** What the OpenPullRequest physics returns to its mission wrappers. */
export type OpenedPullRequest = { opened: string; pr: Pr };
