import * as OpenRouter from "@distilled.cloud/openrouter";
import type { Credentials } from "@distilled.cloud/openrouter/Credentials";
import { AiError, LanguageModel as AiLanguageModel, Response, Tool } from "effect/ai";
import { toCodecOpenAI } from "effect/ai/OpenAiStructuredOutput";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** Generation settings sent with every request. */
export interface LanguageModelParameters {
  /** Sampling temperature. */
  readonly temperature?: number;
  /** Maximum number of tokens to generate. */
  readonly maxTokens?: number;
  /** Nucleus-sampling probability mass. */
  readonly topP?: number;
  /** Top-k sampling (provider dependent). */
  readonly topK?: number;
  /** Deterministic sampling seed (provider dependent). */
  readonly seed?: number;
  /** Repetition penalty based on token frequency. */
  readonly frequencyPenalty?: number;
  /** Repetition penalty based on token presence. */
  readonly presencePenalty?: number;
  /** Sequences that stop generation (up to 4). */
  readonly stop?: ReadonlyArray<string>;
}

/** Configuration for an OpenRouter-backed Effect AI `LanguageModel`. */
export interface LanguageModelOptions {
  /** OpenRouter model slug, e.g. `"openai/gpt-4o-mini"` or `"anthropic/claude-sonnet-4.5"`. */
  readonly model: string;
  /**
   * Fallback models OpenRouter tries, in order, when `model` is unavailable
   * or rejects the request.
   */
  readonly fallbackModels?: ReadonlyArray<string>;
  /**
   * Provider routing preferences passed through verbatim (`order`,
   * `allow_fallbacks`, `data_collection`, `zdr`, `sort`, …).
   */
  readonly provider?: OpenRouter.ProviderPreferences;
  /** Default generation settings. */
  readonly parameters?: LanguageModelParameters;
  /** Stable end-user identifier forwarded for abuse detection and analytics. */
  readonly user?: string;
}

/**
 * Effect AI over OpenRouter's Chat Completions API, so any `effect/ai`
 * program (`LanguageModel.generateText`, `streamText`, `generateObject`,
 * toolkits, `Chat`) can run on any of OpenRouter's models. Supports text and
 * image inputs, function tools, JSON-schema structured output and streaming
 * (`createChatCompletionStream`). Tool and structured-output support depend
 * on the selected model.
 *
 * The layer authenticates with the ambient `OpenRouter.Credentials`. Provide
 * `OpenRouter.fromApiKey(key)` to run on a specific key — typically an
 * `OpenRouter.ApiKey` with its own budget — or `OpenRouter.CredentialsFromEnv`
 * to read `OPENROUTER_API_KEY`. The finish part carries the request's USD
 * cost as `metadata.openrouter.cost`; read it with `finishCost`.
 *
 * ### Generate text
 * **Example:** Generate text with an API key
 * ```typescript
 * import { LanguageModel } from "effect/ai";
 *
 * const model = OpenRouter.LanguageModel({ model: "openai/gpt-4o-mini" }).pipe(
 *   Layer.provide(OpenRouter.fromApiKey(Redacted.make(process.env.OPENROUTER_API_KEY!))),
 * );
 * const reply = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
 *   Effect.provide(model),
 * );
 * ```
 *
 * **Example:** Stream text
 * ```typescript
 * const parts = LanguageModel.streamText({ prompt: "Count to five." }).pipe(
 *   Stream.provide(model),
 * );
 * ```
 *
 * ### Structured output
 * **Example:** Decode the response with an Effect Schema
 * ```typescript
 * const reply = yield* LanguageModel.generateObject({
 *   prompt: "Return a short greeting.",
 *   schema: Schema.Struct({ greeting: Schema.String }),
 * }).pipe(Effect.provide(model));
 * ```
 *
 * ### Routing
 * **Example:** Fallback models and provider preferences
 * ```typescript
 * const model = OpenRouter.LanguageModel({
 *   model: "anthropic/claude-sonnet-4.5",
 *   fallbackModels: ["openai/gpt-4o"],
 *   provider: { data_collection: "deny", zdr: true },
 *   parameters: { temperature: 0, maxTokens: 512 },
 * });
 * ```
 *
 * ### Per-agent budgets
 * **Example:** Run an agent on a capped key
 * ```typescript
 * // deploy time
 * const key = yield* OpenRouter.ApiKey("Agent", { limit: 10, limitReset: "daily" });
 *
 * // runtime — `key.key` is the key's Redacted secret
 * const model = OpenRouter.LanguageModel({ model: "openai/gpt-4o-mini" }).pipe(
 *   Layer.provide(OpenRouter.fromApiKey(key.key)),
 * );
 * ```
 *
 * @layer
 * @provides effect/ai/LanguageModel
 * @product OpenRouter
 * @category AI
 */
