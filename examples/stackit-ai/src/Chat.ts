import * as Stackit from "@alchemy.run/stackit";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Puller, registryFor } from "./registry.ts";
import { Inference, MODEL } from "./resources.ts";

/** Keeps every reply short: inference bills per token. */
const MAX_TOKENS = 64;

/**
 * A chat endpoint on a STACKIT Function, answering with AI Model Serving.
 *
 * - `GET /` is a health route.
 * - `POST /chat` takes `{ prompt }` and returns `{ text, usage }`.
 *
 * `Stackit.ModelServing.ChatCompletion` grants no role and creates no service account. The
 * bound token reaches the function as a plain revision variable. Nothing here checks who
 * calls this route, and every prompt spends money, so add a check before you leave it deployed.
 */
export default class Chat extends Stackit.Functions.Function<Chat>()(
  "Chat",
  Effect.gen(function* () {
    const puller = yield* Puller;
    const registry = yield* registryFor("chat");
    return {
      main: import.meta.url,
      registry,
      pullCredential: puller.pullCredentialId,
    };
  }),
  Effect.gen(function* () {
    const complete = yield* Stackit.ModelServing.ChatCompletion(yield* Inference);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://function");

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("ok");
        }

        if (request.method === "POST" && url.pathname === "/chat") {
          const body = (yield* request.json) as { prompt?: unknown };
          if (typeof body.prompt !== "string" || body.prompt.length === 0) {
            return yield* HttpServerResponse.json({ error: "prompt is required" }, { status: 400 });
          }
          const reply = yield* complete({
            model: MODEL,
            messages: [{ role: "user", content: body.prompt }],
            max_completion_tokens: MAX_TOKENS,
          });
          return yield* HttpServerResponse.json({
            text: reply.choices[0]?.message.content,
            usage: reply.usage,
          });
        }

        return HttpServerResponse.text("not found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Stackit.ModelServing.ChatCompletionHttp)),
) {}
