import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Reads a video generation's status. Serverless Inference, from a runtime, with a model access key
 * the host receives as a secret.
 *
 * **Example:** From an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const key = yield* Config.Redacted("DO_MODEL_KEY");
 *     const getVideo = yield* DigitalOcean.Inference.GetVideo({ key });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const job = yield* getVideo({ video_id });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.GetVideoHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface GetVideo extends Binding.Service<
  GetVideo,
  "DigitalOcean.Inference.GetVideo",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.GetInferenceVideoRequest,
    ) => Effect.Effect<
      DO.VideoGeneration,
      DO.GetInferenceVideoError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const GetVideo = Binding.Service<GetVideo>("DigitalOcean.Inference.GetVideo");
