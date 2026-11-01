import type * as inference from "@distilled.cloud/stackit/model_serving_inference";
import * as Binding from "alchemy/Binding";
import { AiError, LanguageModel as AiLanguageModel, Response, Tool } from "effect/ai";
import { toCodecOpenAI } from "effect/ai/OpenAiStructuredOutput";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Token } from "./Token.ts";

/**
 * Inference parameters applied to every request made through a {@link LanguageModel}. Each model
 * decides which it honours, and they are sent as they are.
 */
export interface LanguageModelParameters {
  /** Maximum number of tokens the model may generate. */
  maxCompletionTokens?: number;
  /** Sampling temperature. Lower values make the output more deterministic. */
  temperature?: number;
  /** Nucleus-sampling probability mass. */
  topP?: number;
  /** Deterministic sampling seed, on models that take one. */
  seed?: number;
  /** Repetition penalty based on token frequency. */
  frequencyPenalty?: number;
  /** Repetition penalty based on token presence. */
  presencePenalty?: number;
  /** Sequences that stop generation when the model emits them. */
  stop?: string[];
}

/** Options for binding a {@link LanguageModel}. */
export interface LanguageModelOptions {
  /**
   * The model's full name, as in `openai/gpt-oss-20b`. `Stackit.ModelServing.ListModels` lists them,
   * and STACKIT's docs retire them over time. Only chat models work here.
   */
  model: string;
  /** Default inference parameters. Override them per call with {@link withModelParameters}. */
  parameters?: LanguageModelParameters;
}

/**
 * Per-call overrides applied with {@link withModelParameters}: any
 * {@link LanguageModelParameters} field plus the model to run the call on.
 */
export interface LanguageModelCallParameters extends LanguageModelParameters {
  /**
   * The model to run this call on. The token reaches every shared model in its region.
   * @default the bound model
   */
  model?: string;
}

/**
 * Fiber-scoped {@link LanguageModelCallParameters} consulted on every call made through a
 * STACKIT-backed `LanguageModel`. Set it for a region of your program with
 * {@link withModelParameters}.
 */
export const CurrentModelParameters = Context.Reference<LanguageModelCallParameters>(
  "Stackit.ModelServing.CurrentModelParameters",
  { defaultValue: () => ({}) },
);

/**
 * Scope per-call inference parameters, and optionally the model, onto an Effect or Stream that
 * talks to a STACKIT-backed `LanguageModel`. Defined fields override the binding's `parameters`.
 *
 * ```typescript
 * const reply = yield* LanguageModel.generateText({ prompt }).pipe(
 *   Stackit.ModelServing.withModelParameters({ temperature: 0, maxCompletionTokens: 64 }),
 * );
 * ```
 */
export const withModelParameters =
  (parameters: LanguageModelCallParameters) =>
  <S extends Effect.Effect<any, any, any> | Stream.Stream<any, any, any>>(self: S): S =>
    (Effect.isEffect(self)
      ? Effect.provideService(CurrentModelParameters, parameters)(self)
      : Stream.provideService(
          CurrentModelParameters,
          parameters,
        )(self as Stream.Stream<any, any, any>)) as S;

