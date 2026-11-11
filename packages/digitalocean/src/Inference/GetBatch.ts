import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Reads a batch's status. Serverless Inference, from a runtime, with a model access key
 * the host receives as a secret.
 *
 * **Example:** From an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const key = yield* Config.Redacted("DO_MODEL_KEY");
 *     const getBatch = yield* DigitalOcean.Inference.GetBatch({ key });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const batch = yield* getBatch({ batch_id });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.GetBatchHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface GetBatch extends Binding.Service<
  GetBatch,
  "DigitalOcean.Inference.GetBatch",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.GetInferenceBatchRequest,
    ) => Effect.Effect<DO.Batch, DO.GetInferenceBatchError | InferenceKeyMissing, RuntimeContext>
  >
> {}

export const GetBatch = Binding.Service<GetBatch>("DigitalOcean.Inference.GetBatch");
