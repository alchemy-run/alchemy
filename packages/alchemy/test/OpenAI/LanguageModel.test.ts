import { describe, expect } from "alchemy-test";
import { AiError, LanguageModel, Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as OpenAI from "@/OpenAI";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: OpenAI.providers() });

const MODEL = process.env.OPENAI_TEST_MODEL ?? "gpt-5-nano";
const tags = ["provider:openai", "provider:openai:languagemodel", "live"];

const model = OpenAI.LanguageModel({
  model: MODEL,
  parameters: { reasoningEffort: "minimal", maxOutputTokens: 512 },
}).pipe(Layer.provide(Layer.mergeAll(OpenAI.CredentialsFromEnv, FetchHttpClient.layer)));

const expectQuotaExhausted = (result: Result.Result<unknown, AiError.AiError>, method: string) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure._tag).toBe("AiError");
    expect(result.failure.module).toBe("OpenAI.LanguageModel");
    expect(result.failure.method).toBe(method);
    expect(result.failure.reason._tag).toBe("QuotaExhaustedError");
    expect(result.failure.isRetryable).toBe(false);
  }
};

/**
 * The testing account's key belongs to an organization without credits, so
 * every generation call reaches OpenAI and comes back as the typed
 * `InsufficientQuota` error. These tests prove the request is well-formed
 * enough to be authenticated and billed, and that the typed error maps to
 * `AiError.QuotaExhaustedError`. Set `OPENAI_LIVE_GENERATION=1` with a funded
 * key to run the success-path suite below instead.
 */
describe.skipIf(!process.env.OPENAI_API_KEY || !!process.env.OPENAI_LIVE_GENERATION)(
  "OpenAI.LanguageModel (unfunded key)",
  { tags },
  () => {
    test(
      "generateText surfaces InsufficientQuota as a QuotaExhaustedError",
      Effect.gen(function* () {
        const result = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
          Effect.provide(model),
          Effect.result,
        );
        expectQuotaExhausted(result, "generateText");
      }),
      { timeout: 60_000 },
    );

    test(
      "streamText surfaces InsufficientQuota as a QuotaExhaustedError",
      Effect.gen(function* () {
        const result = yield* LanguageModel.streamText({ prompt: "Count to three." }).pipe(
          Stream.runCollect,
          Effect.provide(model),
          Effect.result,
        );
        expectQuotaExhausted(result, "streamText");
      }),
      { timeout: 60_000 },
    );
  },
);

test(
  "a missing API key fails with an AuthenticationError before any request",
  Effect.gen(function* () {
    const unkeyed = OpenAI.LanguageModel({ model: MODEL }).pipe(
      Layer.provide(Layer.mergeAll(OpenAI.credentials({}), FetchHttpClient.layer)),
    );
    const result = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
      Effect.provide(unkeyed),
      Effect.result,
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason._tag).toBe("AuthenticationError");
      if (result.failure.reason._tag === "AuthenticationError") {
        expect(result.failure.reason.kind).toBe("MissingKey");
      }
    }
  }),
  { tags: ["provider:openai", "provider:openai:languagemodel", "local"] },
);

const Add = Tool.make("add", {
  description: "Add two integers and return the sum.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
});
const Calculator = Toolkit.make(Add);

describe.skipIf(!process.env.OPENAI_LIVE_GENERATION)(
  "OpenAI.LanguageModel (funded key)",
  { tags },
  () => {
    test(
      "generateText returns text and a stop finish",
      Effect.gen(function* () {
        const response = yield* LanguageModel.generateText({
          prompt: "Reply with exactly the word: pong",
        }).pipe(Effect.provide(model));
        expect(response.text.toLowerCase()).toContain("pong");
        expect(response.finishReason).toBe("stop");
        expect(response.usage.outputTokens.total).toBeGreaterThan(0);
      }),
      { timeout: 90_000 },
    );

    test(
      "streamText streams text deltas and finishes",
      Effect.gen(function* () {
        const parts = yield* LanguageModel.streamText({
          prompt: "Count from one to five in words.",
        }).pipe(Stream.runCollect, Effect.provide(model));
        const all = Array.from(parts);
        const text = all
          .flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
          .join("");
        expect(text.length).toBeGreaterThan(0);
        expect(all.at(-1)?.type).toBe("finish");
      }),
      { timeout: 90_000 },
    );

    test(
      "generateText calls a function tool",
      Effect.gen(function* () {
        const response = yield* LanguageModel.generateText({
          prompt: "Use the add tool to compute 2 + 3.",
          toolkit: Calculator,
          toolChoice: { tool: "add" },
        }).pipe(
          Effect.provide(Calculator.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })),
          Effect.provide(model),
        );
        expect(response.toolCalls.map((call) => call.name)).toContain("add");
        expect(response.toolResults.map((result) => result.result)).toContain(5);
      }),
      { timeout: 90_000 },
    );

    test(
      "generateObject decodes JSON-schema structured output",
      Effect.gen(function* () {
        const response = yield* LanguageModel.generateObject({
          prompt: "Return a short greeting.",
          schema: Schema.Struct({ greeting: Schema.String }),
        }).pipe(Effect.provide(model));
        expect(response.value.greeting.length).toBeGreaterThan(0);
      }),
      { timeout: 90_000 },
    );
  },
);
