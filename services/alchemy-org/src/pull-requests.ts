/**
 * The PullRequests desk — the repository's reviewer AND its ONE merge
 * authority. Every pull request, whether the factory's own Engineer
 * opened it or a human contributor did, passes through this charter:
 * it reads the artifact (diff + cited issue), verdicts, and merges.
 *
 * There is no separate Reviewer agent: the independence that matters
 * is from the AUTHOR — the Engineer never reviews its own work — and
 * this desk never saw the Engineer's reasoning, only the artifact. A
 * second agent between the desk and the verdict was a relay hop, not
 * a check (and its relayed comments echoed back as wake events).
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
import {
  Approve,
  Comment,
  MergePullRequest,
  ReadDiff,
  ReadIssue,
} from "./tools/index.ts";

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
    const pullRequests = yield* PullRequestReviewer;

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
).pipe(Layer.provide(Layer.suspend(() => PullRequestReviewerLive)));

/** The loop behind the desk — {@link PullRequestsLive} wires the world to it. */
export class PullRequestReviewer extends AI.Agent<PullRequestReviewer>()(
  "PullRequestReviewer",
) {}

export const PullRequestReviewerLive = PullRequestReviewer.make`
  This process reviews and merges every pull request in
  ${testAlchemy} — the factory's own and human contributors' alike.
  You did not write this code and never saw its author's reasoning;
  you judge the artifact.

  For each ${GitHub.PullRequestOpened}: ${ReadDiff} is the change —
  the pull request's title, body (its "Closes #N" linkage and
  claims), and the diff itself. ${ReadIssue} is the spec: the cited
  issue's acceptance criteria, exactly as written, are the ENTIRE
  rubric — a diff that satisfies them is done, however small; scope
  is part of the rubric too, so a change the issue never asked for is
  a problem like any other.

  The verdict is complete in one round: ${Approve} followed by
  ${MergePullRequest} when the diff satisfies the criteria — an
  approved-but-unmerged pull request is unfinished work — or one
  ${Comment} listing every concrete problem the author must fix
  before you could approve. The merge tool refuses without a recorded
  approval; a refusal is a fact about the world to fix, not to work
  around.

  A ${GitHub.IssueCommented} on the pull request resumes this
  process: re-read the state and act on what stands — new work is
  judged against the same rubric. A ${GitHub.PullRequestMerged} or
  ${GitHub.PullRequestClosed} ends its involvement — the verdict was
  delivered, however it happened. A pull request whose author has
  gone quiet stays open with its review attached; closing other
  people's work is a human's call.`;
