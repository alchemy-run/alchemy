import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { TestRegistry } from "../../fixtures/app/shared.ts";

/** One route per Serverless Inference binding. */
export default class InferenceApp extends DigitalOcean.App<InferenceApp>()(
  "InferenceApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc" },
  Effect.gen(function* () {
    const key = yield* Config.Redacted("DO_TEST_KEY");
    const chat = yield* DigitalOcean.Inference.CreateChatCompletion({ key });
    const embed = yield* DigitalOcean.Inference.CreateEmbedding({ key });
    const listModels = yield* DigitalOcean.Inference.ListModels({ key });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://app");
        switch (url.pathname) {
          case "/chat": {
            const out = yield* chat({
              model: "mistral-3-14B",
              messages: [{ role: "user", content: "Reply with exactly the word pong." }],
              max_tokens: 10,
            });
            return yield* HttpServerResponse.json({ text: out.choices?.[0]?.message?.content });
          }
          case "/embed": {
            const out = yield* embed({ model: "qwen3-embedding-0.6b", input: "hello" });
            return yield* HttpServerResponse.json({ dims: out.data?.[0]?.embedding?.length ?? 0 });
          }
          case "/models": {
            const out = yield* listModels({});
            return yield* HttpServerResponse.json({ count: out.data?.length ?? 0 });
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DigitalOcean.Inference.CreateChatCompletionHttp,
        DigitalOcean.Inference.CreateEmbeddingHttp,
        DigitalOcean.Inference.ListModelsHttp,
      ),
    ),
  ),
) {}
