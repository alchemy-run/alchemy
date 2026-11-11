import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Lists the models the key can call (`/v1/models`). Serverless Inference, from a runtime, with a model access key
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
 *         const listModels = yield* DigitalOcean.Inference.ListModels({ key });
 *         const models = yield* listModels({});
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.ListModelsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface ListModels extends Binding.Service<
  ListModels,
  "DigitalOcean.Inference.ListModels",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.ListInferenceModelsRequest,
    ) => Effect.Effect<
      DO.ListModelsResponse,
      DO.ListInferenceModelsError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const ListModels = Binding.Service<ListModels>("DigitalOcean.Inference.ListModels");
