import * as AI from "@alchemy.run/ai";
import * as AIAnthropic from "@alchemy.run/ai/Anthropic";
import type { ModelService } from "@alchemy.run/ai/Model";
import * as AIOpenAI from "@alchemy.run/ai/OpenAI";
import { describe, expect, test } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { LanguageModel } from "effect/ai";
import * as ConfigProvider from "effect/ConfigProvider";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

const tags = ["unit"];

class Smart extends AI.Model<Smart>()("smart") {}
class Fast extends AI.Model<Fast>()("fast") {}

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: { readonly model?: string; readonly temperature?: number };
}

/**
 * Ask `model` one question with `fetch` replaced by one that records the
 * request and refuses it: what the helper is answerable for is the request.
 */
const ask = <Self>(
  model: AI.ModelClass<Self, string>,
  live: Layer.Layer<Self, unknown>,
  env: Record<string, string>,
) =>
  Effect.gen(function* () {
    const sent: Array<Sent> = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: JSON.parse(await request.text()),
      });
      return Response.json({ error: { message: "refused" } }, { status: 401 });
    }) as typeof globalThis.fetch;
    const service = yield* Effect.service(model as Context.Key<Self, ModelService>).pipe(
      Effect.provide(live),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
      Effect.provide(service.languageModel),
      Effect.provideService(RuntimeContext, {} as never),
      Effect.exit,
    );
    return sent;
  });

describe("AI models on Anthropic and OpenAI", { tags }, () => {
  test.effect("an Anthropic model sends the id and the key read from ANTHROPIC_API_KEY", () =>
    Effect.gen(function* () {
      const [request] = yield* ask(
        Smart,
        AIAnthropic.Model(Smart, { model: "claude-opus-5-5", parameters: { temperature: 0 } }),
        { ANTHROPIC_API_KEY: "sk-ant-test" },
      );
      expect(request?.url.startsWith("https://api.anthropic.com/v1/messages")).toBe(true);
      expect(request?.headers["x-api-key"]).toBe("sk-ant-test");
      expect(request?.body.model).toBe("claude-opus-5-5");
      expect(request?.body.temperature).toBe(0);
    }),
  );

  test.effect("an OpenAI model sends the id and the key read from OPENAI_API_KEY", () =>
    Effect.gen(function* () {
      const [request] = yield* ask(Fast, AIOpenAI.Model(Fast, { model: "gpt-5.4-mini" }), {
        OPENAI_API_KEY: "sk-test",
      });
      expect(request?.url).toBe("https://api.openai.com/v1/responses");
      expect(request?.headers.authorization).toBe("Bearer sk-test");
      expect(request?.body.model).toBe("gpt-5.4-mini");
    }),
  );

  test.effect("a key passed as a value is used as it is, and the API can be elsewhere", () =>
    Effect.gen(function* () {
      const [request] = yield* ask(
        Fast,
        AIOpenAI.Model(Fast, {
          model: "gpt-5.4-mini",
          apiKey: Redacted.make("sk-own"),
          apiUrl: "https://proxy.example/v1",
        }),
        {},
      );
      expect(request?.url).toBe("https://proxy.example/v1/responses");
      expect(request?.headers.authorization).toBe("Bearer sk-own");
    }),
  );

  test.effect("a missing key fails where the Layer is built", () =>
    Effect.gen(function* () {
      const exit = yield* ask(
        Smart,
        AIAnthropic.Model(Smart, { model: "claude-opus-5-5" }),
        {},
      ).pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
    }),
  );
});
