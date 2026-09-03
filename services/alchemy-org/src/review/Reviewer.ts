import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as S from "effect/Schema";
import { Proposals } from "../github/Proposals.ts";
import { primary } from "../github/Repos.ts";
import { path } from "../coding/ReadFile.ts";
import { Harness } from "../Harness.ts";
import { SessionRepo } from "../sandbox/SessionRepo.ts";
import { FindCompanions } from "./Companions.ts";
import { PullRequests } from "./PullRequests.ts";
import { QualityAssurance } from "./QualityAssurance.ts";
import { ReadDiff } from "./ReadDiff.ts";
import { ReadIssue } from "./ReadIssue.ts";

/**
 * The REVIEWER — one agent, ONE durable session per pull request, for
 * the pull request's whole life. The router (`ReviewerEvents.ts`)
 * admits the session when the PR opens, wakes it on every push and
 * every comment, and settles it on merge or close.
 *
 * The reviewer's review is a LIVING DRAFT: it is prepared as a
 * proposal the moment the PR opens, revised in place when the author
 * pushes or the operator asks for changes, and posted to GitHub only
 * when the operator accepts it. Accept, decline, or ask for changes —
 * the loop iterates until accept or the PR closes.
 *
 * - {@link Reviewer}     — the agent: a bare tag.
 * - {@link ReviewerLive} — the charter: INIT (once per PR — mint the
 *   tools) returning the STANCE (the system prompt, re-rendered
 *   before every sampling; the tools it mentions ARE the toolkit).
 *   The reviewer holds no editor: judge, not author, by Layer graph.
 */
export class Reviewer extends AI.Agent<Reviewer>()("Reviewer") {}

