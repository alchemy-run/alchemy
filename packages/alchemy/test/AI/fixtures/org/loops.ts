/**
 * The rings of the organization, inner to outer:
 *
 *   Fix          task loop     — one issue, Ralph semantics, halts per run
 *   Flywheel     product loop  — perpetual, dispatches Fix runs
 *   Helpdesk     support loop  — perpetual, Discord-facing
 *   Autoresearch system loop   — weekly, observes the others' traces
 *
 * Coupling audit: Helpdesk → Flywheel exists only because Support holds
 * ${CreateIssue} and Flywheel triggers on IssueOpened — every inter-ring
 * hop crosses GitHub or Discord. Deleting a ring stops its mail; it breaks
 * nothing.
 */
import * as AI from "@/AI/index.ts";
import {
  Engineer,
  Judge,
  ReleaseBlogger,
  Reviewer,
  Scribe,
  Support,
  Triage,
} from "./agents.ts";
import * as Discord from "./discord-events.ts";
import * as Github from "./github-events.ts";
import { alchemyEffect, distilled } from "./repos.ts";
import { AskHuman, Bash, OpenPullRequest, Reply } from "./tools.ts";
import { issue, pr, PullRequestRef } from "./vocabulary.ts";

/**
 * The task loop. `Out = PullRequestRef` (a halted run resolves with the PR
 * it opened), `In = issue` (from `AI.each`), `Err = BudgetExceeded`.
 *
 * The halt names what ends a run; the check names who judges it (the
 * maker/checker split — Engineer's claim of done-ness is not a signal);
 * the fold names who compresses it.
 */
export class Fix extends AI.Loop<Fix>()("Fix")`
One issue, one loop, one task per iteration.

${AI.each(issue)} give ${Engineer} a completely fresh context: the
issue, its criteria, CONTRIBUTING.md, and .alchemy/NOTES.md. Carry
no conversation history — the repo and the notes are the only
memory this loop is allowed.

${AI.until(PullRequestRef)`every acceptance criterion is checked
and the run resolves with the ${pr} the Engineer opened`}

${AI.check(Judge)`grade each iteration against the issue's
criteria: run ${Bash} yourself — the Engineer's claim of done-ness
is not a signal; an off-goal verdict becomes the next iteration's
first input`}

${AI.fold(Scribe)`distill lessons into .alchemy/NOTES.md after
every iteration, successful or not`}

${AI.budget({ tokens: "5M", wallClock: "2h", iterations: 12, stall: 3 })}` {}

/**
 * The product loop. Perpetual (`Out = never`); wakes on GitHub events
 * across both managed repositories and dispatches typed Fix runs.
 */
export class Flywheel extends AI.Loop<Flywheel>()("Flywheel")`
The development flywheel for the alchemy-run repositories.

${AI.on(Github.IssueOpened(alchemyEffect), Github.IssueOpened(distilled))}
run ${Triage}.

${AI.on(Github.IssueLabeled(alchemyEffect, "ready"), Github.IssueLabeled(distilled, "ready"))}
dispatch a ${Fix} run — at most ${AI.concurrency(3)} in flight,
smallest estimates first.

${AI.on(Github.PullRequestOpened(alchemyEffect), Github.PullRequestOpened(distilled))}
assign ${Reviewer}; a rejected review reopens the originating
${Fix} run with the review attached as new acceptance criteria.

${AI.on(Github.Push(alchemyEffect, { branch: "main", titlePrefix: "chore(release):" }))}
hand off to ${ReleaseBlogger}.

${AI.never`no exit; merge rate, time-to-first-response, and reopen
rate are folded weekly and posted via ${Reply} to #maintainers`}

${AI.fold(Scribe)`weekly: cluster the traces; the top recurring
failure becomes a docs or process issue, filed with evidence`}

${AI.budget({ usd: "250", wallClock: "168h" })}` {}

/**
 * The support loop. Perpetual, Discord-facing. Uses a bare fold — Scribe's
 * own template is the fold policy.
 */
export class Helpdesk extends AI.Loop<Helpdesk>()("Helpdesk")`
${AI.on(Discord.ThreadCreated({ guild: "alchemy", channel: "#help" }))}
run ${Support}.

${AI.on(Discord.Mention({ guild: "alchemy", user: "@alchemy" }))}
run ${Support}.

${AI.fold(Scribe)}

${AI.never`support does not halt while the product lives; thread
resolution rate is the health signal, folded weekly`}` {}

/**
 * The system loop. Observes — does not run — the other rings, so their
 * requirements do not flow in: note the absent ${Approve}. The system ring
 * cannot be granted merge authority by any Layer; enforced by Req, not
 * prose. Its exit signal is a human act arriving as a GitHub event.
 */
export class Autoresearch extends AI.Loop<Autoresearch>()("Autoresearch")`
${AI.every("1 week")} study the traces of ${AI.observe(Flywheel)}
and ${AI.observe(Helpdesk)}: cluster failures; find prompts
correlated with reopened issues; find tools agents misuse or avoid.

Propose improvements via ${OpenPullRequest} against src/org/ —
edits to agent templates, new tools, changed Layer wiring. Every
proposal must cite the traces that motivated it and include an eval
that would have caught the failure. You may ${AskHuman} to
understand intent.

${AI.until`a maintainer closes the experiment`}

${AI.budget({ tokens: "10M", wallClock: "6h" })}` {}