/**
 * Runtime binding that turns a shared STACKIT model into an `effect/ai`
 * {@link AiLanguageModel.LanguageModel} `Layer`, so any Effect AI program
 * (`LanguageModel.generateText`, `streamText`, `generateObject`, `Chat`, toolkits, ...) runs on
 * STACKIT AI Model Serving without code changes. Calls go through the OpenAI-compatible
 * `POST /v1/chat/completions`.
 *
 * The API keeps no session. Function tools and images depend on the model. STACKIT's docs show
 * tool calling and promise OpenAI compatibility but say nothing about streaming or structured
 * output, so a first live run has to confirm `streamText` and `generateObject`. Audio, provider
 * executed tools and non-image files are refused with `InvalidRequestError`.
 *
 * Access: the bound token itself, which reaches every shared model in its region. Nothing else is
 * granted, and no service account is created. The token's value reaches the host's env
 * `Redacted`. Inference is billed per million tokens of text.
 *
 * ### Effect AI on STACKIT
 * **Example:** Generate Text
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import { LanguageModel } from "effect/ai";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ai = Stackit.ModelServing.Token("Ai", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const model = yield* Stackit.ModelServing.LanguageModel(yield* Ai, {
 *       model: "openai/gpt-oss-20b",
 *       parameters: { maxCompletionTokens: 256, temperature: 0.2 },
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const reply = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
 *           Effect.provide(model),
 *         );
 *         return yield* HttpServerResponse.json({ text: reply.text });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelServing.LanguageModelHttp)),
 * ) {}
 * ```
 *
 * **Example:** Stream Text
 * ```typescript
 * const parts = LanguageModel.streamText({ prompt: "Say hello." }).pipe(Stream.provide(model));
 * // parts is a Stream of text-start / text-delta / ... / finish parts.
 * ```
 *
 * ### Runtime Configuration
 * **Example:** Override Parameters Per Call
 * ```typescript
 * const reply = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
 *   Stackit.ModelServing.withModelParameters({ temperature: 0, maxCompletionTokens: 64 }),
 *   Effect.provide(model),
 * );
 * ```
 *
 * **Example:** Run One Call on Another Model
 * ```typescript
 * const reply = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
 *   Stackit.ModelServing.withModelParameters({ model: "google/gemma-4-31B-it" }),
 *   Effect.provide(model),
 * );
 * ```
 *
 * ### Tool Calling
 * **Example:** Call Tools with a Toolkit
 * ```typescript
 * import { LanguageModel, Tool, Toolkit } from "effect/ai";
 * import * as Schema from "effect/Schema";
 *
 * const GetWeather = Tool.make("get_weather", {
 *   description: "Get the current weather for a city.",
 *   parameters: Schema.Struct({ city: Schema.String }),
 *   success: Schema.Struct({ celsius: Schema.Number }),
 * });
 * const Weather = Toolkit.make(GetWeather);
 *
 * const reply = yield* LanguageModel.generateText({
 *   prompt: "What's the weather in Berlin?",
 *   toolkit: Weather,
 * }).pipe(
 *   Effect.provide(Weather.toLayer({ get_weather: () => Effect.succeed({ celsius: 21 }) })),
 *   Effect.provide(model),
 * );
 * ```
 *
 * @binding
 * @product STACKIT AI Model Serving
 * @category ModelServing
 */
export interface LanguageModel extends Binding.Service<
  LanguageModel,
  "Stackit.ModelServing.LanguageModel",
  (
    token: Token,
    options: LanguageModelOptions,
  ) => Effect.Effect<Layer.Layer<AiLanguageModel.LanguageModel>>
> {}
export const LanguageModel = Binding.Service<LanguageModel>("Stackit.ModelServing.LanguageModel");

/** The already-bound inference callables the adapter drives. */
export interface MakeLanguageModelOptions extends LanguageModelOptions {
  /** Non-streaming chat completion. */
  readonly chat: (
    request: inference.CreateChatCompletionRequest,
  ) => Effect.Effect<inference.ChatCompletion, inference.CreateChatCompletionError>;
  /** Streaming chat completion. */
  readonly chatStream: (
    request: inference.StreamChatCompletionRequest,
  ) => Effect.Effect<inference.ChatCompletionEvents, inference.StreamChatCompletionError>;
}

/** Provide an {@link AiLanguageModel.LanguageModel} layer over the supplied callables. */
export const makeLanguageModelLayer = (
  options: MakeLanguageModelOptions,
): Layer.Layer<AiLanguageModel.LanguageModel> =>
  Layer.effect(AiLanguageModel.LanguageModel, makeLanguageModel(options));

/** Build an {@link AiLanguageModel.LanguageModel} over the supplied callables. */
export const makeLanguageModel = ({
  chat,
  chatStream,
  model,
  parameters,
}: MakeLanguageModelOptions): Effect.Effect<AiLanguageModel.LanguageModel> =>
  AiLanguageModel.make({
    codecTransformer: toCodecOpenAI,
    generateText: (options) =>
      Effect.gen(function* () {
        const call = yield* CurrentModelParameters;
        const request = yield* toRequest(options, model, parameters, call);
        const reply = yield* chat(request).pipe(
          Effect.mapError((cause) => toAiError(cause, "generateText")),
        );
        return yield* toResponseParts(reply);
      }),
    streamText: (options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const call = yield* CurrentModelParameters;
          const request = yield* toRequest(options, model, parameters, call);
          const { events } = yield* chatStream({
            ...request,
            stream_options: { include_usage: true },
          }).pipe(Effect.mapError((cause) => toAiError(cause, "streamText")));
          return toStreamParts(events);
        }),
      ),
  });

