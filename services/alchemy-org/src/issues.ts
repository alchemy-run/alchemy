/**
 * The Issues desk — manages the repository's issues from open to
 * close. It is prose all the way down: triage, dedupe, delegation,
 * and closure are charter clauses, not code. The only things it can
 * DO are the tools and agents its charter renders — a desk whose
 * prose never mentions ${MergePullRequest} cannot merge, which is
 * the point: merge authority lives with the PullRequests desk.
 *
 * SEALED in practice: {@link Issues} is a plain `Context.Service`
 * resolving to {@link IssuesService} — the read-only status surface —
 * for deterministic code and other charters alike. The AGENT behind
 * the desk ({@link IssuesAgent}) is wired only by {@link IssuesLive},
 * where the world drives its verbs — an issue opening is `send`, a
 * comment is `steer`, a close is `settle`. How work arrives (webhook
 * vs poll) and how redeliveries collapse (the Ledger) are this
 * Layer's decisions; the charter never sees them.
 *
 * The charter is DYNAMIC (init → turn, init once per issue): each
 * issue's run carries a `phase` Ref in its init closure, and the
 * stance the model sees follows it — triage instructions while
 * triaging, wait-on-the-author instructions while parked. The inline
 * tools `await_author`/`resume_triage` are how the run moves its own
 * phase; the kernel re-renders the stance before every sampling and
 * delivers changes as situation messages.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Ref from "effect/Ref";
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

export class Issues extends Context.Service<Issues, IssuesService>()(
  "alchemy-org/Issues",
) {}

/**
 * The implementation: resolve the private agent, wire the world to
 * its verbs, expose the sealed Shape. One run per issue, keyed
 * `owner/repo#n`.
 *
 * The delivery discipline: `send(event, { key })` is the ONE delivery
 * verb — the kernel admits the run on first sight of its key and
 * enqueues thereafter, so a fresh event after a crash re-admits the
 * run (level-triggered recovery). The Ledger dedupes DELIVERIES by
 * content (webhook redeliveries and poll re-observations collapse);
 * it never gates run admission. The world closing the issue is
 * `settle`.
 */
export const IssuesLive = Layer.effect(
  Issues,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const listIssues = yield* GitHub.ListIssues(testAlchemy);
    const issuesAgent = yield* IssuesAgent;

    // the selection IS the routing table — unselected events
    // (labeled etc.) never arrive, and the Match is exhaustive
    yield* GitHub.consumeRepositoryEvents(
      testAlchemy,
      {
        events: [GitHub.IssueOpened, GitHub.IssueCommented, GitHub.IssueClosed],
      },
      (event) =>
        Effect.gen(function* () {
          const key = GitHub.eventKey(event)!;
          const { status } = yield* ledger.offer(
            "issues",
            JSON.stringify(event), // delivery identity: the content itself
            event,
          );
          if (status === "duplicate") return;
          yield* Match.value(event).pipe(
            Match.tag("IssueClosed", (e) => issuesAgent.settle(key, e)),
            Match.orElse((e) => issuesAgent.send(e, { key })),
          );
        }),
    );

    return {
      list: () => listIssues({ state: "open" }),
    };
  }),
).pipe(Layer.provide(Layer.suspend(() => IssuesAgentLive)));

/** The loop behind the desk — {@link IssuesLive} wires the world to it. */
export class IssuesAgent extends AI.Agent<IssuesAgent>()("Issues") {}

/**
 * The agent's Layer — its CHARTER: INIT runs once PER ISSUE (the
 * closure is the run's instance — the phase `Ref`, the inline tools
 * that move it); the returned TURN runs before every sampling and
 * renders the stance for the current phase.
 */
export const IssuesAgentLive = IssuesAgent.make(
  Effect.gen(function* () {
    const phase = yield* Ref.make<"triaging" | "awaiting-author">("triaging");

    // yield*ed so the templates' own splices (${Comment}) are charged
    // to the init's requirement channel — the tool's dependencies are
    // a type-level fact of the Layer
    const awaitAuthor = yield* AI.Tool("await_author")`
      Park this issue on its author: triage is blocked until they answer.
      Ask your questions with ${Comment} FIRST — one per gap, no
      boilerplate — then call this.`(() =>
      Ref.set(phase, "awaiting-author").pipe(
        Effect.as("parked; the author's next reply resumes this issue"),
      ),
    );

    const resumeTriage = yield* AI.Tool("resume_triage")`
      The author's reply closed the gaps — pick triage back up.`(() =>
      Ref.set(phase, "triaging").pipe(Effect.as("resumed")),
    );

    // the returned prose IS the turn; the Effect-valued splice is
    // re-evaluated at every render, so the stance follows the phase
    return AI.prose`
      This process manages GitHub issues for ${testAlchemy} from open to
      close. No code is written here and nothing merges here — the
      PullRequests process drives every pull request to its verdict.

      ${Ref.get(phase).pipe(
        Effect.flatMap((phase) =>
          phase === "triaging"
            ? AI.prose`
                Every ${GitHub.IssueOpened} is checked for prior art with
                ${SearchIssues}. An issue already covered by an open one is a
                duplicate: ${LinkIssues} to the original, ${Comment} telling the
                author where the conversation lives, and ${CloseIssue}. An issue
                that is related but distinct is linked and stays open — an
                unlinked relation is how the org solves the same problem twice.

                An issue is READY when its acceptance criteria are precise enough
                that someone who has read nothing else could start work. Until it
                is, ${Comment} asks the author for exactly what is missing and
                ${awaitAuthor} parks the issue on them.

                A ready issue is handed to ${Engineer}, whose pull request must
                cite the issue.`
            : AI.prose`
                This issue is parked on its author. Judge their latest reply: when
                it closes the gaps, ${resumeTriage} and proceed; when it does not,
                ask again with ${Comment} — never re-ask an answered question.`,
        ),
      )}

      A merged fix closes its issue with ${CloseIssue}, citing the pull
      request; an author confirming the problem is gone does the same. An
      issue is never closed for inactivity alone. This process resumes
      when the world moves — a ${GitHub.IssueCommented} from the author,
      the pull request merging, a ${GitHub.IssueClosed} by hand.`;
  }),
);
