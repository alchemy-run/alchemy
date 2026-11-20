import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Generates speech audio from text (`/v1/audio/speech`). Serverless Inference, from a runtime, with a model access key
 * the host receives as a secret.
 *
 * **Example:** From an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const key = yield* Config.Redacted("DO_MODEL_KEY");
 *     const speak = yield* DigitalOcean.Inference.CreateSpeech({ key });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const out = yield* speak({ model: "qwen3-tts-voicedesign", input: "hello" });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.CreateSpeechHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface CreateSpeech extends Binding.Service<
  CreateSpeech,
  "DigitalOcean.Inference.CreateSpeech",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.CreateInferenceSpeechRequest,
    ) => Effect.Effect<
      DO.InferenceCreateSpeechAudio,
      DO.CreateInferenceSpeechError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const CreateSpeech = Binding.Service<CreateSpeech>("DigitalOcean.Inference.CreateSpeech");
