import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as AiError from "effect/unstable/ai/AiError";
import type * as Decision from "effect/unstable/ai/Decision";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  rawOf,
  SystemOne,
  type Decisions,
  type Judgment,
  type QueryOptions,
} from "./SystemOne.ts";

/* ── the System One wire protocol (mirrors @effect/ai-typesafe) ────────── */

const ChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
});

const ScoreAnswer = Schema.Struct({
  type: Schema.Literal("score"),
  score: Schema.Number,
  probabilities: Schema.Record(Schema.String, Schema.Number),
  confidence: Schema.Number,
});

const NoulAnswer = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Schema.Number,
});

const SystemOneResponse = Schema.Struct({
  model: Schema.String,
  answers: Schema.Record(
    Schema.String,
    Schema.Union([ChoiceAnswer, ScoreAnswer, NoulAnswer]),
  ),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.optional(Schema.Number),
    }),
  ),
});

const DEFAULT_MODEL = "jev-latest";
const API_URL = "https://api.typesafe.ai/v1";

/**
 * One decision as its wire question. System One accepts STRUCTURED JSON
 * rubrics; a decision built by `TypeSafe.Choice`/`Noul` carries its
 * original cards in the {@link rawOf} stash, and those go on the wire —
 * the flattened strings on the `Decision` value are the portable
 * fallback (any decision built with plain `Decision.classify` etc.).
 */
const toQuestion = (decision: Decision.Any) => {
  const raw = rawOf(decision);
  switch (decision._tag) {
    case "Classify":
      return {
        type: "choice",
        instructions: raw?.instructions ?? decision.instructions,
        criteria: raw?.criteria ?? decision.criteria,
      };
    case "Rate":
      return {
        type: "score",
        instructions: raw?.instructions ?? decision.instructions,
        criteria: decision.criteria,
      };
    case "Probability":
      return {
        type: "noul",
        instructions: raw?.instructions ?? decision.instructions,
        ...(decision.criteria === undefined
          ? {}
          : { criteria: decision.criteria }),
      };
  }
};

/** The API rounds to two decimals — rescale drift so distributions sum to 1. */
const normalize = (
  probabilities: Readonly<Record<string, number>>,
): Record<string, number> => {
  let total = 0;
  for (const value of Object.values(probabilities)) total += value;
  if (total <= 0) return { ...probabilities };
  const scaled: Record<string, number> = {};
  for (const [key, value] of Object.entries(probabilities)) {
    scaled[key] = value / total;
  }
  return scaled;
};

const aiError = (method: string, reason: AiError.AiErrorReason) =>
  new AiError.AiError({ module: "TypeSafe.SystemOne", method, reason });

const fromHttpError = (error: HttpClientError.HttpClientError) => {
  const reason = error.reason;
  if (reason._tag === "StatusCodeError") {
    const status = reason.response.status;
    return status === 401 || status === 403
      ? new AiError.AuthenticationError({ kind: "Unknown" })
      : status === 429
        ? new AiError.RateLimitError({})
        : status >= 500
          ? new AiError.InternalProviderError({
              description: `System One responded ${status}`,
            })
          : new AiError.UnknownError({
              description: `System One responded ${status}`,
            });
  }
  return new AiError.UnknownError({ description: error.message });
};

/**
 * {@link SystemOne} over TypeSafe's HTTP API, keyed by `TYPESAFE_API_KEY`
 * and sampling `jev-latest` unless a call names another model. The wire
 * protocol matches `@effect/ai-typesafe`'s `TypeSafeDecisionModel`; this
 * layer exists so the judgment client rides Alchemy's binding system.
 *
 * The key is read with `Config` while the layer builds. On a host that
 * builds its layers in the Construction phase — a Worker, a Lambda — that
 * read is what binds the key onto the deployed environment, and the same
 * `Config` resolves it back from the binding at runtime
 * ([Secrets & Config](/environments/secrets)). The credentials and the
 * HTTP client are captured there too, so the client the binding hands back
 * needs nothing provided per call.
 *
 * ### Providing the binding
 * **Example:** Provide it on the host, judge at runtime
 * ```typescript
 * Effect.gen(function* () {
 *   const query = yield* TypeSafe.SystemOne;
 *   return { fetch };
 * }).pipe(Effect.provide(TypeSafe.SystemOneHttp));
 * ```
 *
 * @layer
 * @provides TypeSafe.SystemOne
 * @product TypeSafe
 */
