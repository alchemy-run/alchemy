import type * as inference from "@distilled.cloud/stackit/model_serving_inference";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type ChatCompletionRequest = inference.CreateChatCompletionRequest;

/**
 * Runtime binding for the OpenAI-compatible `POST /v1/chat/completions`: generate a model's
 * reply. The API keeps no session, so a request carries the whole conversation. Bind it to a
 * {@link Token} and provide {@link ChatCompletionHttp}. For Effect AI programs, use
 * `Stackit.ModelServing.LanguageModel`. Inference is billed per million tokens of text.
 *
 * Access: the bound token itself, which reaches every shared model in its region. Nothing else
 * is granted, and no service account is created. The token's value reaches the host's env
 * `Redacted`.
 *
 * ### Generating a Reply
 * **Example:** Ask a model from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ai = Stackit.ModelServing.Token("Ai", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const binding = yield* Stackit.ModelServing.ChatCompletion(yield* Ai);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const reply = yield* binding({
 *           model: "openai/gpt-oss-20b",
 *           messages: [{ role: "user", content: "Say hello." }],
 *           max_completion_tokens: 64,
 *         });
 *         return yield* HttpServerResponse.json({ text: reply.choices[0]?.message.content });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelServing.ChatCompletionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Serving
 * @category ModelServing
 */
export interface ChatCompletion extends Binding.Service<
  ChatCompletion,
  "Stackit.ModelServing.ChatCompletion",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: ChatCompletionRequest,
    ) => Effect.Effect<
      inference.ChatCompletion,
      inference.CreateChatCompletionError,
      RuntimeContext
    >
  >
> {}

export const ChatCompletion = Binding.Service<ChatCompletion>(
  "Stackit.ModelServing.ChatCompletion",
);
