import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Starts an asynchronous model invocation (`/v1/async-invoke`). Serverless Inference, from a runtime, with a model access key
 * the host receives as a secret.
 *
 * **Example:** From an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const key = yield* Config.Redacted("DO_MODEL_KEY");
 *     const invoke = yield* DigitalOcean.Inference.CreateAsyncInvoke({ key });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const job = yield* invoke({ model_id: "fal-ai/flux/schnell", input: { prompt: "a lighthouse" } });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.CreateAsyncInvokeHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface CreateAsyncInvoke extends Binding.Service<
  CreateAsyncInvoke,
  "DigitalOcean.Inference.CreateAsyncInvoke",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.InferenceCreateAsyncInvokeRequest,
    ) => Effect.Effect<
      DO.AsyncInvokeResponse,
      DO.InferenceCreateAsyncInvokeError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const CreateAsyncInvoke = Binding.Service<CreateAsyncInvoke>(
  "DigitalOcean.Inference.CreateAsyncInvoke",
);
