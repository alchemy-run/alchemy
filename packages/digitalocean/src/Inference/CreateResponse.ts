import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Generates a response (OpenAI Responses API, `/v1/responses`). Serverless Inference, from a runtime, with a model access key
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
 *         const respond = yield* DigitalOcean.Inference.CreateResponse({ key });
 *         const out = yield* respond({ model: "mistral-3-14B", input: "Say hello" });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.CreateResponseHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface CreateResponse extends Binding.Service<
  CreateResponse,
  "DigitalOcean.Inference.CreateResponse",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.CreateInferenceResponseRequest,
    ) => Effect.Effect<
      DO.CreateResponseResponse,
      DO.CreateInferenceResponseError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const CreateResponse = Binding.Service<CreateResponse>(
  "DigitalOcean.Inference.CreateResponse",
);
