import type * as Effect from "effect/Effect";
import type {
  QueryOptions,
  QueryResult,
  QuestionSchema,
  SystemOneError,
  TypesafeAiParseError,
} from "@distilled.cloud/typesafe-ai";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * The questions one judgment asks — a plain record of field name to
 * question (`TypeSafe.Choice`, `TypeSafe.Noul`, `TypeSafe.Score`).
 */
export type Questions = Record<string, QuestionSchema<any>>;

/** A judgment: the decoded `value` plus the raw calibrated answers. */
export type Judgment<Q extends Questions> = QueryResult<{
  readonly [K in keyof Q]: Q[K]["Type"];
}>;

export type JudgmentError = SystemOneError | TypesafeAiParseError;

/**
 * Ask TypeSafe's System One (Jev) typed questions about a state and get
 * calibrated answers back in around 100ms — the reflex judgment in front
 * of a slower, deliberate language model.
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
 *         return verdict.value.disposition === "thread"
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
 * const answer = TypeSafe.asChoice(verdict.answers.team);
 * if (answer === undefined || answer.confidence < 0.8) {
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
  <const Q extends Questions>(
    questions: Q,
    options: QueryOptions,
  ) => Effect.Effect<Judgment<Q>, JudgmentError, RuntimeContext>
> {}

export const SystemOne = Binding.Service<SystemOne>("TypeSafe.SystemOne");
