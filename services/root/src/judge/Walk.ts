import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/**
 * THE WALK — a sequence of recursive System One calls that explores
 * a graph by accumulating micro decisions. Instead of one wide
 * judgment (or an LLM making tool calls), the walk orchestrates
 * A → B → C: each step builds a query from the ACCUMULATED state,
 * reads the typed answer, and decides — commit, ask another
 * question, or expand a node (the program fetches content, appends
 * the findings to the accumulator, and re-asks). System One is fast
 * and cheap enough that asking again is practically free; what is
 * bounded is the WALK, never the curiosity: at most {@link WALK_BUDGET}
 * steps (hard cap {@link WALK_STEP_CAP}), and a judge that stops
 * answering settles the walk from what it has — degrade, never break.
 *
 * Every step lands in the TRACE — question gist, answer, conviction,
 * what was expanded, elapsed — so a walk's decision is inspectable
 * after the fact (the board's trace panel renders exactly this).
 */

/** One recorded step of a walk — the decision chain's unit. */
export interface WalkStep {
  /** The gist of what was asked (not the wire rubric). */
  readonly question: string;
  /** The decoded answer, rendered short. */
  readonly answer: string;
  /** The winner's probability mass (or the answer's confidence). */
  readonly conviction: number;
  /** Content ids this step drilled into (task bodies, threads…). */
  readonly expanded: ReadonlyArray<string>;
  readonly elapsedMs: number;
}

/** How a walk ended: a committed decision, the step budget, or a
 *  judge that stopped answering (the caller's fallback settled it). */
export type WalkEnd = "decided" | "budget" | "fallback";

export interface WalkResult<A> {
  readonly value: A;
  readonly trace: ReadonlyArray<WalkStep>;
  /** Every content id the walk drilled into, in drill order. */
  readonly expanded: ReadonlyArray<string>;
  readonly ended: WalkEnd;
}

/** What one step tells the walk to do next. */
export type WalkMove<S, A> =
  /** Commit — the walk ends with this value. */
  | { readonly kind: "done"; readonly value: A }
  /** Keep walking — the accumulator grew (findings, decisions). */
  | { readonly kind: "continue"; readonly state: S }
  /** The judge is unreachable — settle from the state, cleanly. */
  | { readonly kind: "abort" };

/** One step's outcome: the move plus its trace record. */
export interface WalkStepOutcome<S, A> {
  readonly move: WalkMove<S, A>;
  readonly question: string;
  readonly answer: string;
  readonly conviction: number;
  readonly expanded?: ReadonlyArray<string>;
}

/** Default step budget per walk. */
export const WALK_BUDGET = 8;

/** The hard ceiling no caller-supplied budget may exceed. */
export const WALK_STEP_CAP = 16;

/**
 * Run one walk: `initial` state, a `step` that asks and decides, a
 * `settle` for the two non-committed ends (budget exhausted, judge
 * unreachable). The step function owns the query (typed questions,
 * full inference) and MUST swallow judge failures into an `abort`
 * move (`tryQuery`) — a walk can only add signal, never break the
 * caller.
 */
export const walk = <S, A, R>(options: {
  readonly initial: S;
  /** Max steps (clamped into 1..{@link WALK_STEP_CAP}). */
  readonly budget?: number;
  readonly step: (
    state: S,
    index: number,
  ) => Effect.Effect<WalkStepOutcome<S, A>, never, R>;
  readonly settle: (state: S, ended: "budget" | "fallback") => A;
}): Effect.Effect<WalkResult<A>, never, R> =>
  Effect.gen(function* () {
    const budget = Math.min(
      WALK_STEP_CAP,
      Math.max(1, options.budget ?? WALK_BUDGET),
    );
    const trace: WalkStep[] = [];
    const expanded: string[] = [];
    let state = options.initial;
    for (let index = 0; index < budget; index++) {
      const started = yield* Clock.currentTimeMillis;
      const outcome = yield* options.step(state, index);
      const finished = yield* Clock.currentTimeMillis;
      trace.push({
        question: outcome.question,
        answer: outcome.answer,
        conviction: outcome.conviction,
        expanded: [...(outcome.expanded ?? [])],
        elapsedMs: finished - started,
      });
      for (const id of outcome.expanded ?? []) {
        if (!expanded.includes(id)) expanded.push(id);
      }
      if (outcome.move.kind === "done") {
        return {
          value: outcome.move.value,
          trace,
          expanded,
          ended: "decided",
        } satisfies WalkResult<A> as WalkResult<A>;
      }
      if (outcome.move.kind === "abort") {
        return {
          value: options.settle(state, "fallback"),
          trace,
          expanded,
          ended: "fallback",
        } satisfies WalkResult<A> as WalkResult<A>;
      }
      state = outcome.move.state;
    }
    return {
      value: options.settle(state, "budget"),
      trace,
      expanded,
      ended: "budget",
    } satisfies WalkResult<A> as WalkResult<A>;
  }).pipe(Effect.withSpan("root/judge/Walk.walk"));
