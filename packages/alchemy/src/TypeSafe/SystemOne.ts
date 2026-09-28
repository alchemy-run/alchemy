import type * as Effect from "effect/Effect";
import type * as AiError from "effect/unstable/ai/AiError";
import * as Decision from "effect/unstable/ai/Decision";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * The decisions one judgment asks — a plain record of field name to an
 * effect `Decision` (`TypeSafe.Choice`, `TypeSafe.Noul`, `TypeSafe.Score`,
 * or any `Decision.classify` / `Decision.rate` / `Decision.probability`).
 */
export type Decisions = Record<string, Decision.Any>;

/**
 * A structured rubric card for one `Choice` criterion: what the option
 * covers, what it must NOT be chosen for, and a few examples. Flattened
 * into the criterion's description string when the decision is built.
 */
export interface Rubric {
  readonly what: string;
  readonly notFor?: string;
  readonly examples?: ReadonlyArray<string>;
}

/**
 * Where a decision built here stashes its ORIGINAL structured rubrics.
 * System One's wire protocol accepts JSON criteria; effect's `Decision`
 * types are string-only. The sugar below flattens cards into the strings
 * the `Decision` value carries (so any `DecisionModel` provider works),
 * and {@link SystemOneHttp} restores the structured cards from this stash
 * so the wire prompt is exactly what the rubric declared.
 */
export const RawRubrics = "~alchemy/TypeSafe/raw" as const;

export interface RawStash {
  readonly instructions?: unknown;
  readonly criteria?: unknown;
}

const stash = <D extends object>(decision: D, raw: RawStash): D => {
  Object.defineProperty(decision, RawRubrics, {
    value: raw,
    enumerable: false,
  });
  return decision;
};

/** The stashed structured rubrics of a decision, when it carries any. */
export const rawOf = (decision: object): RawStash | undefined =>
  (decision as Record<string, RawStash | undefined>)[RawRubrics];

/** Flattens a {@link Rubric} card into a criterion description string. */
export const rubric = (card: Rubric | string): string =>
  typeof card === "string"
    ? card
    : [
        card.what,
        card.notFor === undefined ? undefined : `NOT for: ${card.notFor}`,
        card.examples === undefined || card.examples.length === 0
          ? undefined
          : `e.g. ${card.examples.join("; ")}`,
      ]
        .filter((part) => part !== undefined)
        .join(". ");

/**
 * A classification decision — question text first, one rubric per label.
 * Sugar over `Decision.classify` that accepts structured {@link Rubric}
 * cards as criteria.
 */
export const Choice = <const Label extends string>(
  instructions: string,
  criteria: { readonly [L in Label]: string | Rubric },
): Decision.Classify<Label> =>
  stash(
    Decision.classify({
      instructions,
      criteria: Object.fromEntries(
        Object.entries(criteria).map(([label, card]) => [
          label,
          rubric(card as string | Rubric),
        ]),
      ) as { readonly [L in Label]: string },
    }),
    { criteria },
  );

/**
 * A probability decision — how likely the statement holds of the state.
 * Sugar over `Decision.probability`; a {@link Rubric} card flattens into
 * the instruction text.
 */
export const Noul = (
  instructions: string | Rubric,
  criteria?: { readonly false: string; readonly true: string },
): Decision.Probability =>
  stash(
    Decision.probability({ instructions: rubric(instructions), criteria }),
    typeof instructions === "string" ? {} : { instructions },
  );

/**
 * An ordered-scale decision — levels from lowest to highest.
 * Sugar over `Decision.rate`.
 */
export const Score = <const Level extends string>(
  instructions: string,
  criteria: ReadonlyArray<Level>,
): Decision.Rate<Level> => Decision.rate({ instructions, criteria });

/** Options for one judgment: the state judged, and optionally the model. */
export interface QueryOptions {
  /** The state the questions are asked about — data, never instructions. */
  readonly state: unknown;
  /** TypeSafe model identifier (default `jev-latest`). */
  readonly model?: string;
}

/**
 * A judgment: effect `Decision.Answers` — a choice's `label`,
 * `probabilities` and `confidence`; a noul's `probability`; a score's
 * `rating` and `label` — already narrowed to the kind of decision that
 * produced it, plus the provider's token usage.
 */
export interface Judgment<D extends Decisions> {
  readonly answers: Decision.Answers<D>;
  readonly usage: {
    readonly inputTokens?: number | undefined;
    readonly outputTokens?: number | undefined;
  };
}

export type JudgmentError = AiError.AiError;

/**
 * Ask TypeSafe's System One (Jev) typed questions about a state and get
 * calibrated answers back in around 100ms — the reflex judgment in front
 * of a slower, deliberate language model. The decisions are effect's own
 * `Decision` values (`effect/unstable/ai`), so a judgment built here runs
 * unchanged against any other `DecisionModel` provider.
 *
 * The binding resolves ONCE in the Construction phase, which is also what
 * binds the API key onto the host, and the client it hands back is pure
 * runtime: no credentials, no HTTP client, nothing to provide per call.
 *
 * ### Judging an event
 * **Example:** Route a message — reply inline, or open a work thread
 * ```typescript
 * export default Cloudflare.Worker(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const query = yield* TypeSafe.SystemOne;
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const message = yield* readMessage;
 *         const verdict = yield* query(
 *           {
 *             disposition: TypeSafe.Choice("How should `message` be handled?", {
 *               inline: "A short question answerable in one message",
 *               thread: "Real work: investigation, code, many steps",
 *             }),
 *             urgent: TypeSafe.Noul("Does `message` convey time pressure?"),
 *           },
 *           { state: { message } },
 *         );
 *
 *         return verdict.answers.disposition.label === "thread"
 *           ? yield* openThread(message)
 *           : yield* replyInline(message);
 *       }),
 *     };
 *   }).pipe(Effect.provide(TypeSafe.SystemOneHttp)),
 * );
 * ```
 *
 * ### Confidence
 * **Example:** Gate on confidence and fall back when the call is close
 * ```typescript
 * const verdict = yield* query(
 *   { team: TypeSafe.Choice("Who owns `issue`?", { infra: "…", app: "…" }) },
 *   { state: { issue } },
 * );
 * // `team` was asked as a Choice, so its answer IS a classify answer
 * if ((verdict.answers.team.confidence ?? 0) < 0.8) {
 *   return yield* humanTriage(issue);
 * }
 * ```
 *
 * @binding
 * @product TypeSafe
 */
export interface SystemOne extends Binding.Service<
  SystemOne,
  "TypeSafe.SystemOne",
  <const D extends Decisions>(
    decisions: D,
    options: QueryOptions,
  ) => Effect.Effect<Judgment<D>, JudgmentError, RuntimeContext>
> {}

export const SystemOne = Binding.Service<SystemOne>("TypeSafe.SystemOne");
