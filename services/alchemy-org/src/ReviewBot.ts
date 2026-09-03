import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as S from "effect/Schema";
import { SIGNATURE } from "./lib/ProposalActions.ts";
import { primary } from "./Repos.ts";
import { Ledger } from "./services/Ledger.ts";
import { Proposals } from "./services/Proposals.ts";
import { QualityAssurance } from "./skills/QualityAssurance.ts";
import { ReadDiff, ReadIssue } from "./tools/index.ts";
import { message, path } from "./Vocabulary.ts";

/**
 * The REVIEW BOT — the whole review pipeline, in one file:
 *
 * ONE agent, ONE durable session per pull request. A PR opened on the
 * repository admits its session; every comment on it arrives as the
 * next message; merge or close settles it. The bot reads the diff,
 * checks out the PR's actual head, verifies the claims by reading and
 * RUNNING the code, and answers with one review.
 *
 * The shape of the thing (the framework doing its job):
 *
 * - {@link ReviewBot}    — the agent: a bare tag.
 * - {@link ReviewBotLive} — the charter: INIT (once per PR — check
 *   out `pull/N/head`, mint the tools) returning the STANCE (the
 *   system prompt, re-rendered before every sampling; the tools it
 *   mentions ARE the toolkit).
 * - {@link ReviewBotEvents} — the router: GitHub events → sessions.
 *   Routing is code, not charter.
 */
export class ReviewBot extends AI.Agent<ReviewBot>()("ReviewBot") {}

/** `owner/repo#N` → N — the session's key names its pull request. */
const prNumber = (key: string): number => Number(key.match(/#(\d+)$/)?.[1]);

/* ── review vocabulary (local to the bot) ─────────────────────── */

const line = AI.Parameter("line", S.Int)`
The line in the pull request's HEAD version of the file that the
comment is anchored to — the LAST line when commenting a range. It
must be a line the diff shows (added or context); GitHub rejects
anchors outside the diff.
`;

const startLine = AI.Parameter("startLine", S.optionalKey(S.Int))`
For a multi-line comment: the FIRST line of the range (strictly less
than the anchor line). Omit for a single-line comment.`;

const verdict = AI.Parameter(
  "verdict",
  S.Literals(["approve", "request_changes"]),
)`
"approve" when the diff satisfies its rubric; "request_changes" when
the pending inline comments list what a fix round must address.`;

const mergeMethod = AI.Parameter(
  "mergeMethod",
  S.Literals(["squash", "merge", "rebase"]),
)`
How the pull request lands on its base: "squash" (the default here —
one commit per pull request), "merge" (a merge commit), or "rebase".`;

/* ── the tools' DECLARED failures (error mention-is-presence) ────── */

/** The pull request's head could not be fetched into the checkout. */
class CheckoutFailed extends Data.TaggedError("CheckoutFailed")<{
  message: string;
}> {}

/** A comment range whose startLine is not strictly before its line. */
class InvalidRange extends Data.TaggedError("InvalidRange")<{
  message: string;
}> {}

/** GitHub rejected the review — bad anchors, permissions. The buffered
 *  comments were discarded; re-add corrected ones and submit again. */
class ReviewRejected extends Data.TaggedError("ReviewRejected")<{
  message: string;
}> {}

/** GitHub rejected the plain comment. */
class CommentFailed extends Data.TaggedError("CommentFailed")<{
  message: string;
}> {}

/** One buffered inline comment, in GitHub's createReview shape. */
interface PendingComment {
  readonly path: string;
  readonly line: number;
  readonly start_line?: number;
  readonly body: string;
}

/**
 * The WIRING: every pull-request event reaches its own durable
 * session. `send` admits on first sight of a key and enqueues
 * thereafter; merge/close settles the session and releases its
 * checkout. The Ledger dedupes deliveries by content (polling
 * redelivers; the same event must not wake a round twice).
 */
export const ReviewBotEvents = Layer.effectDiscard(
  Effect.gen(function* () {
    const bot = yield* ReviewBot;
    const ledger = yield* Ledger;
    const checkouts = yield* Git.Checkouts;

    yield* GitHub.consumeRepositoryEvents(
      primary,
      {
        events: [
          GitHub.IssueCommented,
          GitHub.PullRequestClosed,
          GitHub.PullRequestMerged,
          GitHub.PullRequestOpened,
        ],
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
            return yield* checkouts
              .release(key)
              .pipe(Effect.catchTag("Git.GitError", () => Effect.void));
          }
        }
      }),
    );
  }),
);

