import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Starts a batch of requests from an uploaded file. Serverless Inference, from a runtime, with a model access key
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
 *         const createBatch = yield* DigitalOcean.Inference.CreateBatch({ key });
 *         const batch = yield* createBatch({ input_file_id, endpoint: "/v1/chat/completions", completion_window: "24h" });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.CreateBatchHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface CreateBatch extends Binding.Service<
  CreateBatch,
  "DigitalOcean.Inference.CreateBatch",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.CreateInferenceBatchRequest,
    ) => Effect.Effect<DO.Batch, DO.CreateInferenceBatchError | InferenceKeyMissing, RuntimeContext>
  >
> {}

export const CreateBatch = Binding.Service<CreateBatch>("DigitalOcean.Inference.CreateBatch");
