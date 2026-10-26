import * as Azure from "@alchemy.run/azure";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { CHAT_DEPLOYMENT, Chat, EMBEDDING_DEPLOYMENT, Embeddings, OpenAI } from "./resources.ts";

const json = (body: unknown, status = 200) => HttpServerResponse.json(body, { status });

interface ChatBody {
  prompt?: unknown;
  system?: unknown;
}

interface EmbedBody {
  input?: unknown;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");

/**
 * A public API on Azure Functions that answers with Azure OpenAI.
 *
 * - `GET /` — health check.
 * - `POST /chat` — `{ prompt, system? }` in, `{ text, model, finishReason, usage }` out.
 * - `POST /embed` — `{ input: string[] }` in, `{ model, count, dimensions }` out.
 *
 * There is no API key anywhere. The Function calls Azure OpenAI as its
 * system-assigned managed identity. Each binding assigns that identity a
 * custom role with one data action, on the account only.
 *
 * Azure OpenAI answers `401` until the role assignments propagate (a few
 * minutes after the first deploy); the API answers `503` until then.
 */
export default class Api extends Azure.Functions.Function<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const account = yield* OpenAI;
    yield* Chat;
    yield* Embeddings;
    const chat = yield* Azure.CognitiveServices.OpenAICreateChatCompletion(account);
    const embed = yield* Azure.CognitiveServices.OpenAICreateEmbedding(account);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://api");

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && url.pathname === "/chat") {
          const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as ChatBody;
          if (typeof body.prompt !== "string" || body.prompt.length === 0) {
            return yield* json({ error: "expected { prompt: string, system?: string }" }, 400);
          }
          const reply = yield* chat({
            deploymentId: CHAT_DEPLOYMENT,
            messages: [
              ...(typeof body.system === "string"
                ? [{ role: "system" as const, content: body.system }]
                : []),
              { role: "user" as const, content: body.prompt },
            ],
            max_tokens: 200,
            temperature: 0,
          });
          // Without `stream: true` the answer is one `chat.completion` object.
          if (reply.object !== "chat.completion") {
            return yield* json({ error: `unexpected ${reply.object}` }, 502);
          }
          const choice = reply.choices[0];
          return yield* json({
            text: choice?.message.content ?? "",
            model: reply.model,
            finishReason: choice?.finish_reason,
            usage: {
              inputTokens: reply.usage?.prompt_tokens,
              outputTokens: reply.usage?.completion_tokens,
            },
          });
        }

        if (request.method === "POST" && url.pathname === "/embed") {
          const body = (yield* request.json.pipe(Effect.orElseSucceed(() => ({})))) as EmbedBody;
          if (!isStringArray(body.input)) {
            return yield* json({ error: "expected { input: string[] }" }, 400);
          }
          const result = yield* embed({ deploymentId: EMBEDDING_DEPLOYMENT, input: body.input });
          return yield* json({
            model: result.model,
            count: result.data.length,
            dimensions: result.data[0]?.embedding.length,
          });
        }

        return yield* json({ error: "not found" }, 404);
      }).pipe(
        // A rejected prompt (bad parameters, content filter) is the caller's problem.
        Effect.catchTag("BadRequest", (error) => json({ error: error.message }, 400)),
        Effect.catchTag("TooManyRequests", (error) => json({ error: error.message }, 429)),
        // Role propagation after a deploy, or any other Azure error: retryable.
        Effect.catchCause((cause) => json({ error: Cause.pretty(cause) }, 503)),
      ),
    };
  }).pipe(
    Effect.provide([
      Azure.CognitiveServices.OpenAICreateChatCompletionHttp,
      Azure.CognitiveServices.OpenAICreateEmbeddingHttp,
    ]),
  ),
) {}
