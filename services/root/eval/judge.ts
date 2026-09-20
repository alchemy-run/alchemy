/**
 * THE RECORDING JUDGE — the real TypeSafe System One (the same
 * CredentialsFromEnv wiring gate.test.ts uses), wrapped so EVERY
 * exchange is kept: the wire-level question cards (the rubrics
 * exactly as System One saw them), the state, the decoded value and
 * the calibrated answers. A judged miss in a report carries its full
 * exchange, so the owner can see WHICH rubric or prompt to tweak —
 * that is the harness's whole purpose.
 */
import * as TS from "@distilled.cloud/typesafe-ai";
import type * as TypeSafe from "alchemy/TypeSafe";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

/** Judged mode is gated exactly like gate.test.ts: the key in env. */
export const hasTypeSafeKey: boolean =
  typeof process.env.TYPESAFE_API_KEY === "string" &&
  process.env.TYPESAFE_API_KEY.length > 0;

/** One System One call, verbatim: cards in, calibration out. */
export interface Exchange {
  /** The first question field's name — `tag` (router), `next`
   *  (scheduler), `disposition` (forgotten line), `changes` (review). */
  readonly kind: string;
  /** The WIRE question map — instructions + criteria rubric cards. */
  readonly questions: Record<string, TS.Question>;
  readonly state: unknown;
  readonly value: Record<string, unknown>;
  readonly answers: Record<string, TS.Answer | undefined>;
}

/** The question schemas as System One receives them on the wire. */
const serializeQuestions = (
  questions: Record<string, Schema.Top>,
): Record<string, TS.Question> => {
  try {
    return TS.questionsFromSchema(Schema.Struct(questions));
  } catch {
    return {};
  }
};

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
  const query = ((questions, options) =>
    TS.query(questions, options).pipe(
      Effect.provide([TS.CredentialsFromEnv, FetchHttpClient.layer]),
      Effect.tap((result) =>
        Effect.sync(() => {
          exchanges.push({
            kind: Object.keys(questions)[0] ?? "?",
            questions: serializeQuestions(
              questions as Record<string, Schema.Top>,
            ),
            state: options.state,
            value: result.value as Record<string, unknown>,
            answers: result.answers as Record<string, TS.Answer | undefined>,
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
): number | undefined => TS.asChoice(exchange.answers[field])?.confidence;

/** A noul answer's probability, off a recorded exchange. */
export const noulOf = (
  exchange: Exchange,
  field: string,
): number | undefined => TS.asNoul(exchange.answers[field])?.noul;