export const LanguageModel = (
  options: LanguageModelOptions,
): Layer.Layer<AiLanguageModel.LanguageModel, never, Credentials> =>
  Layer.effect(AiLanguageModel.LanguageModel, makeLanguageModel(options)).pipe(
    Layer.provide(FetchHttpClient.layer),
  );

/** Construct the service with the ambient `HttpClient` (custom transports, tests). */
export const makeLanguageModel = (
  options: LanguageModelOptions,
): Effect.Effect<AiLanguageModel.LanguageModel, never, Credentials | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const complete = yield* OpenRouter.createChatCompletion;
    const completeStream = yield* OpenRouter.createChatCompletionStream;
    return yield* AiLanguageModel.make({
      codecTransformer: toCodecOpenAI,
      generateText: (providerOptions) =>
        Effect.gen(function* () {
          const request = yield* requestBody(providerOptions, options, false);
          const result = yield* complete(request).pipe(Effect.mapError(mapError));
          return yield* resultParts(result);
        }),
      streamText: (providerOptions) =>
        Stream.unwrap(
          Effect.map(requestBody(providerOptions, options, true), (request) =>
            streamParts(completeStream(request).pipe(Stream.mapError(mapError))),
          ),
        ),
    });
  });

/**
 * The USD cost OpenRouter billed for a response, read from its finish part
 * (`metadata.openrouter.cost`). `undefined` when OpenRouter did not report it.
 *
 * ```typescript
 * const response = yield* LanguageModel.generateText({ prompt });
 * const finish = response.content.find((part) => part.type === "finish");
 * const cost = finish ? OpenRouter.finishCost(finish) : undefined;
 * ```
 */
export const finishCost = (part: {
  readonly metadata: Response.FinishPartMetadata;
}): number | undefined =>
  Option.getOrUndefined(Option.map(decodeCost(part.metadata), (m) => m.openrouter.cost));

const decodeCost = Schema.decodeUnknownOption(
  Schema.Struct({ openrouter: Schema.Struct({ cost: Schema.Number }) }),
);

const MODULE = "OpenRouter.LanguageModel";

const error = (reason: AiError.AiError["reason"]) =>
  AiError.make({ module: MODULE, method: "chatCompletions", reason });
const invalidOutput = (description: string) =>
  error(new AiError.InvalidOutputError({ description }));
const invalidRequest = (description: string) =>
  error(new AiError.InvalidRequestError({ description }));

const retryAfter = (value: unknown) =>
  Duration.isDuration(value) ? { retryAfter: value } : ({} as const);

/** Map a typed OpenRouter SDK error onto the Effect AI error taxonomy. */
const mapError = (e: OpenRouter.CreateChatCompletionError): AiError.AiError => {
  const description = e.message;
  switch (e._tag) {
    case "InvalidApiKey":
    case "Unauthorized":
      return error(new AiError.AuthenticationError({ kind: "InvalidKey" }));
    case "Forbidden":
      return error(new AiError.AuthenticationError({ kind: "InsufficientPermissions" }));
    case "InsufficientCredits":
      return error(new AiError.QuotaExhaustedError({}));
    case "ModerationFlagged":
      return error(new AiError.ContentPolicyError({ description }));
    case "RateLimited":
    case "TooManyRequests":
      return error(
        new AiError.RateLimitError({
          ...(Predicate.hasProperty(e, "retryAfter") ? retryAfter(e.retryAfter) : {}),
        }),
      );
    case "BadRequest":
    case "NotFound":
    case "PayloadTooLarge":
    case "UnprocessableEntity":
      return error(new AiError.InvalidRequestError({ description }));
    case "RequestTimeout":
    case "ProviderError":
    case "NoAvailableProvider":
    case "ProviderTimeout":
    case "ProviderOverloaded":
    case "GatewayTimeout":
    case "InternalServerError":
    case "BadGateway":
    case "ServiceUnavailable":
      return error(new AiError.InternalProviderError({ description }));
    case "HttpClientError":
      return error(
        new AiError.NetworkError({
          reason: "TransportError",
          request: {
            method: "POST",
            url: "/chat/completions",
            urlParams: [],
            headers: {},
          },
          description: "OpenRouter transport failed",
        }),
      );
    case "OpenRouterParseError":
      return invalidOutput("Invalid Chat Completions response shape");
    default:
      return error(new AiError.UnknownError({ description }));
  }
};

