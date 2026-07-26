/**
 * The standalone pull-request desk — reviewer and merge authority for
 * pull requests that belong to NO issue channel (a human contributor's
 * PR with no recorded or cited issue). Linked PRs never come here:
 * their events flow into the issue's channel (issues.ts), which
 * dispatches the ${Reviewer} worker and merges.
 *
 * The Issues and Discord owners deliberately do NOT reference
 * ${MergePullRequest}; capability-by-omission keeps merge authority
 * with this desk and the issue channel alone.
 *
 * SEALED in practice: {@link PullRequests} is a plain
 * `Context.Service` resolving to {@link PullRequestsService} and
 * nothing else — the desk agent is addressed only by the router in
 * issues.ts; work enters through GitHub or not at all.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "./Repos.ts";
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

/** The read-only status surface (events are routed by issues.ts). */
export const PullRequestsLive = Layer.effect(
  PullRequests,
  Effect.gen(function* () {
    const listPullRequests = yield* GitHub.ListPullRequests(testAlchemy);
    return {
      list: () => listPullRequests({ state: "open" }),
    };
  }),
);

/** The desk's loop — the router in issues.ts addresses it, one run
 * per unlinked pull request, keyed `owner/repo#n`. */
export class PullRequestReviewer extends AI.Agent<PullRequestReviewer>()(
  "PullRequestReviewer",
) {}

export const PullRequestReviewerLive = PullRequestReviewer.make`
  This process reviews and merges pull requests in ${testAlchemy}
  that cite no issue — a contributor's standalone change. You did not
  write this code and never saw its author's reasoning; you judge the
  artifact.

  ${ReadDiff} is the change — the pull request's title, body, and the
  diff itself. With no issue to supply acceptance criteria, the PR
  body's own claims are the rubric (${ReadIssue} reads an issue when
  the body turns out to cite one after all).

  The verdict is complete in one round: ${Approve} followed by
  ${MergePullRequest} when the change is correct and self-contained —
  an approved-but-unmerged pull request is unfinished work — or one
  ${Comment} listing every concrete problem the author must fix. The
  merge tool refuses without a recorded approval; a refusal is a fact
  about the world to fix, not to work around.

  A comment on the pull request resumes this process: re-read the
  state and act on what stands. A merge or close ends its involvement.
  A pull request whose author has gone quiet stays open with its
  review attached; closing other people's work is a human's call.`;