const MODULE = "Stackit.ModelServing.LanguageModel";

type Method = "generateText" | "streamText";

const failure = (method: Method, reason: AiError.AiError["reason"]) =>
  AiError.make({ module: MODULE, method, reason });

const invalidRequest = (description: string) =>
  failure("generateText", AiError.InvalidRequestError.make({ description }));

const invalidOutput = (method: Method, description: string) =>
  failure(method, AiError.InvalidOutputError.make({ description }));

/** A distilled failure as Effect AI's taxonomy. The API's message never holds the token. */
const toAiError = (
  cause: inference.CreateChatCompletionError | inference.StreamChatCompletionError,
  method: Method,
): AiError.AiError => {
  const description = ("message" in cause ? cause.message : undefined) || cause._tag;
  switch (cause._tag) {
    case "HttpClientError":
      return failure(
        method,
        AiError.NetworkError.make({
          reason: "TransportError",
          method: "POST",
          url: "/v1/chat/completions",
          description,
        }),
      );
    case "Unauthorized":
      return failure(method, AiError.AuthenticationError.make({ kind: "InvalidKey" }));
    case "Forbidden":
      return failure(method, AiError.AuthenticationError.make({ kind: "InsufficientPermissions" }));
    case "ConfigError":
      return failure(method, AiError.AuthenticationError.make({ kind: "MissingKey" }));
    case "TooManyRequests":
      return failure(
        method,
        AiError.RateLimitError.make(
          cause.retryAfter === undefined ? {} : { retryAfter: cause.retryAfter },
        ),
      );
    case "BadRequest":
    case "NotFound":
    case "InvalidInput":
      return failure(method, AiError.InvalidRequestError.make({ description }));
    case "InternalServerError":
    case "ServiceUnavailable":
      return failure(method, AiError.InternalProviderError.make({ description }));
    case "StackitParseError":
      return failure(method, AiError.InvalidOutputError.make({ description }));
    default:
      return failure(method, AiError.UnknownError.make({ description }));
  }
};

/** Bytes as a data URI, without a Node import. */
const fileToImageUrl = (data: string | Uint8Array | URL, mediaType: string): string => {
  if (data instanceof URL) return data.toString();
  if (data instanceof Uint8Array) {
    let binary = "";
    for (const byte of data) binary += String.fromCharCode(byte);
    return `data:${mediaType};base64,${btoa(binary)}`;
  }
  return /^(data:|https?:)/.test(data) ? data : `data:${mediaType};base64,${data}`;
};

const stringify = (value: unknown) =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: () => invalidRequest("The prompt holds a value that isn't JSON"),
  });

const toMessages = (prompt: AiLanguageModel.ProviderOptions["prompt"]) =>
  Effect.gen(function* () {
    const messages: inference.ChatMessage[] = [];
    for (const message of prompt.content) {
      switch (message.role) {
        case "system":
          messages.push({ role: "system", content: message.content });
          break;
        case "user": {
          const content: inference.ChatMessageContentPart[] = [];
          for (const part of message.content) {
            if (part.type === "text") content.push({ type: "text", text: part.text });
            else if (part.type === "file" && part.mediaType.startsWith("image/")) {
              content.push({
                type: "image_url",
                image_url: { url: fileToImageUrl(part.data, part.mediaType) },
              });
            } else return yield* invalidRequest("Only text and image inputs are supported");
          }
          messages.push({ role: "user", content });
          break;
        }
        case "assistant": {
          let text = "";
          const toolCalls: inference.ToolCall[] = [];
          for (const part of message.content) {
            if (part.type === "text") text += part.text;
            else if (part.type === "tool-call") {
              const args = yield* stringify(part.params);
              toolCalls.push({
                id: part.id,
                type: "function",
                function: { name: part.name, arguments: args },
              });
            } else if (part.type !== "reasoning") {
              return yield* invalidRequest("Unsupported assistant content for chat completions");
            }
          }
          messages.push({
            role: "assistant",
            content: text === "" ? null : text,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
          break;
        }
        case "tool":
          for (const part of message.content) {
            if (part.type !== "tool-result") {
              return yield* invalidRequest("Unsupported tool message for chat completions");
            }
            const content =
              typeof part.result === "string" ? part.result : yield* stringify(part.result);
            messages.push({ role: "tool", tool_call_id: part.id, content });
          }
          break;
      }
    }
    return messages;
  });

const toTools = (options: AiLanguageModel.ProviderOptions) =>
  Effect.gen(function* () {
    const choice = options.toolChoice;
    if (options.tools.some(Tool.isProviderDefined)) {
      return yield* invalidRequest("Provider-executed tools need a native provider API");
    }
    const selected =
      typeof choice === "object" && "oneOf" in choice
        ? options.tools.filter((tool) => choice.oneOf.includes(tool.name))
        : options.tools;
    if (selected.length === 0) return {};
    const tools = yield* Effect.try({
      try: () =>
        selected.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: Tool.getDescription(tool),
            parameters: Tool.getJsonSchema(tool) as { [key: string]: unknown },
          },
        })),
      catch: () => invalidRequest("A tool's schema can't be written as JSON Schema"),
    });
    return {
      tools,
      tool_choice:
        typeof choice === "object"
          ? "tool" in choice
            ? { type: "function", function: { name: choice.tool } }
            : (choice.mode ?? "auto")
          : choice,
    };
  });

