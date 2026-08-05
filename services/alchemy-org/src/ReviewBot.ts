/**
 * The REVIEW BOT — the whole product, in one file:
 *
 * ONE agent, ONE durable thread per pull request. A PR opened on the
 * repository admits its thread; every comment on it arrives as the
 * next message; merge or close settles it. The bot reads the diff,
 * checks out the PR's actual head, verifies the claims by reading and
 * RUNNING the code, and answers with one review comment.
 *
 * The shape of the thing (the framework doing its job):
 *
 * - {@link ReviewBot}    — the agent: a bare tag.
 * - {@link ReviewBotLive} — the charter: INIT (once per PR — check
 *   out `pull/N/head`, mint the tools) returning the STANCE (the
 *   system prompt, re-rendered before every sampling; the tools it
 *   mentions ARE the toolkit).
 * - {@link ReviewBotEvents} — the router: GitHub events → threads.
 *   Routing is code, not charter.
 */
import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "./Repos.ts";
import { Ledger } from "./services/Ledger.ts";
import { QualityAssurance } from "./skills/QualityAssurance.ts";
import { ReadDiff, ReadIssue } from "./tools/index.ts";
import { message } from "./Vocabulary.ts";

export class ReviewBot extends AI.Agent<ReviewBot>()("ReviewBot") {}

/**
 * Every comment the bot posts carries this invisible marker, and the
 * router skips comment events that contain it — the bot never wakes
 * on its own words. Deterministic; no identity lookup.
 */
const SIGNATURE = "<!-- review-bot -->";

/** `owner/repo#N` → N — the thread's key names its pull request. */
const prNumber = (key: string): number => Number(key.match(/#(\d+)$/)?.[1]);

export const ReviewBotLive = ReviewBot.make(
  Effect.gen(function* () {
    // ── INIT: once per pull request ─────────────────────────────────
    const workspaces = yield* Git.Workspaces;
    const createComment = yield* GitHub.CreateIssueComment(testAlchemy);
    const thread = yield* AI.Thread;
    const number = prNumber(thread.key);

    // The PR's ACTUAL code, not just its diff: `pull/N/head` is where
    // GitHub serves every PR's tip (fork PRs included). `fresh: true`
    // so a re-activated thread reviews the head as it is now.
    const checkout = workspaces
      .checkout({
        key: thread.key,
        remote: GitHub.remote(testAlchemy),
        ref: `pull/${number}/head`,
        fresh: true,
      })
      .pipe(Effect.mapError((error) => error.message));
    yield* checkout.pipe(Effect.orDie);

    const sync = yield* AI.Tool("sync_checkout")`
      Re-fetch the pull request's head into your checkout — call it
      first when the author says they pushed changes, so you review
      the code as it is NOW.`(
      Effect.fn(function* () {
        const workspace = yield* checkout;
        return `checkout at ${workspace.path} is at the latest pull/${number}/head`;
      }),
    );

    const comment = yield* AI.Tool("comment")`
      Post ${message} as a comment on the pull request — your one
      voice. Markdown; complete; you will not get to clarify.`(
      Effect.fn(function* (p: { message: string }) {
        const created = yield* createComment({
          issue_number: number,
          body: `${p.message}\n\n${SIGNATURE}`,
        }).pipe(
          Effect.mapError(
            (error) => `${error.operation} failed: ${error.message}`,
          ),
        );
        return `commented: ${created.html_url}`;
      }),
    );

    // ── the STANCE: one static system prompt for the PR's whole life
    return AI.prose`
      You review one pull request in ${testAlchemy}; this thread is
      its whole life — the opening event, every comment, and your own
      replies. You did not write this code and never saw its author's
      reasoning: independent judgment is your value.

      ${ReadDiff} is the change: title, body, and the unified diff.
      When the body cites an issue ("Closes #N"), ${ReadIssue} is the
      spec: its acceptance criteria, exactly as written, are your
      ENTIRE rubric — a diff that satisfies them is done, however
      small, and scope is part of the rubric (a change the issue never
      asked for is a problem like any other). A pull request citing no
      issue is judged against its own claims: the title and body are
      the rubric, and self-containment is part of it.

      Your tools operate inside a checkout of the pull request's HEAD
      — ${QualityAssurance} is how you verify: read the changed files
      in their surroundings, and run the tests rather than trusting
      anyone's claims. When the author says they pushed changes,
      ${sync} first, then verify again.

      Your verdict is ONE ${comment}, complete in a single round.
      Start it **APPROVE** or **REQUEST CHANGES**; a request lists
      every concrete problem the author must fix, so one fix round
      can address them all. A round that ends without the comment
      posted is an unfinished review — never stop to "verify" or
      "consider"; verify with tools, then post. Answer follow-up
      questions the same way — a comment is your only voice, and you
      hold no merge button. Comments you posted yourself may echo
      back as events: they are your own words — never reply to them.`;
  }),
);

/**
 * The WIRING: every pull-request event reaches its own durable
 * thread. `send` admits on first sight of a key and enqueues
 * thereafter; merge/close settles the thread and releases its
 * checkout. The Ledger dedupes deliveries by content (polling
 * redelivers; the same event must not wake a round twice).
 */
export const ReviewBotEvents = Layer.effectDiscard(
  Effect.gen(function* () {
    const bot = yield* ReviewBot;
    const ledger = yield* Ledger;
    const workspaces = yield* Git.Workspaces;

    yield* GitHub.consumeRepositoryEvents(
      testAlchemy,
      {
        events: [
          GitHub.IssueCommented,
          GitHub.PullRequestClosed,
          GitHub.PullRequestMerged,
          GitHub.PullRequestOpened,
        ],
      },
      (event) =>
        Effect.gen(function* () {
          const { status } = yield* ledger.offer(
            "reviews",
            JSON.stringify(event), // delivery identity: the content itself
            event,
          );
          if (status === "duplicate") return;
          const repo = `${event.repository.owner.login}/${event.repository.name}`;

          switch (event._tag) {
            case "PullRequestOpened":
              return yield* bot.send(event, {
                key: `${repo}#${event.pullRequest.number}`,
              });
            case "IssueCommented": {
              // only PULL REQUEST comments concern the bot — and never
              // its own (the signature marks them)
              if (!GitHub.isPullRequestComment(event)) return;
              if (event.comment.body?.includes(SIGNATURE)) return;
              return yield* bot.send(event, {
                key: `${repo}#${event.issue.number}`,
              });
            }
            case "PullRequestMerged":
            case "PullRequestClosed": {
              const key = `${repo}#${event.pullRequest.number}`;
              yield* bot.settle(key, event);
              // a settled review's worktree is garbage — drop it
              return yield* workspaces
                .release(key)
                .pipe(Effect.catchTag("Git.GitError", () => Effect.void));
            }
          }
        }),
    );
  }),
);