export const ReviewBotLive = ReviewBot.make(
  Effect.gen(function* () {
    // ── INIT: once per pull request ─────────────────────────────────
    const checkouts = yield* Git.Checkouts;
    const proposals = yield* Proposals;
    const thread = yield* AI.Thread;
    const number = prNumber(thread.key);
    const identity = yield* GitHub.resolveRepository(primary);
    const repo = `${identity.owner}/${identity.repository}`;
    const session = { term: "ReviewBot", key: thread.key };

    // the review under construction: inline comments buffer here until
    // submit_review files them atomically with the verdict
    const pending = yield* Ref.make<ReadonlyArray<PendingComment>>([]);

    // The PR's ACTUAL code, not just its diff: `pull/N/head` is where
    // GitHub serves every PR's tip (fork PRs included). NOT run at INIT
    // — the machine's tree converges the first time a tool touches it
    // (services/SandboxCheckout.ts, keyed by this session); this is the
    // explicit RE-FETCH for when the author pushed.
    const checkout = checkouts
      .checkout({
        key: thread.key,
        remote: GitHub.remote(primary),
        ref: `pull/${number}/head`,
        fresh: true,
      })
      .pipe(Effect.mapError((error) => error.message));

    const sync = yield* AI.Tool("sync_checkout")`
      Re-fetch the pull request's head into your checkout — call it
      first when the author says they pushed changes, so you review
      the code as it is NOW. Fails with ${CheckoutFailed} when the
      fetch cannot complete.`(
      Effect.fn(function* () {
        const workspace = yield* checkout.pipe(
          Effect.mapError((message) => new CheckoutFailed({ message })),
        );
        return `checkout at ${workspace.path} is at the latest pull/${number}/head`;
      }),
    );

    const addComment = yield* AI.Tool("add_comment")`
      Pin ${message} to ${path} at ${line} (optionally from
      ${startLine}) — one concrete problem, anchored to the exact
      lines that prove it. Comments buffer until submit_review posts
      them as one review; nothing is visible to the author before
      that. Fails with ${InvalidRange} when startLine is not
      strictly before line.`(
      Effect.fn(function* (p: {
        message: string;
        path: string;
        line: number;
        startLine?: number;
      }) {
        if (p.startLine !== undefined && p.startLine >= p.line) {
          return yield* Effect.fail(
            new InvalidRange({
              message: `startLine (${p.startLine}) must be strictly less than line (${p.line})`,
            }),
          );
        }
        const count = yield* Ref.modify(pending, (buffered) => {
          const next = [
            ...buffered,
            {
              path: p.path,
              line: p.line,
              ...(p.startLine !== undefined && { start_line: p.startLine }),
              body: p.message,
            },
          ];
          return [next.length, next];
        });
        return `buffered comment ${count} on ${p.path}:${p.line}`;
      }),
    );

    const submitReview = yield* AI.Tool("submit_review")`
      Submit the review: your ${verdict} and ${message} — the overview
      the author reads first — filed atomically with every buffered
      add_comment as ONE PROPOSAL for the operator. THIS is your
      verdict's one voice; a round that ends without it is an
      unfinished review. Nothing reaches GitHub until the operator
      accepts the proposal in the UI; if they decline, you are told
      why and can revise. Fails with ${ReviewRejected} when the
      proposal is malformed — the buffer survives for a corrected
      resubmit.`(
      Effect.fn(function* (p: { verdict: string; message: string }) {
        if (p.verdict !== "approve" && p.verdict !== "request_changes") {
          return yield* Effect.fail(
            new ReviewRejected({
              message: `verdict must be "approve" or "request_changes", got ${JSON.stringify(p.verdict)}`,
            }),
          );
        }
        const comments = yield* Ref.getAndSet(pending, []);
        const proposal = yield* proposals.propose({
          session,
          repo,
          summary: `${p.verdict === "approve" ? "approve" : "request changes on"} #${number} (${comments.length} inline comment${comments.length === 1 ? "" : "s"})`,
          payload: {
            kind: "review",
            number,
            verdict: p.verdict,
            body: p.message,
            comments,
          },
        });
        return (
          `review proposed as ${proposal.id} (${p.verdict.toUpperCase()}, ` +
          `${comments.length} inline comment(s)) — awaiting the operator, who ` +
          `posts it to GitHub or declines it from the UI. Your round is done; ` +
          `you will be told the outcome.`
        );
      }),
    );

    const comment = yield* AI.Tool("comment")`
      Propose ${message} as a plain comment on the pull request thread
      — conversation, not verdict: answering the author's question,
      noting what you are waiting on. Markdown; complete; you will not
      get to clarify. The operator posts it from the UI. Fails with
      ${CommentFailed} when the message is empty.`(
      Effect.fn(function* (p: { message: string }) {
        if (p.message.trim().length === 0) {
          return yield* Effect.fail(
            new CommentFailed({ message: "an empty comment has nothing to say" }),
          );
        }
        const proposal = yield* proposals.propose({
          session,
          repo,
          summary: `comment on #${number}`,
          payload: { kind: "comment", number, body: p.message },
        });
        return `comment proposed as ${proposal.id} — awaiting the operator`;
      }),
    );

    const proposeMerge = yield* AI.Tool("propose_merge")`
      Propose MERGING the pull request with ${mergeMethod} and
      ${message} (the one-line case for merging now — what was
      verified, what the review found). Only after a review you
      submitted approved it; the operator merges from the UI, or
      declines. You hold no merge button.`(
      Effect.fn(function* (p: { mergeMethod: string; message: string }) {
        const method =
          p.mergeMethod === "merge" || p.mergeMethod === "rebase"
            ? p.mergeMethod
            : ("squash" as const);
        const proposal = yield* proposals.propose({
          session,
          repo,
          summary: `${method}-merge #${number}: ${p.message}`,
          payload: { kind: "merge", number, method },
        });
        return `merge proposed as ${proposal.id} (${method}) — awaiting the operator`;
      }),
    );

    // ── the STANCE: one static system prompt for the PR's whole life
    return AI.fragment`
      You review one pull request in ${primary}; this session is
      its whole life — the opening event, every comment, and your own
      replies. You did not write this code and never saw its author's
      reasoning: independent judgment is your value. You write NOTHING
      to GitHub yourself: every review, comment, and merge you produce
      is a PROPOSAL the operator accepts or declines in their UI, and
      you are told the outcome here.

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

      Your verdict is ONE REVIEW, built then submitted in a single
      round. ${addComment} pins each concrete problem to the exact
      lines that prove it — every problem anchored, so one fix round
      can address them all. ${submitReview} closes with the overview
      and the verdict: approving needs no inline comments; requesting
      changes without them is hand-waving. A round that ends without
      the review submitted is an unfinished review — never stop to
      "verify" or "consider"; verify with tools, then submit. Answer
      follow-up questions with a plain ${comment} — conversation
      carries no verdict. When a review you submitted APPROVED the
      change and the operator accepted it, you may ${proposeMerge};
      the merge itself is the operator's click. When the operator
      DECLINES a proposal, their reason arrives as your next message:
      revise and propose again, or explain why you stand by it.
      Comments you proposed and the operator posted may echo back as
      events: they are your own words — never reply to them.`;
  }),
);