export const SystemOneHttp: Layer.Layer<
  SystemOne,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  SystemOne,
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("TYPESAFE_API_KEY");
    const base = yield* HttpClient.HttpClient;

    const client = base.pipe(
      HttpClient.mapRequest(
        flow(
          HttpClientRequest.prependUrl(API_URL),
          HttpClientRequest.bearerToken(Redacted.value(apiKey)),
          HttpClientRequest.acceptJson,
        ),
      ),
      HttpClient.filterStatusOk,
    );
    const decode = HttpClientResponse.schemaBodyJson(SystemOneResponse);

    return Effect.fn("TypeSafe.SystemOne")(function* <
      const D extends Decisions,
    >(decisions: D, options: QueryOptions) {
      const questions: Record<string, unknown> = {};
      for (const [key, decision] of Object.entries(decisions)) {
        questions[key] = toQuestion(decision);
      }

      const request = yield* HttpClientRequest.bodyJson(
        HttpClientRequest.post("/systemone"),
        {
          model: options.model ?? DEFAULT_MODEL,
          state: options.state,
          questions,
        },
      ).pipe(
        Effect.mapError((error) =>
          aiError(
            "query",
            new AiError.InvalidRequestError({ description: String(error) }),
          ),
        ),
      );

      const response = yield* client.execute(request).pipe(
        Effect.flatMap(decode),
        Effect.catchTags({
          HttpClientError: (error) =>
            Effect.fail(aiError("query", fromHttpError(error))),
          SchemaError: (error) =>
            Effect.fail(
              aiError(
                "query",
                AiError.InvalidOutputError.fromSchemaError(error),
              ),
            ),
        }),
      );

      const answers: Record<string, unknown> = {};
      for (const [key, decision] of Object.entries(decisions)) {
        const answer = response.answers[key];
        if (answer === undefined) {
          return yield* aiError(
            "query",
            new AiError.InvalidOutputError({
              description: `System One returned no answer for decision "${key}"`,
            }),
          );
        }
        switch (answer.type) {
          case "choice":
            answers[key] = {
              label: answer.choice,
              probabilities: normalize(answer.probabilities),
              confidence: answer.confidence,
            };
            break;
          case "score": {
            // The wire distribution is keyed by level INDEX — remap to names.
            const levels =
              decision._tag === "Rate" ? decision.criteria : ([] as string[]);
            const probabilities: Record<string, number> = {};
            for (let index = 0; index < levels.length; index++) {
              const probability = answer.probabilities[String(index)];
              if (probability !== undefined) {
                probabilities[levels[index]!] = probability;
              }
            }
            const scaled = normalize(probabilities);
            let bestLabel = levels[0] ?? "";
            let best = -1;
            for (const level of levels) {
              const probability = scaled[level] ?? 0;
              if (probability > best) {
                best = probability;
                bestLabel = level;
              }
            }
            answers[key] = {
              rating: answer.score,
              label: bestLabel,
              probabilities: scaled,
              confidence: answer.confidence,
            };
            break;
          }
          case "noul":
            answers[key] = { probability: answer.noul };
            break;
        }
      }

      return {
        answers,
        usage: {
          inputTokens: response.usage?.input_tokens,
          outputTokens: response.usage?.output_tokens,
        },
      } as Judgment<D>;
    });
  }),
).pipe(Layer.orDie);
