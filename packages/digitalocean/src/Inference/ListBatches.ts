import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Lists batches. Serverless Inference, from a runtime, with a model access key
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
 *         const listBatches = yield* DigitalOcean.Inference.ListBatches({ key });
 *         const page = yield* listBatches({});
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.ListBatchesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface ListBatches extends Binding.Service<
  ListBatches,
  "DigitalOcean.Inference.ListBatches",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.ListInferenceBatchesRequest,
    ) => Effect.Effect<
      DO.BatchListResponse,
      DO.ListInferenceBatchesError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const ListBatches = Binding.Service<ListBatches>("DigitalOcean.Inference.ListBatches");
