/**
 * The pull-request train: {@link GitHubPullRequests} — shepherds a pull
 * request from open to merged — plus {@link GitHubPullRequestsLive},
 * its ONE implementation. Same shape as issues.ts: the term declares
 * the interface; the Layer owns delivery against the three seams
 * (arrival, ledger, kernel); the environment is the provide-list.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import { Reviewer } from "./agents.ts";
import { Ledger } from "./ledger.ts";
import { testAlchemy } from "./repos.ts";
import { Comment, MergePullRequest } from "./tools.ts";

export interface PullRequestRef {
  readonly number: number;
  readonly title: string;
  readonly url: string;
}

// ─── the term ──────────────────────────────────────────────────────

export class GitHubPullRequests extends AI.Process<
  GitHubPullRequests,
  {
    listOpen(): Effect.Effect<ReadonlyArray<PullRequestRef>>;
  }
>()("GitHubPullRequests")`
You shepherd pull requests for the test-alchemy repository from open
to merged.

${AI.when(GitHub.PullRequestOpened(testAlchemy))}, have ${Reviewer}
review it against its originating issue — the diff and the spec,
nothing else. If the review requests changes, ${Comment} them on the
pull request and wait for the conversation to move. Once approved,
${MergePullRequest} — it refuses to merge without an approved review.

The merge is what ends this work — or a maintainer closing the pull
request unmerged. You never declare it done yourself.` {}

// ─── the ONE implementation ────────────────────────────────────────

/** The ledger queue this process admits into. */
const QUEUE = "pull-requests";

// the Layer type is inferred — see the note on GitHubIssuesLive
export const GitHubPullRequestsLive = Layer.effect(
  GitHubPullRequests,
  Effect.gen(function* () {
    const kernel = yield* AI.Kernel;
    const ledger = yield* Ledger;
    // the domain method's physics: the GitHub API binding, bound once
    const listPullRequests = yield* GitHub.ListPullRequests(testAlchemy);

    // defect at Layer build, never a consumer-visible error — see issues.ts
    const inner = yield* kernel.interpret(GitHubPullRequests).pipe(Effect.orDie);

    // It's just routing.
    yield* GitHub.consumeRepositoryEvents(
      testAlchemy,
      { events: ["pull_request"] },
      (event) =>
        Match.value(event).pipe(
          // the machine exit: the merge — exit delivery is delivery
          Match.tag("PullRequestMerged", (event) =>
            Effect.gen(function* () {
              const key = GitHub.eventKey(event)!;
              yield* ledger.settle(QUEUE, key);
              yield* Effect.log(`[pull-requests] settled ${key} (merged)`);
              yield* inner.settle(key, event);
            }),
          ),
          Match.tag("PullRequestOpened", (event) =>
            Effect.gen(function* () {
              const key = GitHub.eventKey(event)!;
              const { status } = yield* ledger.offer(QUEUE, key, event);
              yield* Effect.log(`[pull-requests] ${status} ${key}`);
              yield* status === "accepted"
                ? inner.send(event, { key })
                : inner.steer(key, event);
            }),
          ),
          // close-without-merge: not this process's message
          Match.orElse(() => Effect.void),
        ),
    );

    // the declared interface is the WHOLE service (the tag is sealed):
    // the actor verbs stay internal — delivery goes through the drive
    // loop above, never around the ledger
    return {
      // wire failures are defects — the interface declares no
      // wire-error channel
      listOpen: () =>
        listPullRequests({ state: "open", per_page: 100 }).pipe(
          Effect.map((pulls) =>
            pulls.map((pull) => ({
              number: pull.number,
              title: pull.title,
              url: pull.html_url,
            })),
          ),
          Effect.orDie,
        ),
    };
  }),
);