/** `owner/repo#N` → N — the session's key names its pull request. */
const prNumber = (key: string): number => Number(key.match(/#(\d+)$/)?.[1]);

/* ── review vocabulary (local to the reviewer) ──────────────────── */

export const message = AI.Parameter("message", S.String)`
The full markdown text. It must stand alone — the reader has no access
to the conversation that produced it.`;

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

/** The review is malformed — bad verdict. The buffered comments
 *  survive for a corrected resubmit. */
class ReviewRejected extends Data.TaggedError("ReviewRejected")<{
  message: string;
}> {}

/** The plain comment is empty. */
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

export const ReviewerLive = Reviewer.make(
  Effect.gen(function* () {
    // ── INIT: once per pull request ─────────────────────────────────
    const checkouts = yield* Git.Checkouts;
    const proposals = yield* Proposals;
    const repos = yield* SessionRepo;
    const thread = yield* AI.Thread;
    const number = prNumber(thread.key);
    const identity = yield* GitHub.resolveRepository(primary);
    const repo = `${identity.owner}/${identity.repository}`;
    const session = { term: "Reviewer", key: thread.key };

    // the review under construction: inline comments buffer here until
    // submit_review files them atomically with the verdict
    const pending = yield* Ref.make<ReadonlyArray<PendingComment>>([]);

    // The PR's ACTUAL code, not just its diff. NOT run at INIT — the
    // machine's tree converges the first time a tool touches it
    // (sandbox/SandboxCheckout.ts, keyed by this session); this is the
    // explicit RE-FETCH for when the author pushed. The ref is the
    // session tree's (the head branch for a same-repo PR, so the tree
    // sits on the PR's branch; `pull/N/head` for a fork).
    const checkout = Effect.gen(function* () {
      const tree = yield* repos
        .resolve(thread.key)
        .pipe(Effect.mapError((message) => new CheckoutFailed({ message })));
      const ref = tree?.ref ?? `pull/${number}/head`;
      const workspace = yield* checkouts
        .checkout({
          key: thread.key,
          remote: tree?.remote ?? GitHub.remote(primary),
          ref,
          fresh: true,
        })
        .pipe(
          Effect.mapError(
            (error) => new CheckoutFailed({ message: error.message }),
          ),
        );
      return { ref, path: workspace.path };
    });

    const sync = yield* AI.Tool("sync_checkout")`
      Re-fetch the pull request's head into your checkout — call it
      first when the author pushed (a "head moved" event, or they say
      so), so you review the code as it is NOW. Fails with
      ${CheckoutFailed} when the fetch cannot complete.`(
      Effect.fn(function* () {
        const { ref, path } = yield* checkout;
        return `checkout at ${path} is at the latest ${ref}`;
      }),
    );

    const addComment = yield* AI.Tool("add_comment")`
      Pin ${message} to ${path} at ${line} (optionally from
      ${startLine}) — one concrete problem, anchored to the exact
      lines that prove it. Comments buffer until submit_review files
      them with the verdict; nothing is visible to anyone before
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
      File the review: your ${verdict} and ${message} — the overview
      the author reads first — together with every buffered
      add_comment, as ONE PROPOSAL for the operator. THIS is your
      verdict's one voice; a round that ends without it is an
      unfinished review. While a review of yours is still awaiting the
      operator, submitting again REVISES it in place (same card,
      updated summary and comments) — so re-verifying after a push, or
      answering the operator's request for changes, replaces the
      draft rather than stacking another. Nothing reaches GitHub until
      the operator accepts. Fails with ${ReviewRejected} when the
      verdict is malformed — the buffer survives for a corrected
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
        const count = `${comments.length} inline comment${comments.length === 1 ? "" : "s"}`;
        const summary = `${p.verdict === "approve" ? "approve" : "request changes on"} #${number} (${count})`;
        const payload = {
          kind: "review",
          number,
          verdict: p.verdict,
          body: p.message,
          comments,
        } as const;

        // the living draft: one review of this session waits at a
        // time — a pending one is revised, never joined by a second
        const waiting = yield* proposals.list({ session, status: "pending" });
        const draft = waiting.find((row) => row.payload.kind === "review");
        if (draft !== undefined) {
          const revised = yield* proposals.revise(draft.id, {
            summary,
            payload,
          });
          if (revised) {
            return (
              `review ${draft.id} REVISED in place (${p.verdict.toUpperCase()}, ` +
              `${count}) — the operator's card is updated; they post it to ` +
              `GitHub, decline it, or ask for more changes. Your round is done.`
            );
          }
        }
        const proposal = yield* proposals.propose({
          session,
          repo,
          summary,
          payload,
        });
        return (
          `review proposed as ${proposal.id} (${p.verdict.toUpperCase()}, ` +
          `${count}) — awaiting the operator, who posts it to GitHub, ` +
          `declines it, or asks for changes from the UI. Your round is done; ` +
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
      submitted approved it and the operator posted it; the operator
      merges from the UI, or declines. You hold no merge button.`(
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
      You review one pull request in ${primary}; this session is its
      whole life — the opening, every push, every comment, and your
      own replies. You did not write this code and never saw its
      author's reasoning: independent judgment is your value. You
      write NOTHING to GitHub yourself: every review, comment, and
      merge you produce is a PROPOSAL the operator accepts, declines,
      or sends back for changes in their UI, and you are told the
      outcome here.

      ${ReadDiff} is the change: title, body, and the unified diff.
      When the body cites an issue ("Closes #N"), ${ReadIssue} is the
      spec: its acceptance criteria, exactly as written, are the
      pull request's rubric — a diff that satisfies them is done,
      however small, and scope is part of the rubric (a change the
      issue never asked for is a problem like any other). A pull
      request citing no issue is judged against its own claims: the
      title and body are the rubric, and self-containment is part of
      it. Beneath either rubric stands the repository's standard —
      the section below — which every pull request is held to.

      ${PullRequests}

      Your tools operate inside a checkout of the pull request's HEAD
      — ${QualityAssurance} is how you verify: read the changed files
      in their surroundings, and run the tests rather than trusting
      anyone's claims; the verification report in the description is
      a claim like any other until you have run what it names.
      ${FindCompanions} finds the companion pull requests in distilled
      and floci by branch name, and 'git ls-tree HEAD distilled' in
      your checkout shows the pin to compare. A diff that touches
      services/alchemy-org — the harness this review runs in — is
      also judged against ${Harness}, the org's own doctrine: activate
      it, and hold the change to the layout, the least-privilege
      topology, and the verification it names. When the head moved (an
      event says so, or the author does), ${sync} first, then verify
      again — the code you reviewed is not the code that is there.

      Your verdict is ONE REVIEW, prepared in the same round that
      admits you — the operator finds it waiting when they look.
      ${addComment} pins each concrete problem to the exact lines that
      prove it — every problem anchored, so one fix round can address
      them all. ${submitReview} closes with the overview and the
      verdict: approving needs no inline comments; requesting changes
      without them is hand-waving. A round that ends without the
      review submitted is an unfinished review — never stop to
      "verify" or "consider"; verify with tools, then submit.

      The review is a LIVING DRAFT until the operator posts it. When
      the author pushes, re-verify and submit again: your pending
      review is revised in place (if the operator already posted the
      last one, a fresh review is filed — a new round of code deserves
      a new verdict). When the operator ASKS FOR CHANGES, their words
      arrive as your next message: do what they ask — re-check what
      they doubt, drop what they overrule, add what they want said —
      and submit again; disagree in the overview if you must, but the
      revised review is your answer, not an argument in chat. When
      they DECLINE, their reason arrives the same way: revise and
      propose again, or explain in a plain ${comment} why you stand
      by it. When they ACCEPT, you are told what landed; a review that
      APPROVED and was posted may be followed by ${proposeMerge} — the
      merge itself is their click.

      Answer the author's follow-up questions with a plain ${comment}
      — conversation carries no verdict. Comments you proposed and the
      operator posted may echo back as events: they are your own words
      — never reply to them.`;
  }),
);
