import * as Stackit from "@alchemy.run/stackit";
import { describe, expect, it } from "@alchemy.run/test";
import { TooManyRequests } from "@distilled.cloud/stackit/Errors";
import type * as inference from "@distilled.cloud/stackit/model_serving_inference";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { stackitTags } from "../helpers.ts";

/**
 * The adapter from Effect AI to chat completions, pure: what it sends and how it reads each reply.
 * `Bindings.test.ts` drives it against the live API from a deployed Worker.
 */
const options = { tags: [...stackitTags("modelserving", "languagemodel"), "unit"] } as const;

const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };

const adapter = (
  replies: {
    readonly chat?: inference.ChatCompletion;
    readonly chunks?: ReadonlyArray<inference.ChatCompletionChunk>;
    readonly failure?: inference.CreateChatCompletionError;
  },
  parameters?: Stackit.ModelServing.LanguageModelParameters,
) => {
  const requests: inference.CreateChatCompletionRequest[] = [];
  const layer = Stackit.ModelServing.makeLanguageModelLayer({
    model: "bound/model",
    parameters,
    chat: (request) =>
      Effect.suspend(() => {
        requests.push(request);
        return replies.failure !== undefined
          ? Effect.fail(replies.failure)
          : Effect.succeed(replies.chat!);
      }),
    chatStream: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return { events: Stream.fromIterable(replies.chunks ?? []) };
      }),
  });
  return { requests, layer };
};

const reply = (message: inference.ChatCompletionMessage): inference.ChatCompletion => ({
  choices: [{ message, finish_reason: "stop" }],
  usage,
});

const Add = Tool.make("add", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
});
const AddToolkit = Toolkit.make(Add);
const AddHandlers = AddToolkit.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) });

