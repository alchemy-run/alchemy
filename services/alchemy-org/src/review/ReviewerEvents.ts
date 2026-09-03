import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SIGNATURE } from "../github/ProposalActions.ts";
import { Proposals } from "../github/Proposals.ts";
import { primary } from "../github/Repos.ts";
import { Ledger } from "./Ledger.ts";
import { Reviewer } from "./Reviewer.ts";

/**
 * The ROUTER: GitHub events → review sessions. Routing is code, not
 * charter — the reviewer never decides WHETHER to look at a pull
 * request, only what it thinks of it.
 *
 * ONE durable session per pull request, keyed `owner/repo#N`:
 *
 * - **opened** admits the session — the reviewer prepares its review
 *   at once, as a PROPOSAL the operator finds in the inbox.
 * - **synchronize** (the author pushed) wakes it — the reviewer
 *   re-fetches the head, re-verifies, and REVISES its pending review
 *   in place (or files a fresh one when the last was already posted).
 *   A pull request never seen before (opened before this deploy, or
 *   while the poller was down) is admitted by its first push.
 * - **comment** on the thread wakes it — never the reviewer's own
 *   words, which the signature marks.
 * - **merged / closed** settles it: the session ends, its checkout is
 *   released, and every proposal still waiting on that pull request
 *   is WITHDRAWN (declined with the closure as its reason) — the loop
 *   iterates until accept or close, and this is close.
 *
 * The Ledger dedupes deliveries by content (polling redelivers; the
 * same event must not wake a round twice). `send` admits on first
 * sight of a key and enqueues thereafter.
 *
 * Deliveries are verified against `GITHUB_WEBHOOK_SECRET` when the
 * deploying shell has one (the webhook is provisioned with it; the
 * Worker rejects unsigned posts to the delivery path). Without it the
 * path accepts any post — fine for the dev emulator, not for the
 * real repository.
 */
export const ReviewerEvents = Layer.effectDiscard(
  Effect.gen(function* () {
    const reviewer = yield* Reviewer;
    const ledger = yield* Ledger;
    const checkouts = yield* Git.Checkouts;
    const proposals = yield* Proposals;
    const secret = yield* Config.option(
      Config.redacted("GITHUB_WEBHOOK_SECRET"),
    );
    if (Option.isNone(secret)) {
      yield* Effect.logWarning(
        "ReviewerEvents: no GITHUB_WEBHOOK_SECRET — deliveries are accepted unverified",
      );
    }

    yield* GitHub.consumeRepositoryEvents(
      primary,
      {
        events: [
          GitHub.PullRequestOpened,
          GitHub.PullRequestSynchronized,
          GitHub.IssueCommented,
          GitHub.PullRequestClosed,
          GitHub.PullRequestMerged,
        ],
        ...(Option.isSome(secret) ? { secret: secret.value } : {}),
      },
      Effect.fn(function* (event) {
        const { status } = yield* ledger.offer(
          "reviews",
          JSON.stringify(event), // delivery identity: the content itself
          event,
        );
        if (status === "duplicate") return;
        const repo = `${event.repository.owner.login}/${event.repository.name}`;

        switch (event._tag) {
          case "PullRequestOpened":
          case "PullRequestSynchronized":
            return yield* reviewer.send(event, {
              key: `${repo}#${event.pullRequest.number}`,
            });
          case "IssueCommented": {
            // only PULL REQUEST comments concern the reviewer — and
            // never its own (the signature marks them)
            if (!GitHub.isPullRequestComment(event)) return;
            if (event.comment.body?.includes(SIGNATURE)) return;
            return yield* reviewer.send(event, {
              key: `${repo}#${event.issue.number}`,
            });
          }
          case "PullRequestMerged":
          case "PullRequestClosed": {
            const number = event.pullRequest.number;
            const key = `${repo}#${number}`;
            yield* reviewer.settle(key, event);
            // the loop ends with the pull request: whatever the
            // reviewer still had waiting on it is moot
            const waiting = yield* proposals.list({
              repo,
              number,
              status: "pending",
            });
            const closure =
              event._tag === "PullRequestMerged" ? "merged" : "closed";
            yield* Effect.forEach(
              waiting,
              (proposal) =>
                proposals.resolve(proposal.id, {
                  status: "rejected",
                  reason: `pull request #${number} was ${closure}`,
                }),
              { discard: true },
            );
            // a settled review's worktree is garbage — drop it
            return yield* checkouts
              .release(key)
              .pipe(Effect.catchTag("Git.GitError", () => Effect.void));
          }
        }
      }),
    );
  }),
);
