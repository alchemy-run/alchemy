/**
 * The PullRequests desk — the repository's ONE merge authority.
 * Every pull request, whether the factory's own Engineer opened it or
 * a human contributor did, passes through this charter: review
 * verdict, then merge or relay changes.
 *
 * The Issues and Discord owners deliberately do NOT reference
 * ${MergePullRequest}; capability-by-omission makes this the only
 * charter any Layer could ever grant merge authority to.
 *
 * SEALED in practice: {@link PullRequests} is a plain
 * `Context.Service` resolving to {@link PullRequestsService} and
 * nothing else — the agent behind it is wired only by
 * {@link PullRequestsLive}; work enters through GitHub or not at all.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import { Ledger } from "./ledger.ts";
import { testAlchemy } from "./repos.ts";
import { Reviewer } from "./reviewer.ts";
import { Comment, MergePullRequest } from "./tools/index.ts";

/** What the org may ask of the PullRequests owner from code: read, never drive. */
export interface PullRequestsService {
  /** Snapshot of the repository's open pull requests. */
  readonly list: () => Effect.Effect<
    GitHub.ListPullRequestsResponse,
    GitHub.GitHubApiError
  >;
}

export class PullRequests extends Context.Service<
  PullRequests,
  PullRequestsService
>()("alchemy-org/PullRequests") {}

/**
 * The implementation: one run per pull request, keyed `owner/repo#n`.
 * `send` is the one delivery verb (the kernel admits-or-enqueues by
 * key; a fresh event after a crash re-admits the run); the Ledger
 * dedupes deliveries by content; the world merging or closing is
 * `settle` — a merge is the verdict delivered, however it happened.
 */
export const PullRequestsLive = Layer.effect(
  PullRequests,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const listPullRequests = yield* GitHub.ListPullRequests(testAlchemy);
    const pullRequests = yield* PullRequestsAgent;

    yield* GitHub.consumeRepositoryEvents(
      testAlchemy,
      {
        events: [
          GitHub.PullRequestOpened,
          GitHub.PullRequestMerged,
          GitHub.PullRequestClosed,
          // comments ON pull requests (GitHub's one comment door
          // serves both thread kinds; issue-thread ones are skipped
          // below) — the wake channel for a parked review thread
          GitHub.IssueCommented,
        ],
      },
      (event) =>
        Effect.gen(function* () {
          if (
            event._tag === "IssueCommented" &&
            !GitHub.isPullRequestComment(event)
          ) {
            return; // an ISSUE thread — the Issues desk's
          }
          const key = GitHub.eventKey(event)!;
          const { status } = yield* ledger.offer(
            "pull-requests",
            JSON.stringify(event),
            event,
          );
          if (status === "duplicate") return;
          yield* Match.value(event).pipe(
            Match.tag("PullRequestMerged", "PullRequestClosed", (e) =>
              pullRequests.settle(key, e),
            ),
            Match.orElse((e) => pullRequests.send(e, { key })),
          );
        }),
    );

    return {
      list: () => listPullRequests({ state: "open" }),
    };
  }),
).pipe(Layer.provide(Layer.suspend(() => PullRequestsAgentLive)));

/** The loop behind the desk — {@link PullRequestsLive} wires the world to it. */
export class PullRequestsAgent extends AI.Agent<PullRequestsAgent>()(
  "PullRequests",
) {}

export const PullRequestsAgentLive = PullRequestsAgent.make`
  This process drives every pull request in ${testAlchemy} to a
  verdict — the factory's own and human contributors' alike.

  Each ${GitHub.PullRequestOpened} goes to ${Reviewer}, which reads
  the pull request itself (body, linkage, diff) and returns a
  complete verdict in one round.

  A review that requests changes is relayed to the author with
  ${Comment} in the Reviewer's own words. An approval is followed by
  ${MergePullRequest} — an approved-but-unmerged pull request is
  unfinished work. The merge tool refuses without an approved review;
  a refusal is a fact about the world to fix, not to work around.

  A ${GitHub.IssueCommented} on the pull request resumes this
  process: re-read the state and act on what stands. A
  ${GitHub.PullRequestMerged} or ${GitHub.PullRequestClosed} ends its
  involvement — the verdict was delivered, however it happened. A
  pull request whose author has gone quiet stays open with its review
  attached; closing other people's work is a human's call.`;