const parseArguments = (value: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
    value || "{}",
  ).pipe(Effect.mapError(() => invalidOutput("Invalid function-call JSON arguments")));

const finishReason = (reason: string | null | undefined): Response.FinishReason => {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    case "error":
      return "error";
    case null:
    case undefined:
      return "unknown";
    default:
      return "other";
  }
};

const usage = (value: OpenRouter.ChatUsage | undefined) => {
  const input = value?.prompt_tokens;
  const cached = value?.prompt_tokens_details?.cached_tokens;
  const cacheWrite = value?.prompt_tokens_details?.cache_write_tokens;
  const output = value?.completion_tokens;
  const reasoning = value?.completion_tokens_details?.reasoning_tokens ?? undefined;
  return new Response.Usage({
    inputTokens: {
      total: input,
      uncached: input === undefined ? undefined : Math.max(0, input - (cached ?? 0)),
      cacheRead: cached,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output === undefined ? undefined : Math.max(0, output - (reasoning ?? 0)),
      reasoning,
    },
  });
};

const finishMetadata = (value: OpenRouter.ChatUsage | undefined) =>
  typeof value?.cost === "number" && Number.isFinite(value.cost)
    ? { metadata: { openrouter: { cost: value.cost } } }
    : {};

const textOf = (content: OpenRouter.ChatAssistantMessage["content"]): string => {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .map((item) =>
      Predicate.hasProperty(item, "type") &&
      item.type === "text" &&
      Predicate.hasProperty(item, "text") &&
      typeof item.text === "string"
        ? item.text
        : "",
    )
    .join("");
};

const resultParts = Effect.fn(function* (result: OpenRouter.ChatResult) {
  const choice = result.choices[0];
  if (!choice) return yield* invalidOutput("Completion has no choices");
  const message = choice.message;
  if (message.refusal) {
    return yield* error(new AiError.ContentPolicyError({ description: message.refusal }));
  }
  const parts: Array<Response.PartEncoded> = [];
  if (message.reasoning) parts.push({ type: "reasoning", text: message.reasoning });
  const text = textOf(message.content);
  if (text) parts.push({ type: "text", text });
  for (const call of message.tool_calls ?? []) {
    parts.push({
      type: "tool-call",
      id: call.id,
      name: call.function.name,
      params: yield* parseArguments(call.function.arguments),
    });
  }
  parts.push({
    type: "finish",
    reason: finishReason(choice.finish_reason),
    usage: usage(result.usage),
    response: undefined,
    ...finishMetadata(result.usage),
  });
  return parts;
});

const stringify = (value: unknown) =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: () => invalidRequest("Prompt contains a non-JSON value"),
  });

const imageUrl = (part: { readonly data: string | Uint8Array | URL; readonly mediaType: string }) =>
  Effect.sync(() => {
    if (part.data instanceof URL) return part.data.toString();
    if (part.data instanceof Uint8Array) {
      let binary = "";
      for (const byte of part.data) binary += String.fromCharCode(byte);
      return `data:${part.mediaType};base64,${btoa(binary)}`;
    }
    return /^(data:|https?:)/.test(part.data)
      ? part.data
      : `data:${part.mediaType};base64,${part.data}`;
  });

