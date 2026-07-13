/**
 * The org's one Process: {@link ResolveGitHubIssue} — resolves a GitHub
 * issue end to end (triage → pull request → review → merge), settled by
 * the WORLD closing the issue, never by the model's claim.
 *
 * This is the REAL flywheel, scoped to the alchemy-effect repository.
 * The Engineer's workspace embeds the distilled submodule, so one
 * issue's fix may land as a distilled PR plus the superproject PR that
 * bumps the submodule pointer — reviewed and merged as one change,
 * distilled-first.
 *
 * The GitHub sources come from the CORE catalog (alchemy/GitHub), here
 * in the DEFERRED form — the exported un-yielded `GitHub.Repository`
 * const from repos.ts, resolved in-Effect by the consuming Layer.
 * Delivery is the DERIVED front door: the worker composes
 * `GitHub.frontDoor(ResolveGitHubIssue)`, which reads the `AI.when` /
 * `AI.exit` declarations below and wires `consumeRepositoryEvents`
 * underneath — `issues.opened` creates a run, `issue_comment.created`
 * steers it, and `issues.closed` settles it (observed by the kernel
 * through the exit's channel subscription, correlated by the source's
 * own `key`: `owner/repository#number`). Budget is NOT prose — the
 * worker provides `AI.budget({...})` as a Layer next to the kernel.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as S from "effect/Schema";
import { Engineer, Reviewer } from "./agents.ts";
import { alchemyEffect } from "./repos.ts";
import { Comment, MergePullRequest, SearchIssues } from "./tools.ts";
import { IssueRef } from "./vocabulary.ts";

/**
 * Published when an issue is handed to engineering — org-internal (no
 * channel: deliverable on the harness bus), declared by its bare
 * mention in the charter (the unmarked grant).
 */
export const EngineeringStarted = AI.EventSource(
  "org.engineering.started",
  IssueRef,
);

/**
 * Published when work is blocked on a maintainer — the run parks on its
 * machine-observed exit right after.
 */
export const IssueParked = AI.EventSource(
  "org.issue.parked",
  S.Struct({
    owner: S.String,
    repository: S.String,
    number: S.Number,
    blocker: S.String,
  }),
);

/**
 * One issue, one run: created when the issue opens, steered by its
 * comments, settled when GitHub closes it — the machine-observed exit
 * (`AI.exit(AI.when(IssueClosed(...)))`) correlates runs by the
 * source's natural key, so the charter never restates the plumbing.
 */
export class ResolveGitHubIssue extends AI.Process<ResolveGitHubIssue>()(
  "ResolveGitHubIssue",
)`
You resolve GitHub issues for the alchemy-effect repository, from the
moment one opens until GitHub closes it.

${AI.when(GitHub.IssueOpened(alchemyEffect))}, read it, then
${SearchIssues} for duplicates and prior discussion. If it is a
duplicate or a question you can answer, ${Comment} asking the reporter
to close it. Otherwise write acceptance criteria: a checklist
verifiable by a command or a test.

Hand the issue and its criteria to ${Engineer}, announcing
${EngineeringStarted} so the rest of the org sees the work moving.
The Engineer's workspace is the alchemy-effect checkout with the
distilled submodule embedded at ./distilled, so a fix that spans both
repositories is one change in one workspace — expect one pull request
per repository touched, each citing the issue, opened when the tests
are green.

Ask ${Reviewer} to review every pull request the issue produced
against the issue's criteria. A fix that spans the superproject and
the distilled submodule is one change: the Reviewer reads the pair
together, and it lands together or not at all. If the review requests
changes, send the work back to ${Engineer} with the review attached
as new acceptance criteria. Once approved, ${MergePullRequest} — the
distilled pull request first, then the superproject one that bumps
the submodule pointer to it; it refuses to merge without an approved
review.

${AI.when(GitHub.IssueCommented(alchemyEffect))}, read it and adjust:
a comment can change the criteria, unblock the work, or resolve the
issue outright.

If you are blocked on something only a maintainer can decide, publish
${IssueParked} naming what you need, and wait.

${AI.exit(AI.when(GitHub.IssueClosed(alchemyEffect)))`whether the
merged pull requests closed it or a maintainer closed it by hand`}` {}
