/**
 * The org's one Process: {@link ResolveGitHubIssue} — resolves a GitHub
 * issue end to end (triage → pull request → review → merge), settled by
 * the WORLD closing the issue, never by the model's claim.
 *
 * The repository is the CONTRIVED `test-alchemy` sandbox (repos.ts) so
 * live iteration cuts issues on a repo we own and can reset; the real
 * alchemy + distilled flywheel lives in `services/alchemy-org`.
 *
 * The GitHub events come from the CORE catalog (src/GitHub/Events.ts).
 * Delivery is owned by the process's IMPLEMENTATION (the components
 * doctrine): the worker hand-wires `GitHub.consumeRepositoryEvents`,
 * routing each typed event — `IssueOpened` creates a run,
 * `IssueCommented` steers it, and `IssueClosed` settles it
 * (`settle(key, event)`, keyed by `owner/repository#number`). The
 * `AI.when` declarations below encode the INTERFACE only; the charter
 * has NO halt — it is externally settled, and the ending is ordinary
 * prose. Budget is NOT prose — the worker provides `AI.budget({...})`
 * as a Layer next to the kernel.
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
export const EngineeringStarted = AI.Event("org.engineering.started", IssueRef);

/**
 * Published when work is blocked on a maintainer — the run parks right
 * after, awaiting a steer or the component's settle.
 */
export const IssueParked = AI.Event(
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
 * comments, settled when GitHub closes it — the implementation Layer
 * delivers the close (`settle(key, event)`, the source's natural key),
 * so the charter never states the plumbing: its ending is prose.
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

GitHub closing the issue is what ends this work — whether the merged
pull request closed it or a maintainer closed it by hand. You never
declare the issue done yourself.` {}
