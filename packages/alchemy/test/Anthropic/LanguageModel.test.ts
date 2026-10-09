import { describe, expect, it } from "alchemy-test";
import { AiError, LanguageModel, Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Anthropic from "@/Anthropic";

// Cheapest current model + tiny token budgets: every live call costs a
// fraction of a cent.
const MODEL = "claude-haiku-4-5-20251001";

const claude = (options: Anthropic.LanguageModelOptions) =>
  Anthropic.LanguageModel(options).pipe(
    Layer.provide(Anthropic.CredentialsFromEnv),
    Layer.provide(FetchHttpClient.layer),
  );

const Add = Tool.make("add", {
  description: "Add two integers and return the sum.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
});
const MathTools = Toolkit.make(Add);
const MathHandlers = MathTools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) });

const tags = ["provider:anthropic", "provider:anthropic:languagemodel", "live"];

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic.LanguageModel", () => {
  it.live(
    "generateText returns text, a finish reason and usage",
    () =>
      Effect.gen(function* () {
        const response = yield* LanguageModel.generateText({
          prompt: "Reply with exactly the single word: pong",
        }).pipe(Effect.provide(claude({ model: MODEL, parameters: { maxTokens: 16 } })));
        expect(response.text.toLowerCase()).toContain("pong");
        expect(["stop", "length"]).toContain(response.finishReason);
        expect(response.usage.inputTokens.total).toBeGreaterThan(0);
        expect(response.usage.outputTokens.total).toBeGreaterThan(0);
      }),
    { tags, timeout: 60_000 },
  );

  it.live(
    "system prompts are sent as the Messages API system field",
    () =>
      Effect.gen(function* () {
        const response = yield* LanguageModel.generateText({
          prompt: [
            {
              role: "system",
              content: "Whatever the user says, answer only with the word: banana",
            },
            { role: "user", content: [{ type: "text", text: "What is 2 + 2?" }] },
          ],
        }).pipe(Effect.provide(claude({ model: MODEL, parameters: { maxTokens: 16 } })));
        expect(response.text.toLowerCase()).toContain("banana");
      }),
    { tags, timeout: 60_000 },
  );

  it.live(
    "streamText streams text deltas and ends with a finish part",
    () =>
      Effect.gen(function* () {
        const parts = yield* LanguageModel.streamText({
          prompt: "Count from 1 to 5 separated by spaces. Output only the numbers.",
        }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.provide(claude({ model: MODEL, parameters: { maxTokens: 32 } })),
        );
        const text = parts
          .flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
          .join("");
        expect(text).toContain("3");
        expect(parts.some((part) => part.type === "text-start")).toBe(true);
        expect(parts.some((part) => part.type === "text-end")).toBe(true);
        const finish = parts.find((part) => part.type === "finish");
        expect(finish).toBeDefined();
        if (finish?.type === "finish") {
          expect(finish.reason).toBe("stop");
          expect(finish.usage.outputTokens.total).toBeGreaterThan(0);
        }
      }),
    { tags, timeout: 60_000 },
  );

  it.live(
    "tool calls execute through a Toolkit and results round-trip",
    () =>
      Effect.gen(function* () {
        const model = claude({ model: MODEL, parameters: { maxTokens: 128 } });
        const response = yield* LanguageModel.generateText({
          prompt: "Use the add tool to add 2 and 3.",
          toolkit: MathTools,
          toolChoice: { tool: "add" },
        }).pipe(Effect.provide(model), Effect.provide(MathHandlers));
        expect(response.finishReason).toBe("tool-calls");
        const call = response.toolCalls[0];
        expect(call?.name).toBe("add");
        expect(call?.params).toEqual({ a: 2, b: 3 });
        expect(response.toolResults[0]?.result).toBe(5);

        // Feed the call and its result back: exercises assistant tool_use and
        // user tool_result conversion.
        const followUp = yield* LanguageModel.generateText({
          prompt: [
            { role: "user", content: [{ type: "text", text: "Use the add tool to add 2 and 3." }] },
            {
              role: "assistant",
              content: [{ type: "tool-call", id: call!.id, name: "add", params: { a: 2, b: 3 } }],
            },
            {
              role: "tool",
              content: [
                { type: "tool-result", id: call!.id, name: "add", result: 5, isFailure: false },
              ],
            },
          ],
          toolkit: MathTools,
          toolChoice: "none",
        }).pipe(Effect.provide(model), Effect.provide(MathHandlers));
        expect(followUp.text).toContain("5");
      }),
    { tags, timeout: 90_000 },
  );

  it.live(
    "streamText emits streamed tool parameters and a tool call",
    () =>
      Effect.gen(function* () {
        const parts = yield* LanguageModel.streamText({
          prompt: "Use the add tool to add 4 and 6.",
          toolkit: MathTools,
          toolChoice: { tool: "add" },
        }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.provide(claude({ model: MODEL, parameters: { maxTokens: 128 } })),
          Effect.provide(MathHandlers),
        );
        expect(parts.some((part) => part.type === "tool-params-start")).toBe(true);
        const call = parts.find((part) => part.type === "tool-call");
        expect(call?.type === "tool-call" ? call.params : undefined).toEqual({ a: 4, b: 6 });
        const result = parts.find((part) => part.type === "tool-result");
        expect(result?.type === "tool-result" ? result.result : undefined).toBe(10);
      }),
    { tags, timeout: 60_000 },
  );

  it.live(
    "generateObject decodes structured output",
    () =>
      Effect.gen(function* () {
        const response = yield* LanguageModel.generateObject({
          prompt: "Return the capital city of France.",
          schema: Schema.Struct({ city: Schema.String }),
        }).pipe(Effect.provide(claude({ model: MODEL, parameters: { maxTokens: 64 } })));
        expect(response.value.city).toContain("Paris");
      }),
    { tags, timeout: 60_000 },
  );

  it.live(
    "extended thinking surfaces signed reasoning in generate and stream",
    () =>
      Effect.gen(function* () {
        const model = claude({
          model: MODEL,
          parameters: { maxTokens: 1200, thinking: { budgetTokens: 1024 } },
        });
        const prompt = "What is 7 * 8? Answer with just the number.";
        const response = yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(model));
        expect(response.text).toContain("56");
        const reasoning = response.reasoning[0];
        expect(reasoning).toBeDefined();
        expect(typeof reasoning?.metadata.anthropic).toBe("object");

        const parts = yield* LanguageModel.streamText({ prompt }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.provide(model),
        );
        expect(parts.some((part) => part.type === "reasoning-delta")).toBe(true);
        const end = parts.find((part) => part.type === "reasoning-end");
        const signature =
          end?.type === "reasoning-end"
            ? (end.metadata.anthropic as { signature?: string } | undefined)?.signature
            : undefined;
        expect(signature?.length ?? 0).toBeGreaterThan(0);
      }),
    { tags, timeout: 90_000 },
  );

  it.live(
    "an unknown model fails with a typed InvalidRequestError on the model parameter",
    () =>
      Effect.gen(function* () {
        const error = yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
          Effect.provide(
            claude({ model: "claude-does-not-exist-20990101", parameters: { maxTokens: 8 } }),
          ),
          Effect.flip,
        );
        expect(AiError.isAiError(error)).toBe(true);
        expect(error.module).toBe("Anthropic.LanguageModel");
        expect(error.reason._tag).toBe("InvalidRequestError");
        if (error.reason._tag === "InvalidRequestError") {
          expect(error.reason.parameter).toBe("model");
        }
      }),
    { tags, timeout: 60_000 },
  );
});

it.live(
  "a missing API key fails with a typed AuthenticationError before any request",
  () =>
    Effect.gen(function* () {
      const error = yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
        Effect.provide(
          Anthropic.LanguageModel({ model: MODEL }).pipe(
            Layer.provide(Anthropic.credentials({})),
            Layer.provide(FetchHttpClient.layer),
          ),
        ),
        Effect.flip,
      );
      expect(error.reason._tag).toBe("AuthenticationError");
      if (error.reason._tag === "AuthenticationError") {
        expect(error.reason.kind).toBe("MissingKey");
      }
    }),
  { tags: ["unit", "provider:anthropic", "provider:anthropic:languagemodel", "local"] },
);
