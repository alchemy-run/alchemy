/**
 * The org's one Process: {@link ResolveGitHubIssue} — resolves a GitHub
 * issue end to end (triage → pull request → review → merge), settled by
 * the WORLD closing the issue, never by the model's claim.
 *
 * The repository is the CONTRIVED `test-alchemy` sandbox (repos.ts) so
 * live iteration cuts issues on a repo we own and can reset; the real
 * alchemy + distilled flywheel lives in `services/alchemy-org`.
 *
 * The GitHub sources come from the CORE catalog (src/GitHub/Events.ts).
 * Delivery is owned by the process's IMPLEMENTATION (the components
 * doctrine): the worker hand-wires `GitHub.consumeRepositoryEvents`,
 * adapting each delivery and picking the door — `issues.opened`
 * creates a run, `issue_comment.created` steers it, and
 * `issues.closed` settles it (observed by the kernel through the
 * exit's channel subscription, correlated by the source's own `key`:
 * `owner/repository#number`). The `AI.when` / `AI.exit` declarations
 * below encode the INTERFACE only. Budget is NOT prose — the worker
 * provides `AI.budget({...})` as a Layer next to the kernel.
 */
import * as S from "effect/Schema";
import * as AI from "@/AI/index.ts";
import * as GitHub from "@/GitHub/index.ts";
import { Engineer, Reviewer } from "./agents.ts";
import { testAlchemy } from "./repos.ts";
import { MergePullRequest, Comment, SearchIssues } from "./tools.ts";
import { IssueRef } from "./vocabulary.ts";

/**
 * Published when an issue is handed to engineering — org-internal (no
 * channel: deliverable on the harness bus), declared by its bare
 * mention in the charter (the unmarked grant, canon §2a).
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
You resolve GitHub issues for the test-alchemy repository, from the
moment one opens until GitHub closes it.

${AI.when(GitHub.IssueOpened(testAlchemy))}, read it, then
${SearchIssues} for duplicates and prior discussion. If it is a
duplicate or a question you can answer, ${Comment} asking the reporter
to close it. Otherwise write acceptance criteria: a checklist
verifiable by a command or a test.

Hand the issue and its criteria to ${Engineer}, announcing
${EngineeringStarted} so the rest of the org sees the work moving.
The Engineer opens a pull request when the tests are green.

Ask ${Reviewer} to review that pull request against the issue. If the
review requests changes, send it back to ${Engineer} with the review
attached as new acceptance criteria. Once approved,
${MergePullRequest} — it refuses to merge without an approved review.

${AI.when(GitHub.IssueCommented(testAlchemy))}, read it and adjust:
a comment can change the criteria, unblock the work, or resolve the
issue outright.

If you are blocked on something only a maintainer can decide, publish
${IssueParked} naming what you need, and wait.

${AI.exit(AI.when(GitHub.IssueClosed(testAlchemy)))`whether the merged
pull request closed it or a maintainer closed it by hand`}` {}
