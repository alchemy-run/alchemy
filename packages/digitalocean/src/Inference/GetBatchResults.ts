import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Reads where a finished batch's results are. Serverless Inference, from a runtime, with a model access key
 * the host receives as a secret.
 *
 * **Example:** From an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const key = yield* Config.Redacted("DO_MODEL_KEY");
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const results = yield* DigitalOcean.Inference.GetBatchResults({ key });
 *         const out = yield* results({ batch_id });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.GetBatchResultsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface GetBatchResults extends Binding.Service<
  GetBatchResults,
  "DigitalOcean.Inference.GetBatchResults",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.GetInferenceBatchResultsRequest,
    ) => Effect.Effect<
      DO.BatchResultsResponse,
      DO.GetInferenceBatchResultsError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const GetBatchResults = Binding.Service<GetBatchResults>(
  "DigitalOcean.Inference.GetBatchResults",
);