const toResponseFormat = (format: AiLanguageModel.ProviderOptions["responseFormat"]) =>
  format.type !== "json"
    ? Effect.succeed({})
    : Effect.try({
        try: () => ({
          response_format: {
            type: "json_schema",
            json_schema: {
              name: format.objectName,
              schema: toCodecOpenAI(format.schema).jsonSchema,
              strict: true,
            },
          },
        }),
        catch: () =>
          failure(
            "generateText",
            AiError.UnsupportedSchemaError.make({
              description: "The schema can't be written as OpenAI structured output",
            }),
          ),
      });

const toRequest = (
  options: AiLanguageModel.ProviderOptions,
  model: string,
  defaults: LanguageModelParameters | undefined,
  call: LanguageModelCallParameters,
) =>
  Effect.gen(function* () {
    const messages = yield* toMessages(options.prompt);
    const tools = yield* toTools(options);
    const format = yield* toResponseFormat(options.responseFormat);
    const merged = { ...defaults, ...definedOnly(call) };
    return {
      model: call.model ?? model,
      messages,
      ...tools,
      ...format,
      ...(merged.maxCompletionTokens !== undefined
        ? { max_completion_tokens: merged.maxCompletionTokens }
        : {}),
      ...(merged.temperature !== undefined ? { temperature: merged.temperature } : {}),
      ...(merged.topP !== undefined ? { top_p: merged.topP } : {}),
      ...(merged.seed !== undefined ? { seed: merged.seed } : {}),
      ...(merged.frequencyPenalty !== undefined
        ? { frequency_penalty: merged.frequencyPenalty }
        : {}),
      ...(merged.presencePenalty !== undefined ? { presence_penalty: merged.presencePenalty } : {}),
      ...(merged.stop !== undefined ? { stop: merged.stop } : {}),
    } satisfies inference.CreateChatCompletionRequest;
  });

/** An undefined override never clobbers a configured default. */
const definedOnly = (parameters: LanguageModelCallParameters): LanguageModelParameters =>
  Object.fromEntries(
    Object.entries(parameters).filter(([key, value]) => key !== "model" && value !== undefined),
  );

const mapFinishReason = (reason: string | null | undefined): Response.FinishReason => {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    case null:
    case undefined:
      return "unknown";
    default:
      return "other";
  }
};

const mapUsage = (usage: inference.Usage | null | undefined): Response.Usage => {
  const input = usage?.prompt_tokens;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? undefined;
  const output = usage?.completion_tokens ?? undefined;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? undefined;
  return Response.Usage.make({
    inputTokens: {
      total: input,
      uncached: input === undefined ? undefined : Math.max(0, input - (cached ?? 0)),
      cacheRead: cached,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: output,
      text: output === undefined ? undefined : Math.max(0, output - (reasoning ?? 0)),
      reasoning,
    },
  });
};

const parseArguments = (text: string, method: Method) =>
  Effect.try({
    try: () => JSON.parse(text === "" ? "{}" : text) as unknown,
    catch: () => invalidOutput(method, "A tool call's arguments aren't JSON"),
  });

