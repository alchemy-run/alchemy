/**
 * The Issues process — manages the repository's issues from open to
 * close. It is prose all the way down: triage, dedupe, delegation,
 * and closure are charter clauses, not code. The only things it can
 * DO are the tools and agents it names — a process that never
 * mentions ${MergePullRequest} cannot merge, which is the point:
 * merge authority lives with the PullRequests process.
 *
 * A PROCESS, not an agent: its tag resolves to {@link IssuesService}
 * — the read-only status surface — for deterministic code and other
 * charters alike. The actor verbs live only inside {@link IssuesLive}'s
 * closure, where the world drives them — an issue opening is `send`,
 * a comment is `steer`, a close is `settle`. How work arrives
 * (webhook vs poll) and how redeliveries collapse (the Ledger) are
 * this Layer's decisions; the charter never sees them.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import { Engineer } from "./engineer.ts";
import { Ledger } from "./ledger.ts";
import { testAlchemy } from "./repos.ts";
import {
  CloseIssue,
  Comment,
  LinkIssues,
  SearchIssues,
} from "./tools/index.ts";

/** What the org may ask of the Issues owner from code: read, never drive. */
export interface IssuesService {
  /** Snapshot of the repository's open issues. */
  readonly list: () => Effect.Effect<
    GitHub.ListIssuesResponse,
    GitHub.GitHubApiError
  >;
}

export class Issues extends AI.Process<Issues, IssuesService>()("Issues")`
This process manages GitHub issues for ${testAlchemy} from open to
close.

Every ${GitHub.IssueOpened} is checked for prior art with
${SearchIssues}. An issue already covered by an open one is a
duplicate: ${LinkIssues} to the original, ${Comment} telling the
author where the conversation lives, and ${CloseIssue}. An issue
that is related but distinct is linked and stays open — an unlinked
relation is how the org solves the same problem twice.

An issue is READY when its acceptance criteria are precise enough
that someone who has read nothing else could start work. Until it
is, ${Comment} asks the author for exactly what is missing — one
question per gap, no boilerplate — and the process waits.

A ready issue is handed to ${Engineer}, whose pull request must cite
the issue. Review and merging happen elsewhere: the PullRequests
process drives every pull request to its verdict. This process
resumes when the world moves — a ${GitHub.IssueCommented} from the
author, the pull request merging, a ${GitHub.IssueClosed} by hand.

A merged fix closes its issue with ${CloseIssue}, citing the pull
request; an author confirming the problem is gone does the same. An
issue is never closed for inactivity alone.

No code is written here and nothing merges here.` {}

/**
 * The implementation: interpret the charter, wire the world to the
 * verbs, expose the sealed interface. One run per issue, keyed
 * `owner/repo#n` — the Ledger collapses webhook redeliveries and poll
 * re-observations to exactly one `send`; everything after is `steer`;
 * the world closing the issue is `settle`.
 */
export const IssuesLive = Layer.effect(
  Issues,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const listIssues = yield* GitHub.ListIssues(testAlchemy);
    const issues = yield* AI.interpret(Issues);

    // the selection IS the routing table — unselected events
    // (labeled etc.) never arrive, and the Match is exhaustive
    yield* GitHub.consumeRepositoryEvents(
      testAlchemy,
      {
        events: [GitHub.IssueOpened, GitHub.IssueCommented, GitHub.IssueClosed],
      },
      (event) =>
        Match.value(event).pipe(
          Match.tag("IssueOpened", (event) =>
            Effect.gen(function* () {
              const key = GitHub.eventKey(event)!;
              const { status } = yield* ledger.offer("issues", key, event);
              yield* status === "accepted"
                ? issues.send(event, { key })
                : issues.steer(key, event);
            }),
          ),
          Match.tag("IssueCommented", (event) =>
            issues.steer(GitHub.eventKey(event)!, event),
          ),
          Match.tag("IssueClosed", (event) =>
            Effect.gen(function* () {
              const key = GitHub.eventKey(event)!;
              yield* issues.settle(key, event);
              yield* ledger.settle("issues", key);
            }),
          ),
          Match.exhaustive,
        ),
    );

    return {
      list: () => listIssues({ state: "open" }),
    };
  }),
);
