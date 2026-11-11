import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Starts a video generation (`/v1/videos`). Serverless Inference, from a runtime, with a model access key
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
 *         const createVideo = yield* DigitalOcean.Inference.CreateVideo({ key });
 *         const job = yield* createVideo({ model, prompt: "waves at dusk" });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.CreateVideoHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface CreateVideo extends Binding.Service<
  CreateVideo,
  "DigitalOcean.Inference.CreateVideo",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.CreateInferenceVideoRequest,
    ) => Effect.Effect<
      DO.VideoGeneration,
      DO.CreateInferenceVideoError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const CreateVideo = Binding.Service<CreateVideo>("DigitalOcean.Inference.CreateVideo");