const requestBody = Effect.fn(function* (
  providerOptions: AiLanguageModel.ProviderOptions,
  options: LanguageModelOptions,
  stream: boolean,
) {
  if (providerOptions.tools.some(Tool.isProviderDefined)) {
    return yield* invalidRequest("Provider-executed tools are not supported by OpenRouter");
  }
  const messages: Array<OpenRouter.ChatMessages> = [];
  for (const message of providerOptions.prompt.content) {
    switch (message.role) {
      case "system": {
        messages.push({ role: "system", content: message.content });
        break;
      }
      case "user": {
        const content: Array<OpenRouter.ChatContentItems> = [];
        for (const part of message.content) {
          if (part.type === "text") {
            content.push({ type: "text", text: part.text });
          } else if (part.type === "file" && part.mediaType.startsWith("image/")) {
            content.push({ type: "image_url", image_url: { url: yield* imageUrl(part) } });
          } else {
            return yield* invalidRequest("Only text and image user inputs are supported");
          }
        }
        messages.push({ role: "user", content });
        break;
      }
      case "assistant": {
        const text: Array<string> = [];
        const toolCalls: Array<OpenRouter.ChatToolCall> = [];
        for (const part of message.content) {
          if (part.type === "text") text.push(part.text);
          else if (part.type === "tool-call") {
            toolCalls.push({
              id: part.id,
              type: "function",
              function: { name: part.name, arguments: yield* stringify(part.params) },
            });
          } else if (part.type !== "reasoning") {
            return yield* invalidRequest("Unsupported assistant content for Chat Completions");
          }
        }
        messages.push({
          role: "assistant",
          content: text.join("") || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        break;
      }
      case "tool": {
        for (const part of message.content) {
          if (part.type !== "tool-result") {
            return yield* invalidRequest("Unsupported tool message for Chat Completions");
          }
          messages.push({
            role: "tool",
            tool_call_id: part.id,
            content: typeof part.result === "string" ? part.result : yield* stringify(part.result),
          });
        }
        break;
      }
    }
  }

  const choice = providerOptions.toolChoice;
  const selected =
    typeof choice === "object" && "oneOf" in choice
      ? providerOptions.tools.filter((tool) => choice.oneOf.includes(tool.name))
      : providerOptions.tools;
  const tools = yield* Effect.try({
    try: () =>
      selected.map((tool): OpenRouter.ChatFunctionTool => ({
        type: "function",
        function: {
          name: tool.name,
          description: Tool.getDescription(tool),
          parameters: Tool.getJsonSchema(tool) as Record<string, unknown>,
        },
      })),
    catch: () => invalidRequest("Tool schema cannot be represented as JSON Schema"),
  });
  const toolChoice: OpenRouter.ChatToolChoice | undefined =
    tools.length === 0
      ? undefined
      : typeof choice === "object"
        ? "tool" in choice
          ? { type: "function", function: { name: choice.tool } }
          : (choice.mode ?? "auto")
        : choice;

  const responseFormat = providerOptions.responseFormat;
  const jsonSchema =
    responseFormat.type === "json"
      ? yield* Effect.try({
          try: () => toCodecOpenAI(responseFormat.schema).jsonSchema,
          catch: () =>
            error(
              new AiError.UnsupportedSchemaError({
                description: "Schema is not supported by OpenAI-style structured output",
              }),
            ),
        })
      : undefined;

  const parameters = options.parameters;
  const request: OpenRouter.CreateChatCompletionRequest = {
    model: options.model,
    messages,
    ...(options.fallbackModels?.length ? { models: [...options.fallbackModels] } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.user ? { user: options.user } : {}),
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
    ...(jsonSchema && responseFormat.type === "json"
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: responseFormat.objectName,
              schema: jsonSchema as Record<string, unknown>,
              strict: true,
            },
          },
        }
      : {}),
    temperature: parameters?.temperature,
    max_tokens: parameters?.maxTokens,
    top_p: parameters?.topP,
    top_k: parameters?.topK,
    seed: parameters?.seed,
    frequency_penalty: parameters?.frequencyPenalty,
    presence_penalty: parameters?.presencePenalty,
    ...(parameters?.stop?.length ? { stop: [...parameters.stop] } : {}),
  };
  return request;
});

