import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Generates a message (Anthropic Messages API, `/v1/messages`). Serverless Inference, from a runtime, with a model access key
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
 *         const message = yield* DigitalOcean.Inference.CreateMessage({ key });
 *         const out = yield* message({
 *           model: "mistral-3-14B",
 *           max_tokens: 256,
 *           messages: [{ role: "user", content: "Say hello" }],
 *         });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.CreateMessageHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface CreateMessage extends Binding.Service<
  CreateMessage,
  "DigitalOcean.Inference.CreateMessage",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.CreateInferenceMessagesRequest,
    ) => Effect.Effect<
      DO.MessagesCreateResponse,
      DO.CreateInferenceMessagesError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const CreateMessage = Binding.Service<CreateMessage>("DigitalOcean.Inference.CreateMessage");
