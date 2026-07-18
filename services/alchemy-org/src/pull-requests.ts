/**
 * The PullRequests process — the repository's ONE merge authority.
 * Every pull request, whether the factory's own Engineer opened it or
 * a human contributor did, passes through this charter: review
 * verdict, then merge or relay changes.
 *
 * The Issues and Discord owners deliberately do NOT reference
 * ${MergePullRequest}; capability-by-omission makes this the only
 * term any Layer could ever grant merge authority to.
 *
 * A PROCESS: its tag is {@link PullRequestsService} and nothing else —
 * nobody outside {@link PullRequestsLive} can `send` a fake
 * pull-request event; work enters through GitHub or not at all.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import {
  PullRequestClosed,
  PullRequestMerged,
  PullRequestOpened,
} from "./events.ts";
import { Ledger } from "./ledger.ts";
import { testAlchemy } from "./repos.ts";
import { Reviewer } from "./reviewer.ts";
import { Comment, MergePullRequest } from "./tools.ts";

/** What the org may ask of the PullRequests owner from code: read, never drive. */
export interface PullRequestsService {
  /** Snapshot of the repository's open pull requests. */
  readonly list: () => Effect.Effect<
    GitHub.ListPullRequestsResponse,
    GitHub.GitHubApiError
  >;
}

export class PullRequests extends AI.Process<
  PullRequests,
  PullRequestsService
>()("PullRequests")`
This process drives every pull request in ${testAlchemy} to a
verdict — the factory's own and human contributors' alike.

Each ${PullRequestOpened} receives a review from ${Reviewer} against
its originating issue. A pull request that names no issue gets one
chance: ${Comment} asks the author to link or state the intent, and
the review proceeds against that statement when it arrives.

A review that requests changes is relayed with ${Comment}, exactly —
the author hears the Reviewer's words, not a summary. A review that
approves, with green checks, is followed by ${MergePullRequest}. The
merge tool itself refuses without an approved review; a refusal is a
fact about the world to fix, never to work around.

A ${PullRequestMerged} or ${PullRequestClosed} ends this process's
involvement — the verdict was delivered, however it happened. A pull
request whose author has gone quiet after requested changes stays
open with its review attached — closing other people's work is a
human's call, and this process never makes it.` {}

/**
 * The implementation: one run per pull request, keyed `owner/repo#n`.
 * Opening is `send` (Ledger-deduped), the conversation moving is
 * `steer`, the world merging or closing is `settle` — a merge is the
 * verdict delivered, however it happened.
 */
export const PullRequestsLive = Layer.effect(
  PullRequests,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const listPullRequests = yield* GitHub.ListPullRequests(testAlchemy);
    const pullRequests = yield* AI.interpret(PullRequests);

    yield* GitHub.consumeRepositoryEvents(
      testAlchemy,
      { events: ["pull_request"] },
      (event) =>
        Match.value(event).pipe(
          Match.tag("PullRequestOpened", (event) =>
            Effect.gen(function* () {
              const key = GitHub.eventKey(event)!;
              const { status } = yield* ledger.offer(
                "pull-requests",
                key,
                event,
              );
              yield* status === "accepted"
                ? pullRequests.send(event, { key })
                : pullRequests.steer(key, event);
            }),
          ),
          Match.tag("PullRequestMerged", "PullRequestClosed", (event) =>
            Effect.gen(function* () {
              const key = GitHub.eventKey(event)!;
              yield* pullRequests.settle(key, event);
              yield* ledger.settle("pull-requests", key);
            }),
          ),
          Match.exhaustive,
        ),
    );

    return {
      list: () => listPullRequests({ state: "open" }),
    };
  }),
);
