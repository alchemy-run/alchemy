/**
 * THE RECORDING JUDGE — the real TypeSafe System One (the same
 * TYPESAFE_API_KEY wiring gate.test.ts uses), wrapped so EVERY
 * exchange is kept: the decision cards (the rubrics exactly as System
 * One saw them), the state, the decoded value and the calibrated
 * answers. A judged miss in a report carries its full exchange, so the
 * owner can see WHICH rubric or prompt to tweak — that is the
 * harness's whole purpose.
 */
import * as TypeSafe from "alchemy/TypeSafe";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Decision from "effect/unstable/ai/Decision";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

/** Judged mode is gated exactly like gate.test.ts: the key in env. */
export const hasTypeSafeKey: boolean =
  typeof process.env.TYPESAFE_API_KEY === "string" &&
  process.env.TYPESAFE_API_KEY.length > 0;

/** Any decision's calibrated answer, untyped across kinds. */
export type AnyAnswer =
  | Decision.ClassifyAnswer<string>
  | Decision.RateAnswer<string>
  | Decision.ProbabilityAnswer;

/** One System One call, verbatim: cards in, calibration out. */
export interface Exchange {
  /** The first decision field's name — `tag` (router), `next`
   *  (scheduler), `disposition` (forgotten line), `changes` (review). */
  readonly kind: string;
  /** The decisions as asked — instructions + criteria rubric cards
   *  (effect `Decision` values are plain wire-shaped data). */
  readonly questions: Record<string, Decision.Any>;
  readonly state: unknown;
  readonly value: Record<string, unknown>;
  readonly answers: Record<string, AnyAnswer | undefined>;
}

/** An answer's decoded value: label, probability, or rating. */
const decodedOf = (answer: AnyAnswer | undefined): unknown =>
  answer === undefined
    ? undefined
    : "probability" in answer
      ? answer.probability
      : "rating" in answer
        ? answer.rating
        : answer.label;

/** The judge, built once per process: SystemOneHttp over fetch. */
const physics = TypeSafe.SystemOneHttp.pipe(
  Layer.provide(FetchHttpClient.layer),
);

/**
 * A real System One that records every exchange it answers. Handed
 * to the desk world (`deskWorld({ query })`) it turns the scripted
 * control plane live: the scheduler's wide Choice, the forgotten-line
 * disposition, and the review Noul all get judged for real.
 */
export const recordingQuery = (): {
  readonly query: typeof TypeSafe.SystemOne.Service;
  readonly exchanges: Exchange[];
} => {
  const exchanges: Exchange[] = [];
  const query = ((decisions, options) =>
    Effect.gen(function* () {
      const client = yield* TypeSafe.SystemOne;
      return yield* client(decisions, options);
    }).pipe(
      Effect.provide(physics),
      Effect.tap((result) =>
        Effect.sync(() => {
          const answers = result.answers as Record<
            string,
            AnyAnswer | undefined
          >;
          exchanges.push({
            kind: Object.keys(decisions)[0] ?? "?",
            questions: decisions,
            state: options.state,
            value: Object.fromEntries(
              Object.keys(decisions).map((field) => [
                field,
                decodedOf(answers[field]),
              ]),
            ),
            answers,
          });
        }),
      ),
    )) as typeof TypeSafe.SystemOne.Service;
  return { query, exchanges };
};

/** A choice answer's confidence, off a recorded exchange. */
export const confidenceOf = (
  exchange: Exchange,
  field: string,
): number | undefined => {
  const answer = exchange.answers[field];
  return answer !== undefined && "confidence" in answer
    ? answer.confidence
    : undefined;
};

/** A noul answer's probability, off a recorded exchange. */
export const noulOf = (
  exchange: Exchange,
  field: string,
): number | undefined => {
  const answer = exchange.answers[field];
  return answer !== undefined && "probability" in answer
    ? answer.probability
    : undefined;
};