/** Translate the decoded SSE chunk stream into Effect AI stream parts. */
const streamParts = (
  chunks: Stream.Stream<OpenRouter.ChatStreamChunk, AiError.AiError>,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.unwrap(
    Effect.sync(() => {
      let reason: string | undefined;
      let tokenUsage: OpenRouter.ChatUsage | undefined;
      let textStarted = false;
      let reasoningStarted = false;
      const calls = new Map<
        number,
        { id: string; name: string; arguments: string; started: boolean }
      >();

      const deltas = chunks.pipe(
        Stream.mapEffect((chunk) =>
          Effect.gen(function* () {
            const parts: Array<Response.StreamPartEncoded> = [];
            if (chunk.error) {
              const { code, message } = chunk.error;
              return yield* error(
                code === 402
                  ? new AiError.QuotaExhaustedError({})
                  : code === 429
                    ? new AiError.RateLimitError({})
                    : new AiError.InternalProviderError({ description: message }),
              );
            }
            if (chunk.usage) tokenUsage = chunk.usage;
            for (const choice of chunk.choices) {
              if (choice.index !== 0) continue;
              if (choice.finish_reason != null) reason = choice.finish_reason;
              const delta = choice.delta;
              if (delta.refusal) {
                return yield* error(new AiError.ContentPolicyError({ description: delta.refusal }));
              }
              if (delta.reasoning) {
                if (!reasoningStarted) {
                  reasoningStarted = true;
                  parts.push({ type: "reasoning-start", id: "reasoning" });
                }
                parts.push({ type: "reasoning-delta", id: "reasoning", delta: delta.reasoning });
              }
              if (delta.content) {
                if (!textStarted) {
                  textStarted = true;
                  parts.push({ type: "text-start", id: "text" });
                }
                parts.push({ type: "text-delta", id: "text", delta: delta.content });
              }
              for (const deltaCall of delta.tool_calls ?? []) {
                const call = calls.get(deltaCall.index) ?? {
                  id: "",
                  name: "",
                  arguments: "",
                  started: false,
                };
                if (deltaCall.id) {
                  if (call.id && call.id !== deltaCall.id) {
                    return yield* invalidOutput("Tool call ID changed within a stream");
                  }
                  call.id = deltaCall.id;
                }
                if (deltaCall.function?.name) call.name = deltaCall.function.name;
                const args = deltaCall.function?.arguments ?? "";
                call.arguments += args;
                if (!call.started && call.id && call.name) {
                  call.started = true;
                  parts.push({ type: "tool-params-start", id: call.id, name: call.name });
                  if (call.arguments) {
                    parts.push({ type: "tool-params-delta", id: call.id, delta: call.arguments });
                  }
                } else if (call.started && args) {
                  parts.push({ type: "tool-params-delta", id: call.id, delta: args });
                }
                calls.set(deltaCall.index, call);
              }
            }
            return parts;
          }),
        ),
        Stream.flatMap(Stream.fromIterable),
      );

      const finish = Stream.unwrap(
        Effect.gen(function* () {
          if (reason === undefined) {
            return yield* invalidOutput("Chat Completions stream ended without a finish reason");
          }
          const parts: Array<Response.StreamPartEncoded> = [];
          if (reasoningStarted) parts.push({ type: "reasoning-end", id: "reasoning" });
          if (textStarted) parts.push({ type: "text-end", id: "text" });
          for (const call of calls.values()) {
            if (!call.started) return yield* invalidOutput("Incomplete streamed tool identity");
            parts.push({ type: "tool-params-end", id: call.id });
            if (reason !== "length" && reason !== "content_filter") {
              parts.push({
                type: "tool-call",
                id: call.id,
                name: call.name,
                params: yield* parseArguments(call.arguments),
              });
            }
          }
          parts.push({
            type: "finish",
            reason: finishReason(reason),
            usage: usage(tokenUsage),
            response: undefined,
            ...finishMetadata(tokenUsage),
          });
          return Stream.fromIterable(parts);
        }),
      );

      return Stream.concat(deltas, finish);
    }),
  );
