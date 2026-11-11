import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Downloads a finished video. Serverless Inference, from a runtime, with a model access key
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
 *         const download = yield* DigitalOcean.Inference.GetVideoContent({ key });
 *         const video = yield* download({ video_id });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.GetVideoContentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface GetVideoContent extends Binding.Service<
  GetVideoContent,
  "DigitalOcean.Inference.GetVideoContent",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.GetInferenceVideoContentRequest,
    ) => Effect.Effect<
      DO.GetInferenceVideoContentResponse,
      DO.GetInferenceVideoContentError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const GetVideoContent = Binding.Service<GetVideoContent>(
  "DigitalOcean.Inference.GetVideoContent",
);
