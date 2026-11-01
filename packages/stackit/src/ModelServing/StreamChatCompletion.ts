import type * as inference from "@distilled.cloud/stackit/model_serving_inference";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type StreamChatCompletionRequest = inference.StreamChatCompletionRequest;

/**
 * Runtime binding for `POST /v1/chat/completions` with `stream: true`: generate a model's
 * reply as it is written. A refused request fails the call with a typed error; a failure after
 * that fails the `events` stream, and so does a body that ends before a finish reason.
 * STACKIT's docs don't mention streaming and promise OpenAI compatibility, so a first live run
 * has to confirm it. Bind it to a {@link Token} and provide {@link StreamChatCompletionHttp}.
 * For Effect AI programs, use `Stackit.ModelServing.LanguageModel`.
 *
 * Access: the bound token itself, which reaches every shared model in its region. Nothing else
 * is granted, and no service account is created. The token's value reaches the host's env
 * `Redacted`.
 *
 * ### Streaming a Reply
 * **Example:** Collect a reply's text as it arrives
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Stream from "effect/Stream";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ai = Stackit.ModelServing.Token("Ai", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const binding = yield* Stackit.ModelServing.StreamChatCompletion(yield* Ai);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events } = yield* binding({
 *           model: "openai/gpt-oss-20b",
 *           messages: [{ role: "user", content: "Say hello." }],
 *           max_completion_tokens: 64,
 *         });
 *         const text = yield* events.pipe(
 *           Stream.map((chunk) => chunk.choices[0]?.delta.content ?? ""),
 *           Stream.mkString,
 *         );
 *         return yield* HttpServerResponse.json({ text });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelServing.StreamChatCompletionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Serving
 * @category ModelServing
 */
export interface StreamChatCompletion extends Binding.Service<
  StreamChatCompletion,
  "Stackit.ModelServing.StreamChatCompletion",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: StreamChatCompletionRequest,
    ) => Effect.Effect<
      inference.ChatCompletionEvents,
      inference.StreamChatCompletionError,
      RuntimeContext
    >
  >
> {}

export const StreamChatCompletion = Binding.Service<StreamChatCompletion>(
  "Stackit.ModelServing.StreamChatCompletion",
);
