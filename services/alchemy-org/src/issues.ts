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
 * The charter is STATIC — one holistic system prompt stating the
 * triage rules AND the wait-on-the-author rules; the conversation
 * carries which applies. Parking is quiescence: the desk asks its
 * questions and stops calling tools, the kernel parks the run, and
 * the author's reply (an ${IssueCommented} steer) wakes it. No phase
 * state, no prompt swapping — the model reads its position from the
 * thread, the way any transcript reader would.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Context from "effect/Context";
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
          // GitHub's one comment door serves both thread kinds — a
          // comment on a PULL REQUEST belongs to the PullRequests
          // desk, not this one
          if (
            event._tag === "IssueCommented" &&
            GitHub.isPullRequestComment(event)
          ) {
            return;
          }
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
 * The agent's Layer — its CHARTER, fully STATIC: one system prompt
 * stating every phase's rules; the CONVERSATION carries which phase is
 * live. There is no phase `Ref` and no stance swapping — parking is
 * QUIESCENCE (ask, then stop calling tools; the kernel parks the run),
 * and the author's reply is the steer that wakes it. Every message the
 * model sees traces to a call site: its own comments (tool results)
 * and the world's events. The prompt is byte-stable — one prefix in
 * the cache for the run's whole life.
 */
export const IssuesAgentLive = IssuesAgent.make`
  This process manages GitHub issues for ${testAlchemy} from open to
  close. No code is written here and nothing merges here — the
  PullRequests process drives every pull request to its verdict.

  Every ${GitHub.IssueOpened} is checked for prior art with
  ${SearchIssues}. An issue already covered by an open one is a
  duplicate: ${LinkIssues} to the original, ${Comment} telling the
  author where the conversation lives, and ${CloseIssue}. An issue
  that is related but distinct is linked and stays open — an unlinked
  relation is how the org solves the same problem twice.

  An issue is READY when its acceptance criteria are precise enough
  that someone who has read nothing else could start work. Until it
  is, ${Comment} asks the author for exactly what is missing, and
  this process stops and waits: the author's reply arrives as the
  next message. When the reply closes the gaps, triage proceeds; when
  it does not, ask for what is still missing.

  A ready issue is handed to ${Engineer}, whose pull request must
  cite the issue.

  A merged fix closes its issue with ${CloseIssue}, citing the pull
  request; an author confirming the problem is gone does the same. An
  issue is never closed for inactivity alone. This process resumes
  when the world moves — a ${GitHub.IssueCommented} from the author,
  the pull request merging, a ${GitHub.IssueClosed} by hand.`;
