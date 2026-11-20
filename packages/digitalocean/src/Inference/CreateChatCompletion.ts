import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Generates a chat completion (OpenAI `/v1/chat/completions`). Serverless Inference, from a runtime, with a model access key
 * the host receives as a secret.
 *
 * **Example:** From an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const key = yield* Config.Redacted("DO_MODEL_KEY");
 *     const chat = yield* DigitalOcean.Inference.CreateChatCompletion({ key });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const out = yield* chat({
 *           model: "mistral-3-14B",
 *           messages: [{ role: "user", content: "Say hello" }],
 *         });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.CreateChatCompletionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface CreateChatCompletion extends Binding.Service<
  CreateChatCompletion,
  "DigitalOcean.Inference.CreateChatCompletion",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.CreateInferenceChatCompletionRequest,
    ) => Effect.Effect<
      DO.ChatCompletionResponse,
      DO.CreateInferenceChatCompletionError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const CreateChatCompletion = Binding.Service<CreateChatCompletion>(
  "DigitalOcean.Inference.CreateChatCompletion",
);
