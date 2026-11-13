import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Cancels a running batch. Serverless Inference, from a runtime, with a model access key
 * the host receives as a secret.
 *
 * **Example:** From an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const key = yield* Config.Redacted("DO_MODEL_KEY");
 *     const cancel = yield* DigitalOcean.Inference.CancelBatch({ key });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* cancel({ batch_id });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.CancelBatchHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface CancelBatch extends Binding.Service<
  CancelBatch,
  "DigitalOcean.Inference.CancelBatch",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.CancelInferenceBatchRequest,
    ) => Effect.Effect<DO.Batch, DO.CancelInferenceBatchError | InferenceKeyMissing, RuntimeContext>
  >
> {}

export const CancelBatch = Binding.Service<CancelBatch>("DigitalOcean.Inference.CancelBatch");
