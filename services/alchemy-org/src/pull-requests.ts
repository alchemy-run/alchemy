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
        ],
      },
      (event) =>
        Effect.gen(function* () {
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

  Each ${GitHub.PullRequestOpened} goes straight to ${Reviewer} — the
  reviewer reads the pull request itself (body, linkage, diff), so it
  needs nothing from you but the PR reference. The review is a VERDICT,
  delivered in one round: never ask the reviewer twice, never wait for
  answers no one will give.

  A review that requests changes is relayed with ${Comment}, exactly —
  the author hears the Reviewer's words, not a summary. A review that
  approves is followed IMMEDIATELY by ${MergePullRequest} in the same
  turn. The merge tool itself refuses without an approved review; a
  refusal is a fact about the world to fix, never to work around.

  A ${GitHub.PullRequestMerged} or ${GitHub.PullRequestClosed} ends
  this process's involvement — the verdict was delivered, however it
  happened. A pull request whose author has gone quiet after requested
  changes stays open with its review attached — closing other people's
  work is a human's call, and this process never makes it.`;
