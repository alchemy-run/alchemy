import { describe, expect } from "alchemy-test";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as OpenRouter from "@/OpenRouter";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: OpenRouter.providers() });

const MODEL = process.env.OPENROUTER_TEST_MODEL ?? "openai/gpt-4o-mini";

const model = OpenRouter.LanguageModel({
  model: MODEL,
  parameters: { temperature: 0, maxTokens: 64 },
}).pipe(Layer.provide(OpenRouter.CredentialsFromEnv));

const Add = Tool.make("add", {
  description: "Add two integers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
});
const MathToolkit = Toolkit.make(Add);
const MathHandlers = MathToolkit.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) });

describe.skipIf(!process.env.OPENROUTER_API_KEY)(
  "OpenRouter.LanguageModel",
  { tags: ["provider:openrouter", "provider:openrouter:languagemodel", "live"] },
  () => {
    test(
      "generateText returns text, usage and cost",
      Effect.gen(function* () {
        const response = yield* LanguageModel.generateText({
          prompt: "Reply with the single word: pong",
        });
        expect(response.text.toLowerCase()).toContain("pong");
        expect(response.usage.inputTokens.total).toBeGreaterThan(0);
        const finish = response.content.find((part) => part.type === "finish");
        expect(finish).toBeDefined();
        expect(OpenRouter.finishCost(finish!)).toBeGreaterThanOrEqual(0);
      }).pipe(Effect.provide(model)),
      { timeout: 60_000 },
    );

    test(
      "streamText streams deltas and finishes",
      Effect.gen(function* () {
        const parts = yield* LanguageModel.streamText({
          prompt: "Count from 1 to 5 separated by spaces.",
        }).pipe(Stream.runCollect);
        const text = parts
          .filter((part) => part.type === "text-delta")
          .map((part) => part.delta)
          .join("");
        expect(text).toContain("3");
        expect(parts.some((part) => part.type === "finish")).toBe(true);
      }).pipe(Effect.provide(model)),
      { timeout: 60_000 },
    );

    test(
      "generateObject decodes structured output",
      Effect.gen(function* () {
        const response = yield* LanguageModel.generateObject({
          prompt: "Return a greeting of 'hello'.",
          schema: Schema.Struct({ greeting: Schema.String }),
        });
        expect(response.value.greeting.toLowerCase()).toContain("hello");
      }).pipe(Effect.provide(model)),
      { timeout: 60_000 },
    );

    test(
      "calls tools from a toolkit",
      Effect.gen(function* () {
        const response = yield* LanguageModel.generateText({
          prompt: "Use the add tool to add 2 and 3.",
          toolkit: MathToolkit,
        });
        expect(response.toolResults.map((result) => result.result)).toContain(5);
      }).pipe(Effect.provide(Layer.merge(model, MathHandlers))),
      { timeout: 60_000 },
    );
  },
);

// Per-agent budget: deploy a capped key with the management key, then run the
// model on that key's own credits.
describe.skipIf(!process.env.OPENROUTER_MANAGEMENT_KEY)(
  "OpenRouter.LanguageModel on an OpenRouter.ApiKey",
  { tags: ["provider:openrouter", "provider:openrouter:languagemodel", "live"] },
  () => {
    test.provider(
      "a deployed budgeted key serves inference",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const key = yield* stack.deploy(
            OpenRouter.ApiKey("AgentBudget", { limit: 0.05, limitReset: "daily" }),
          );

          const response = yield* LanguageModel.generateText({
            prompt: "Reply with the single word: pong",
          }).pipe(
            Effect.provide(
              OpenRouter.LanguageModel({
                model: MODEL,
                parameters: { temperature: 0, maxTokens: 16 },
              }).pipe(Layer.provide(OpenRouter.fromApiKey(key.key))),
            ),
          );
          expect(response.text.length).toBeGreaterThan(0);

          yield* stack.destroy();
        }),
      { timeout: 120_000 },
    );
  },
);
