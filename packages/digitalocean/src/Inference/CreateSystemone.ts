import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Calls the SystemOne endpoint (`/v1/systemone`). Serverless Inference, from a runtime, with a model access key
 * the host receives as a secret.
 *
 * **Example:** From an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const key = yield* Config.Redacted("DO_MODEL_KEY");
 *     const systemone = yield* DigitalOcean.Inference.CreateSystemone({ key });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const out = yield* systemone({});
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.CreateSystemoneHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface CreateSystemone extends Binding.Service<
  CreateSystemone,
  "DigitalOcean.Inference.CreateSystemone",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.CreateInferenceSystemoneRequest,
    ) => Effect.Effect<
      DO.SystemoneResponse,
      DO.CreateInferenceSystemoneError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const CreateSystemone = Binding.Service<CreateSystemone>(
  "DigitalOcean.Inference.CreateSystemone",
);