describe("Stackit.ModelServing.LanguageModel", options, () => {
  it.effect("sends the prompt, the model and the parameters", () =>
    Effect.gen(function* () {
      const { requests, layer } = adapter(
        { chat: reply({ content: "hello" }) },
        {
          maxCompletionTokens: 16,
          temperature: 0.5,
        },
      );
      const generated = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
        Effect.provide(layer),
      );
      expect(generated.text).toEqual("hello");
      expect(generated.usage.inputTokens.total).toEqual(3);
      expect(generated.usage.outputTokens.total).toEqual(2);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        model: "bound/model",
        max_completion_tokens: 16,
        temperature: 0.5,
      });
      expect(requests[0]?.messages.at(-1)).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "Say hello." }],
      });
    }),
  );

  it.effect("withModelParameters overrides a default and keeps the rest", () =>
    Effect.gen(function* () {
      const { requests, layer } = adapter(
        { chat: reply({ content: "hello" }) },
        {
          maxCompletionTokens: 16,
          temperature: 0.5,
        },
      );
      yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
        Stackit.ModelServing.withModelParameters({
          model: "other/model",
          temperature: 0,
          topP: undefined,
        }),
        Effect.provide(layer),
      );
      expect(requests[0]).toMatchObject({
        model: "other/model",
        max_completion_tokens: 16,
        temperature: 0,
      });
      expect(requests[0]).not.toHaveProperty("top_p");
    }),
  );

  it.effect("reads reasoning from its own field", () =>
    Effect.gen(function* () {
      const { layer } = adapter({ chat: reply({ content: "ok", reasoning_content: "thinking" }) });
      const generated = yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
        Effect.provide(layer),
      );
      expect(generated.text).toEqual("ok");
      expect(generated.reasoningText).toEqual("thinking");
    }),
  );

  it.effect("sends tools, and runs the tool the model calls", () =>
    Effect.gen(function* () {
      const { requests, layer } = adapter({
        chat: reply({
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "add", arguments: '{"a":1,"b":2}' },
            },
          ],
        }),
      });
      const generated = yield* LanguageModel.generateText({
        prompt: "Add 1 and 2.",
        toolkit: AddToolkit,
        toolChoice: { tool: "add" },
      }).pipe(Effect.provide(AddHandlers), Effect.provide(layer));
      expect(generated.toolCalls.map((call) => call.name)).toEqual(["add"]);
      expect(generated.toolResults.map((result) => result.result)).toEqual([3]);
      expect(requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(["add"]);
      expect(requests[0]?.tool_choice).toEqual({ type: "function", function: { name: "add" } });
    }),
  );

  it.effect("asks for structured output with a JSON Schema", () =>
    Effect.gen(function* () {
      const { requests, layer } = adapter({ chat: reply({ content: '{"greeting":"hi"}' }) });
      const generated = yield* LanguageModel.generateObject({
        prompt: "Greet me.",
        schema: Schema.Struct({ greeting: Schema.String }),
      }).pipe(Effect.provide(layer));
      expect(generated.value).toEqual({ greeting: "hi" });
      expect(requests[0]?.response_format).toMatchObject({ type: "json_schema" });
    }),
  );

  it.effect("maps a typed failure onto Effect AI's taxonomy", () =>
    Effect.gen(function* () {
      const { layer } = adapter({
        failure: new TooManyRequests({ message: "slow down" }),
      });
      const failure = yield* LanguageModel.generateText({ prompt: "hi" }).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      expect(failure.reason._tag).toEqual("RateLimitError");
    }),
  );

  it.effect("streams text, reasoning, usage and the finish reason", () =>
    Effect.gen(function* () {
      const { requests, layer } = adapter({
        chunks: [
          { choices: [{ delta: { reasoning_content: "hm" } }] },
          { choices: [{ delta: { content: "hel" } }] },
          { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
          { choices: [], usage },
        ],
      });
      const parts = yield* LanguageModel.streamText({ prompt: "hi" }).pipe(
        Stream.runCollect,
        Effect.provide(layer),
      );
      expect(parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))).toEqual([
        "hel",
        "lo",
      ]);
      expect(
        parts.flatMap((part) => (part.type === "reasoning-delta" ? [part.delta] : [])),
      ).toEqual(["hm"]);
      const finish = parts.find((part) => part.type === "finish");
      expect(finish?.reason).toEqual("stop");
      expect(finish?.usage.outputTokens.total).toEqual(2);
      expect(requests[0]?.stream_options).toEqual({ include_usage: true });
    }),
  );

  it.effect("assembles a streamed tool call and runs it", () =>
    Effect.gen(function* () {
      const { layer } = adapter({
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call-1", function: { name: "add", arguments: "" } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1,' } }] } },
            ],
          },
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: '"b":2}' } }] },
                finish_reason: "tool_calls",
              },
            ],
          },
        ],
      });
      const parts = yield* LanguageModel.streamText({
        prompt: "Add 1 and 2.",
        toolkit: AddToolkit,
      }).pipe(Stream.runCollect, Effect.provide(AddHandlers), Effect.provide(layer));
      const call = parts.find((part) => part.type === "tool-call");
      expect(call?.params).toEqual({ a: 1, b: 2 });
      const result = parts.find((part) => part.type === "tool-result");
      expect(result?.result).toEqual(3);
      expect(parts.find((part) => part.type === "finish")?.reason).toEqual("tool-calls");
    }),
  );

  it.effect("drops a tool call a length limit cut off", () =>
    Effect.gen(function* () {
      const { layer } = adapter({
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call-1", function: { name: "add", arguments: '{"a":1,' } },
                  ],
                },
                finish_reason: "length",
              },
            ],
          },
        ],
      });
      const parts = yield* LanguageModel.streamText({
        prompt: "Add 1 and 2.",
        toolkit: AddToolkit,
      }).pipe(Stream.runCollect, Effect.provide(AddHandlers), Effect.provide(layer));
      expect(parts.filter((part) => part.type === "tool-call")).toEqual([]);
      expect(parts.find((part) => part.type === "finish")?.reason).toEqual("length");
    }),
  );
});