const toResponseParts = (reply: inference.ChatCompletion) =>
  Effect.gen(function* () {
    const choice = reply.choices[0];
    if (choice === undefined)
      return yield* invalidOutput("generateText", "The reply has no choices");
    const message = choice.message;
    if (message.refusal) {
      return yield* failure(
        "generateText",
        AiError.ContentPolicyError.make({ description: message.refusal }),
      );
    }
    const parts: Response.PartEncoded[] = [];
    if (message.reasoning_content) {
      parts.push({ type: "reasoning", text: message.reasoning_content });
    }
    if (message.content) parts.push({ type: "text", text: message.content });
    for (const call of message.tool_calls ?? []) {
      const params = yield* parseArguments(call.function.arguments, "generateText");
      parts.push({ type: "tool-call", id: call.id, name: call.function.name, params });
    }
    parts.push({
      type: "finish",
      reason: mapFinishReason(choice.finish_reason),
      usage: mapUsage(reply.usage),
      response: undefined,
    });
    return parts;
  });

interface OpenToolCall {
  id: string;
  name: string;
  arguments: string;
  started: boolean;
}

const toStreamParts = (
  events: Stream.Stream<inference.ChatCompletionChunk, inference.ModelServingInferenceOpError>,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.suspend(() => {
    // One stream's state, read by the chunks in order and then by the closing parts.
    let reason: string | null | undefined;
    let usage: inference.Usage | null | undefined;
    let textStarted = false;
    let reasoningStarted = false;
    const calls = new Map<number, OpenToolCall>();

    const chunkParts = (chunk: inference.ChatCompletionChunk) =>
      Effect.gen(function* () {
        const parts: Response.StreamPartEncoded[] = [];
        if (chunk.usage != null) usage = chunk.usage;
        for (const choice of chunk.choices) {
          if (choice.index !== undefined && choice.index !== 0) continue;
          if (choice.finish_reason != null) reason = choice.finish_reason;
          const delta = choice.delta;
          if (delta.refusal) {
            return yield* failure(
              "streamText",
              AiError.ContentPolicyError.make({ description: delta.refusal }),
            );
          }
          if (delta.reasoning_content) {
            if (!reasoningStarted) {
              reasoningStarted = true;
              parts.push({ type: "reasoning-start", id: "reasoning" });
            }
            parts.push({
              type: "reasoning-delta",
              id: "reasoning",
              delta: delta.reasoning_content,
            });
          }
          if (delta.content) {
            if (!textStarted) {
              textStarted = true;
              parts.push({ type: "text-start", id: "text" });
            }
            parts.push({ type: "text-delta", id: "text", delta: delta.content });
          }
          for (const part of delta.tool_calls ?? []) {
            const call = calls.get(part.index) ?? {
              id: "",
              name: "",
              arguments: "",
              started: false,
            };
            calls.set(part.index, call);
            if (part.id) call.id = part.id;
            if (part.function?.name) call.name = part.function.name;
            const args = part.function?.arguments ?? "";
            call.arguments += args;
            if (!call.started && call.id !== "" && call.name !== "") {
              call.started = true;
              parts.push({ type: "tool-params-start", id: call.id, name: call.name });
              if (call.arguments !== "") {
                parts.push({ type: "tool-params-delta", id: call.id, delta: call.arguments });
              }
            } else if (call.started && args !== "") {
              parts.push({ type: "tool-params-delta", id: call.id, delta: args });
            }
          }
        }
        return parts;
      });

    const closingParts = Effect.gen(function* () {
      const parts: Response.StreamPartEncoded[] = [];
      if (reasoningStarted) parts.push({ type: "reasoning-end", id: "reasoning" });
      if (textStarted) parts.push({ type: "text-end", id: "text" });
      for (const call of calls.values()) {
        if (!call.started) {
          return yield* invalidOutput("streamText", "A streamed tool call has no id or name");
        }
        parts.push({ type: "tool-params-end", id: call.id });
        // Arguments cut off by a length limit aren't JSON, and no tool should run on them.
        if (reason !== "length" && reason !== "content_filter") {
          const params = yield* parseArguments(call.arguments, "streamText");
          parts.push({ type: "tool-call", id: call.id, name: call.name, params });
        }
      }
      parts.push({
        type: "finish",
        reason: mapFinishReason(reason),
        usage: mapUsage(usage),
        response: undefined,
      });
      return parts;
    });

    return events.pipe(
      Stream.mapError((cause) => toAiError(cause, "streamText")),
      Stream.mapEffect(chunkParts),
      Stream.flatMap(Stream.fromIterable),
      Stream.concat(Stream.unwrap(Effect.map(closingParts, Stream.fromIterable))),
    );
  });
