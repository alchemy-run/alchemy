import * as TypeSafe from "alchemy/TypeSafe";
import * as Effect from "effect/Effect";

/**
 * THE GATE — what happens to a message the moment it lands.
 *
 * Every message used to wake the channel's resident, who answered in a
 * thread: a greeting and a week of work got the same ceremony. The gate
 * is the reflex judgment in front of that — one System One call
 * (~100ms) that decides whether the message deserves nothing, a reply in
 * the stream, or a thread with someone working in it, and WHO answers.
 * The agents stay the deliberate half; this only decides which of them
 * wakes up, if any.
 *
 * Judgment is advisory, never load-bearing: below {@link CONFIDENT} —
 * or if TypeSafe is unreachable — the message takes the old path (the
 * resident answers in a thread), so the channel keeps working no matter
 * what System One says.
 */
export type Disposition = "ignore" | "inline" | "thread";

/** The roster a message can be routed to. */
export type Respondent = "head" | "manager" | "engineer" | "reviewer";

/**
 * How sure the judgment must be to act on it. A coin-flip between
 * "inline" and "thread" is exactly the case where the old behavior (a
 * thread, the resident) is the safer answer: over-serving a message
 * costs a session, under-serving it loses the work.
 */
export const CONFIDENT = 0.6;

const questions = {
  disposition: TypeSafe.Choice(
    "How much does `message` deserve, posted in `channel` by a human?",
    {
      ignore: {
        what: "Nothing is being asked: an acknowledgement, a reaction, an aside, a one-word remark, a thank-you",
        notFor:
          "Anything containing a question, a request, or information the team must act on",
        examples: ["nothing", "ok", "lol", "thanks!", "👍", "nice"],
      },
      inline: {
        what: "A question answerable in one message from what the team already knows — status, a definition, a preference, a small clarification",
        notFor:
          "Anything needing the repository read, code changed, or several steps",
        examples: [
          "what is the org working on right now?",
          "who owns the Cloudflare provider?",
          "is the dev server on 1337 or 1340?",
        ],
      },
      thread: {
        what: "Real work: investigating, reading or changing code, running tests, anything worth tracking as its own piece of work",
        notFor: "Questions answerable in a sentence, and remarks",
        examples: [
          "the dev worker OOMs importing distilled — dig into the pack ingest path",
          "please add a Railway volume resource with tests",
          "review #1594 and tell me if the storage math is right",
        ],
      },
    },
  ),
  respondent: TypeSafe.Choice(
    "Who should answer `message` first? Prefer the person closest to the work; anyone can pull in a colleague.",
    {
      head: {
        what: "Company-level direction: priorities, what the org is doing, announcements, decisions about people or scope",
        notFor: "Concrete technical questions and specific pieces of work",
        examples: ["what should we focus on this week?"],
      },
      manager: {
        what: "Intake and coordination: filing work, status of work in flight, anything spanning several people",
        notFor: "A question with one obviously technical answer",
        examples: ["where did the pack ingest work land?"],
      },
      engineer: {
        what: "The code itself: how it works, what it does, changing it, bugs, tests",
        notFor: "Questions about priorities or process",
        examples: ["why does the driver leak sessions?"],
      },
      reviewer: {
        what: "Judgment on work already done: review standards, whether a change is correct, verdicts on a PR",
        notFor: "Writing new code or planning",
        examples: ["is #1594 safe to merge?"],
      },
    },
  ),
};

export interface Verdict {
  readonly disposition: Disposition;
  readonly respondent: Respondent;
  /** Confidence in the disposition — the value {@link CONFIDENT} gates. */
  readonly confidence: number;
}

export interface Message {
  readonly channel: string;
  readonly message: string;
  /** Who is in the room, so the judgment routes to someone real. */
  readonly roster: ReadonlyArray<string>;
  readonly [field: string]: unknown;
}

/**
 * Judge one message. Answers `undefined` when the judgment is too close
 * to act on or System One refuses — the caller falls back to the
 * resident-in-a-thread path.
 */
export const judge = Effect.fn("root/Gate.judge")(function* (
  query: typeof TypeSafe.SystemOne.Service,
  state: Message,
) {
  const verdict = yield* query(questions, { state }).pipe(
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning("gate: judgment unavailable", cause),
        undefined,
      ),
    ),
  );
  if (verdict === undefined) return undefined;

  const disposition = TypeSafe.asChoice(verdict.answers.disposition);
  if (disposition === undefined || disposition.confidence < CONFIDENT) {
    return undefined;
  }
  return {
    disposition: verdict.value.disposition,
    respondent: verdict.value.respondent,
    confidence: disposition.confidence,
  } satisfies Verdict;
});
