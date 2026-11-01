import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { CHEAP_CHAT_MODEL, CHEAP_EMBEDDING_MODEL } from "./models.ts";

export const Inference = Stackit.ModelServing.Token("ModelServingBindingsToken", {});

/** Keeps every reply short: inference is billed per token. */
const MAX_TOKENS = 32;

const PROMPT = "Reply with the single word: ok";

const messages = [{ role: "user", content: PROMPT }];

const GetAnswer = Tool.make("get_answer", {
  description: "Get the answer to the user's question.",
  parameters: Schema.Struct({ question: Schema.String }),
  success: Schema.Struct({ answer: Schema.String }),
});
const AnswerToolkit = Toolkit.make(GetAnswer);

/**
 * A Cloudflare Worker with every AI Model Serving binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the error in the test. The token's value never
 * leaves the Worker.
 */
export default class ModelServingBindingsWorker extends Cloudflare.Worker<ModelServingBindingsWorker>()(
  "StackitModelServingBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const token = yield* Inference;
    const getToken = yield* Stackit.ModelServing.GetToken(token);
    const listTokens = yield* Stackit.ModelServing.ListTokens(token);
    const listModels = yield* Stackit.ModelServing.ListModels();
    const getChatModel = yield* Stackit.ModelServing.GetChatModel();
    const getEmbeddingModel = yield* Stackit.ModelServing.GetEmbeddingModel();
    const chatCompletion = yield* Stackit.ModelServing.ChatCompletion(token);
    const streamChatCompletion = yield* Stackit.ModelServing.StreamChatCompletion(token);
    const createEmbeddings = yield* Stackit.ModelServing.CreateEmbeddings(token);
    const model = yield* Stackit.ModelServing.LanguageModel(token, {
      model: CHEAP_CHAT_MODEL,
      parameters: { maxCompletionTokens: MAX_TOKENS, temperature: 0 },
    });

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const region = url.searchParams.get("region") ?? "eu01";
        const modelId = url.searchParams.get("modelId") ?? "";
        switch (url.pathname) {
          case "/get-token":
            return yield* respond(getToken());
          case "/list-tokens":
            return yield* respond(listTokens());
          case "/list-models":
            return yield* respond(listModels({ regionId: region }));
          case "/get-chat-model":
            return yield* respond(getChatModel({ regionId: region, modelId }));
          case "/get-embedding-model":
            return yield* respond(getEmbeddingModel({ regionId: region, modelId }));
          case "/chat-completion":
            return yield* respond(
              chatCompletion({
                model: CHEAP_CHAT_MODEL,
                messages,
                max_completion_tokens: MAX_TOKENS,
                temperature: 0,
              }),
            );
          case "/chat-completion-unknown-model":
            // The typed error, as a value: it is the behaviour under test.
            return yield* respond(
              chatCompletion({
                model: "alchemy/no-such-model",
                messages,
                max_completion_tokens: 1,
              }).pipe(
                Effect.map(() => ({ failed: false })),
                Effect.catchTag(["NotFound", "BadRequest"], (error) =>
                  Effect.succeed({ failed: true, tag: error._tag }),
                ),
              ),
            );
          case "/stream-chat-completion":
            return yield* respond(
              Effect.gen(function* () {
                const { events } = yield* streamChatCompletion({
                  model: CHEAP_CHAT_MODEL,
                  messages,
                  max_completion_tokens: MAX_TOKENS,
                  temperature: 0,
                  stream_options: { include_usage: true },
                });
                const chunks = yield* Stream.runCollect(events);
                return {
                  chunks: chunks.length,
                  finishReason: chunks
                    .flatMap((chunk) => chunk.choices)
                    .map((choice) => choice.finish_reason)
                    .find((reason) => reason != null),
                  completionTokens: chunks.find((chunk) => chunk.usage != null)?.usage
                    ?.completion_tokens,
                };
              }),
            );
          case "/create-embeddings":
            return yield* respond(
              createEmbeddings({ model: CHEAP_EMBEDDING_MODEL, input: [PROMPT] }).pipe(
                Effect.map((reply) => ({
                  vectors: reply.data.length,
                  dimension: reply.data[0]?.embedding.length,
                })),
              ),
            );
          case "/language-model":
            return yield* respond(
              LanguageModel.generateText({ prompt: PROMPT }).pipe(
                Effect.map((reply) => ({
                  outputTokens: reply.usage.outputTokens.total,
                  parts: reply.content.length,
                })),
                Effect.provide(model),
              ),
            );
          case "/language-model-stream":
            return yield* respond(
              LanguageModel.streamText({ prompt: PROMPT }).pipe(
                Stream.runCollect,
                Effect.map((parts) => ({
                  finish: parts.filter((part) => part.type === "finish").length,
                  deltas: parts.filter(
                    (part) => part.type === "text-delta" || part.type === "reasoning-delta",
                  ).length,
                })),
                Effect.provide(model),
              ),
            );
          case "/language-model-tool":
            return yield* respond(
              LanguageModel.generateText({
                prompt: "Use get_answer to answer: what is the answer?",
                toolkit: AnswerToolkit,
                toolChoice: "required",
                disableToolCallResolution: true,
              }).pipe(
                Effect.map((reply) => ({
                  toolCalls: reply.toolCalls.map((call) => call.name),
                })),
                Effect.provide(
                  AnswerToolkit.toLayer({
                    get_answer: () => Effect.succeed({ answer: "42" }),
                  }),
                ),
                Effect.provide(model),
              ),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(Stackit.ModelServing.GetTokenHttp),
    Effect.provide(Stackit.ModelServing.ListTokensHttp),
    Effect.provide(Stackit.ModelServing.ListModelsHttp),
    Effect.provide(Stackit.ModelServing.GetChatModelHttp),
    Effect.provide(Stackit.ModelServing.GetEmbeddingModelHttp),
    Effect.provide(Stackit.ModelServing.ChatCompletionHttp),
    Effect.provide(Stackit.ModelServing.StreamChatCompletionHttp),
    Effect.provide(Stackit.ModelServing.CreateEmbeddingsHttp),
    Effect.provide(Stackit.ModelServing.LanguageModelHttp),
  ),
) {}
