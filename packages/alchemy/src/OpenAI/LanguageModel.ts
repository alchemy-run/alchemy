import * as OpenAI from "@distilled.cloud/openai";
import type { Credentials } from "@distilled.cloud/openai/Credentials";
import { AiError, LanguageModel as AiLanguageModel, Prompt, Response, Tool } from "effect/ai";
import { toCodecOpenAI } from "effect/ai/OpenAiStructuredOutput";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

type CreateResponseRequest = OpenAI.responses.CreateResponseRequest;
type InputItem = OpenAI.responses.InputItem;
type InputContent = OpenAI.responses.InputContent;
type FunctionTool = OpenAI.responses.FunctionTool;
type ToolChoiceParam = OpenAI.responses.ToolChoiceParam;
type OutputItem = OpenAI.responses.OutputItem;
type ResponseUsage = OpenAI.responses.ResponseUsage;
type StreamEvent = OpenAI.responses.ResponseStreamEvent;
type CreateResponseError = OpenAI.responses.CreateResponseError;

/** Generation settings sent with every request (Responses API). */
export interface LanguageModelParameters {
  /** Sampling temperature. Not supported by reasoning models. */
  readonly temperature?: number;
  /** Nucleus sampling probability. Not supported by reasoning models. */
  readonly topP?: number;
  /** Upper bound on generated tokens, including reasoning tokens. */
  readonly maxOutputTokens?: number;
  /** Reasoning effort for reasoning models (`gpt-5*`, `o*`). */
  readonly reasoningEffort?: OpenAI.responses.ReasoningEffort;
  /** Whether the model may call several tools in one turn. @default true */
  readonly parallelToolCalls?: boolean;
  /** Processing tier, e.g. `"flex"` or `"priority"`. */
  readonly serviceTier?: "auto" | "default" | "flex" | "scale" | "priority";
}

/** Options for {@link LanguageModel}. */
export interface LanguageModelOptions {
  /** Model ID, e.g. `gpt-5-mini`. */
  readonly model: string;
  /** Generation settings applied to every call. */
  readonly parameters?: LanguageModelParameters;
}

/**
 * An `effect/ai` `LanguageModel` backed by the OpenAI Responses API, so any
 * Effect AI program (`LanguageModel.generateText`, `streamText`,
 * `generateObject`, `Chat`, toolkits) runs against OpenAI.
 *
 * Supports text and image/PDF inputs, function tools (with `toolChoice`),
 * JSON-schema structured output, reasoning summaries, and streaming over
 * server-sent events. Requests are stateless (`store: false`): the full
 * conversation is sent on every call. OpenAI's hosted tools (web search, file
 * search, code interpreter) are not exposed.
 *
 * The layer needs OpenAI `Credentials` (an `OPENAI_API_KEY`) and an
 * `HttpClient`. API failures surface as an `AiError` whose `reason` reflects
 * the typed OpenAI error — e.g. an out-of-credits organization
 * (`InsufficientQuota`) becomes a `QuotaExhaustedError`, a rate limit a
 * `RateLimitError`, a bad key an `AuthenticationError`.
 *
 * ### Generate Text
 * **Example:** One-shot generation
 * ```typescript
 * import { LanguageModel } from "effect/ai";
 * import * as FetchHttpClient from "effect/http/FetchHttpClient";
 *
 * const model = OpenAI.LanguageModel({ model: "gpt-5-mini" }).pipe(
 *   Layer.provide(Layer.mergeAll(OpenAI.CredentialsFromEnv, FetchHttpClient.layer)),
 * );
 *
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
 * ### Structured Output
 * **Example:** Decode the reply with a Schema
 * ```typescript
 * const { value } = yield* LanguageModel.generateObject({
 *   prompt: "Return a greeting.",
 *   schema: Schema.Struct({ greeting: Schema.String }),
 * }).pipe(Effect.provide(model));
 * ```
 *
 * ### Tool Calling
 * **Example:** Call tools from a Toolkit
 * ```typescript
 * import { Tool, Toolkit } from "effect/ai";
 *
 * const GetWeather = Tool.make("get_weather", {
 *   description: "Get the current weather for a city.",
 *   parameters: Schema.Struct({ city: Schema.String }),
 *   success: Schema.Struct({ temperatureF: Schema.Number }),
 * });
 * const Weather = Toolkit.make(GetWeather);
 *
 * const reply = yield* LanguageModel.generateText({
 *   prompt: "What's the weather in Seattle?",
 *   toolkit: Weather,
 * }).pipe(
 *   Effect.provide(
 *     Weather.toLayer({ get_weather: () => Effect.succeed({ temperatureF: 72 }) }),
 *   ),
 *   Effect.provide(model),
 * );
 * ```
 *
 * ### Using a Service Account Key
 * **Example:** Credentials from a deployed service account
 * ```typescript
 * const model = OpenAI.LanguageModel({
 *   model: "gpt-5-mini",
 *   parameters: { reasoningEffort: "low" },
 * }).pipe(
 *   Layer.provide(OpenAI.fromApiKey(apiKey)),
 *   Layer.provide(FetchHttpClient.layer),
 * );
 * ```
 *
 * @layer
 * @provides effect/ai/LanguageModel
 * @product OpenAI
 * @category AI
 */
export const LanguageModel = (
  options: LanguageModelOptions,
): Layer.Layer<AiLanguageModel.LanguageModel, never, Credentials | HttpClient.HttpClient> =>
  Layer.effect(AiLanguageModel.LanguageModel, makeLanguageModel(options));

/**
 * Build an `effect/ai` `LanguageModel` over the Responses API. The OpenAI
 * `Credentials` and `HttpClient` are resolved once and closed over.
 */
export const makeLanguageModel = ({
  model,
  parameters,
}: LanguageModelOptions): Effect.Effect<
  AiLanguageModel.LanguageModel,
  never,
  Credentials | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const create = yield* OpenAI.responses.createResponse;
    const createStream = yield* OpenAI.responses.createResponseStream;
    return yield* AiLanguageModel.make({
      codecTransformer: toCodecOpenAI,
      generateText: (options) =>
        Effect.gen(function* () {
          const request = yield* requestBody(options, model, parameters, "generateText");
          const response = yield* create(request).pipe(
            Effect.mapError((cause) => toAiError(cause, "generateText")),
          );
          return yield* responseParts(response, "generateText");
        }),
      streamText: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const request = yield* requestBody(options, model, parameters, "streamText");
            return eventStream(
              createStream(request).pipe(
                Stream.mapError((cause) => toAiError(cause, "streamText")),
              ),
            );
          }),
        ),
    });
  });

// ---------------------------------------------------------------------------
// Errors — mapped from distilled's typed error union, never by status/shape.
// ---------------------------------------------------------------------------

type Method = "generateText" | "streamText";

const aiError = (method: Method, reason: AiError.AiError["reason"]) =>
  AiError.make({ module: "OpenAI.LanguageModel", method, reason });

const invalidRequest = (method: Method, description: string) =>
  aiError(method, new AiError.InvalidRequestError({ description }));

const invalidOutput = (method: Method, description: string) =>
  aiError(method, new AiError.InvalidOutputError({ description }));

/** Translate a typed OpenAI SDK failure into an `AiError`. */
export const toAiError = (error: CreateResponseError, method: Method): AiError.AiError => {
  const description = "message" in error && typeof error.message === "string" ? error.message : "";
  switch (error._tag) {
    case "InsufficientQuota":
      return aiError(method, new AiError.QuotaExhaustedError({}));
    case "RateLimitExceeded":
    case "TooManyRequests":
      return aiError(method, new AiError.RateLimitError({}));
    case "InvalidApiKey":
    case "Unauthorized":
      return aiError(method, new AiError.AuthenticationError({ kind: "InvalidKey" }));
    case "MissingCredentials":
      return aiError(method, new AiError.AuthenticationError({ kind: "MissingKey" }));
    case "Forbidden":
      return aiError(method, new AiError.AuthenticationError({ kind: "InsufficientPermissions" }));
    case "ModelNotFound":
    case "NotFound":
    case "BadRequest":
    case "UnprocessableEntity":
    case "Conflict":
    case "Locked":
      return aiError(method, new AiError.InvalidRequestError({ description }));
    case "ContextLengthExceeded":
      return aiError(
        method,
        new AiError.InvalidRequestError({
          parameter: "input",
          constraint: "context_length",
          description,
        }),
      );
    case "InternalServerError":
    case "BadGateway":
    case "ServiceUnavailable":
    case "GatewayTimeout":
      return aiError(method, new AiError.InternalProviderError({ description }));
    case "OpenAIParseError":
      return aiError(
        method,
        new AiError.InvalidOutputError({ description: "Invalid Responses API payload" }),
      );
    case "HttpClientError":
      return aiError(
        method,
        new AiError.NetworkError({
          reason: "TransportError",
          request: { method: "POST", url: "/v1/responses", urlParams: [], headers: {} },
          description: "OpenAI transport failed",
        }),
      );
    default:
      return aiError(
        method,
        new AiError.UnknownError({
          description: `${error._tag}${description ? `: ${description}` : ""}`,
        }),
      );
  }
};

// ---------------------------------------------------------------------------
// Prompt → Responses API request
// ---------------------------------------------------------------------------

const stringify = (method: Method, value: unknown) =>
  Effect.try({
    try: () => JSON.stringify(value) ?? "null",
    catch: () => invalidRequest(method, "Prompt contains a non-JSON value"),
  });

const toDataUrl = (data: string | Uint8Array | URL, mediaType: string) =>
  Effect.sync(() => {
    if (data instanceof URL) return data.toString();
    if (data instanceof Uint8Array) {
      let binary = "";
      for (const byte of data) binary += String.fromCharCode(byte);
      return `data:${mediaType};base64,${btoa(binary)}`;
    }
    return /^(data:|https?:)/.test(data) ? data : `data:${mediaType};base64,${data}`;
  });

const userContent = (parts: Prompt.UserMessage["content"], method: Method) =>
  Effect.gen(function* () {
    const content: Array<InputContent> = [];
    for (const part of parts) {
      if (part.type === "text") {
        content.push({ type: "input_text", text: part.text });
      } else if (part.mediaType.startsWith("image/")) {
        content.push({
          type: "input_image",
          image_url: yield* toDataUrl(part.data, part.mediaType),
          detail: "auto",
        });
      } else if (part.mediaType === "application/pdf") {
        const url = yield* toDataUrl(part.data, part.mediaType);
        content.push(
          url.startsWith("data:")
            ? { type: "input_file", filename: part.fileName ?? "file.pdf", file_data: url }
            : { type: "input_file", file_url: url },
        );
      } else {
        return yield* invalidRequest(
          method,
          `Unsupported file input media type: ${part.mediaType}`,
        );
      }
    }
    return content;
  });

const promptInput = (prompt: Prompt.Prompt, method: Method) =>
  Effect.gen(function* () {
    const input: Array<InputItem> = [];
    for (const message of prompt.content) {
      switch (message.role) {
        case "system":
          input.push({ role: "system", content: message.content });
          break;
        case "user":
          input.push({ role: "user", content: yield* userContent(message.content, method) });
          break;
        case "assistant":
          for (const part of message.content) {
            if (part.type === "text") {
              if (part.text) input.push({ role: "assistant", content: part.text });
            } else if (part.type === "tool-call") {
              input.push({
                type: "function_call",
                call_id: part.id,
                name: part.name,
                arguments: yield* stringify(method, part.params),
              });
            }
            // Reasoning is not replayed: requests are stateless (store: false).
          }
          break;
        case "tool":
          for (const part of message.content) {
            if (part.type !== "tool-result") continue;
            input.push({
              type: "function_call_output",
              call_id: part.id,
              output:
                typeof part.result === "string"
                  ? part.result
                  : yield* stringify(method, part.result),
            });
          }
          break;
      }
    }
    return input;
  });

const toolChoiceParam = (
  choice: AiLanguageModel.ProviderOptions["toolChoice"],
): ToolChoiceParam => {
  if (typeof choice === "string") return choice;
  if ("tool" in choice) return { type: "function", name: choice.tool };
  return {
    type: "allowed_tools",
    mode: choice.mode ?? "auto",
    tools: choice.oneOf.map((name) => ({ type: "function", name })),
  };
};

const requestBody = (
  options: AiLanguageModel.ProviderOptions,
  model: string,
  parameters: LanguageModelParameters | undefined,
  method: Method,
) =>
  Effect.gen(function* () {
    if (options.tools.some(Tool.isProviderDefined)) {
      return yield* invalidRequest(method, "Provider-defined tools are not supported");
    }
    const input = yield* promptInput(options.prompt, method);
    const tools = yield* Effect.try({
      try: () =>
        options.tools.map((tool): FunctionTool => ({
          type: "function",
          name: tool.name,
          description: Tool.getDescription(tool) ?? null,
          parameters: Tool.getJsonSchema(tool) as FunctionTool["parameters"],
          strict: false,
        })),
      catch: () => invalidRequest(method, "Tool schema cannot be represented as JSON Schema"),
    });
    const format = options.responseFormat;
    const schema =
      format.type === "json"
        ? yield* Effect.try({
            try: () => toCodecOpenAI(format.schema).jsonSchema,
            catch: () =>
              aiError(
                method,
                new AiError.UnsupportedSchemaError({
                  description: "Schema is not supported by OpenAI structured output",
                }),
              ),
          })
        : undefined;
    const request: CreateResponseRequest = {
      model,
      input,
      store: false,
      ...(tools.length > 0 ? { tools, tool_choice: toolChoiceParam(options.toolChoice) } : {}),
      ...(format.type === "json" && schema !== undefined
        ? {
            text: {
              format: {
                type: "json_schema",
                name: format.objectName,
                schema: schema as Record<string, unknown>,
                strict: true,
              },
            },
          }
        : {}),
      ...(parameters?.temperature !== undefined ? { temperature: parameters.temperature } : {}),
      ...(parameters?.topP !== undefined ? { top_p: parameters.topP } : {}),
      ...(parameters?.maxOutputTokens !== undefined
        ? { max_output_tokens: parameters.maxOutputTokens }
        : {}),
      ...(parameters?.reasoningEffort !== undefined
        ? { reasoning: { effort: parameters.reasoningEffort, summary: "auto" } }
        : {}),
      ...(parameters?.parallelToolCalls !== undefined
        ? { parallel_tool_calls: parameters.parallelToolCalls }
        : {}),
      ...(parameters?.serviceTier !== undefined ? { service_tier: parameters.serviceTier } : {}),
    };
    return request;
  });

// ---------------------------------------------------------------------------
// Responses API output → effect/ai parts
// ---------------------------------------------------------------------------

/** The response fields the part mapping reads (shared by sync + stream shapes). */
interface ResponseShape {
  readonly status?: string | null | undefined;
  readonly output: ReadonlyArray<OutputItem>;
  readonly usage?: ResponseUsage | null | undefined;
  readonly incomplete_details: { readonly reason?: string | undefined } | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

const parseArguments = (method: Method, value: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(
    value || "{}",
  ).pipe(Effect.mapError(() => invalidOutput(method, "Invalid function-call JSON arguments")));

const usageOf = (usage: ResponseUsage | null | undefined) => {
  const input = usage?.input_tokens;
  const cached = usage?.input_tokens_details?.cached_tokens;
  const output = usage?.output_tokens;
  const reasoning = usage?.output_tokens_details?.reasoning_tokens;
  return new Response.Usage({
    inputTokens: {
      total: input,
      uncached: input === undefined ? undefined : Math.max(0, input - (cached ?? 0)),
      cacheRead: cached,
      cacheWrite: usage?.input_tokens_details?.cache_write_tokens,
    },
    outputTokens: {
      total: output,
      text: output === undefined ? undefined : Math.max(0, output - (reasoning ?? 0)),
      reasoning,
    },
  });
};

const finishReasonOf = (response: ResponseShape, hasToolCalls: boolean): Response.FinishReason => {
  if (response.status === "incomplete") {
    switch (response.incomplete_details?.reason) {
      case "max_output_tokens":
        return "length";
      case "content_filter":
        return "content-filter";
      default:
        return "other";
    }
  }
  if (response.status === "failed") return "error";
  return hasToolCalls ? "tool-calls" : "stop";
};

/**
 * Map an in-band failure (an SSE `error` event or a `failed` response) to an
 * AiError reason. These arrive on an HTTP 200, so the SDK's status-matched
 * typed errors never see them — the OpenAI error `type`/`code` is all we get.
 */
const inBandError = (
  method: Method,
  failure: {
    readonly type?: string | null;
    readonly code?: string | null;
    readonly message?: string;
  },
) => {
  const description = `${failure.code ?? failure.type ?? "error"}: ${failure.message ?? "OpenAI response failed"}`;
  if (
    failure.type === "insufficient_quota" ||
    failure.code === "insufficient_quota" ||
    failure.code === "credit_balance_exhausted"
  ) {
    return aiError(method, new AiError.QuotaExhaustedError({}));
  }
  if (failure.code === "rate_limit_exceeded") {
    return aiError(method, new AiError.RateLimitError({}));
  }
  return aiError(method, new AiError.InternalProviderError({ description }));
};

const failedResponse = (method: Method, response: ResponseShape) =>
  inBandError(method, response.error ?? {});

/**
 * The SSE `error` event. On the wire its payload is nested
 * (`{ type: "error", error: { type, code, message } }`) while distilled's
 * `ResponseErrorEvent` declares flat `code`/`message`; accept both until the
 * SDK schema is patched.
 */
const StreamErrorEvent = Schema.Struct({
  code: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Schema.NullOr(Schema.String)),
      code: Schema.optional(Schema.NullOr(Schema.String)),
      message: Schema.optional(Schema.String),
    }),
  ),
});

const streamError = (method: Method, event: unknown) =>
  Schema.decodeUnknownEffect(StreamErrorEvent)(event).pipe(
    Effect.mapError(() => invalidOutput(method, "Invalid Responses stream error event")),
    Effect.flatMap((decoded) =>
      Effect.fail(
        inBandError(method, decoded.error ?? { code: decoded.code, message: decoded.message }),
      ),
    ),
  );

const responseParts = (response: ResponseShape, method: Method) =>
  Effect.gen(function* () {
    if (response.status === "failed") return yield* failedResponse(method, response);
    const parts: Array<Response.PartEncoded> = [];
    let hasToolCalls = false;
    for (const item of response.output) {
      if (item.type === "message") {
        for (const content of item.content) {
          if (content.type === "refusal") {
            return yield* aiError(
              method,
              new AiError.ContentPolicyError({ description: content.refusal }),
            );
          }
          if (content.type === "output_text" && content.text) {
            parts.push({ type: "text", text: content.text });
          }
        }
      } else if (item.type === "reasoning") {
        for (const summary of item.summary) {
          if (summary.text) parts.push({ type: "reasoning", text: summary.text });
        }
      } else if (item.type === "function_call") {
        hasToolCalls = true;
        parts.push({
          type: "tool-call",
          id: item.call_id,
          name: item.name,
          params: yield* parseArguments(method, item.arguments),
        });
      }
    }
    parts.push({
      type: "finish",
      reason: finishReasonOf(response, hasToolCalls),
      usage: usageOf(response.usage),
    });
    return parts;
  });

/**
 * Fold Responses API server-sent events into effect/ai stream parts. Text and
 * reasoning blocks open on their first delta and close when their output item
 * is done; function calls stream their arguments and emit a `tool-call` when
 * the item completes. The terminal `response.completed` / `.incomplete` event
 * supplies the finish reason and usage.
 */
const eventStream = (
  events: Stream.Stream<StreamEvent, AiError.AiError>,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> =>
  Stream.unwrap(
    Effect.sync(() => {
      const method: Method = "streamText";
      const openText = new Set<string>();
      const openReasoning = new Map<string, Set<string>>();
      const calls = new Map<string, string>(); // item_id → call_id
      let hasToolCalls = false;
      let terminal: ResponseShape | undefined;

      const parts = events.pipe(
        Stream.mapEffect((event) =>
          Effect.gen(function* () {
            const out: Array<Response.StreamPartEncoded> = [];
            switch (event.type) {
              case "response.output_item.added": {
                const item = event.item;
                if (item.type === "function_call" && item.id !== undefined) {
                  calls.set(item.id, item.call_id);
                  out.push({ type: "tool-params-start", id: item.call_id, name: item.name });
                }
                break;
              }
              case "response.output_text.delta": {
                if (!openText.has(event.item_id)) {
                  openText.add(event.item_id);
                  out.push({ type: "text-start", id: event.item_id });
                }
                out.push({ type: "text-delta", id: event.item_id, delta: event.delta });
                break;
              }
              case "response.reasoning_summary_text.delta": {
                const id = `${event.item_id}:${event.summary_index}`;
                const open = openReasoning.get(event.item_id) ?? new Set<string>();
                if (!open.has(id)) {
                  open.add(id);
                  openReasoning.set(event.item_id, open);
                  out.push({ type: "reasoning-start", id });
                }
                out.push({ type: "reasoning-delta", id, delta: event.delta });
                break;
              }
              case "response.function_call_arguments.delta": {
                const callId = calls.get(event.item_id);
                if (callId !== undefined && event.delta) {
                  out.push({ type: "tool-params-delta", id: callId, delta: event.delta });
                }
                break;
              }
              case "response.output_item.done": {
                const item = event.item;
                if (item.type === "message" && openText.delete(item.id)) {
                  out.push({ type: "text-end", id: item.id });
                } else if (item.type === "reasoning") {
                  for (const id of openReasoning.get(item.id) ?? []) {
                    out.push({ type: "reasoning-end", id });
                  }
                  openReasoning.delete(item.id);
                } else if (item.type === "function_call") {
                  hasToolCalls = true;
                  if (item.id === undefined || !calls.has(item.id)) {
                    out.push({ type: "tool-params-start", id: item.call_id, name: item.name });
                  }
                  out.push({ type: "tool-params-end", id: item.call_id });
                  out.push({
                    type: "tool-call",
                    id: item.call_id,
                    name: item.name,
                    params: yield* parseArguments(method, item.arguments),
                  });
                }
                break;
              }
              case "response.refusal.delta":
                return yield* aiError(
                  method,
                  new AiError.ContentPolicyError({ description: "Model refused the request" }),
                );
              case "response.completed":
              case "response.incomplete":
                terminal = event.response;
                break;
              case "response.failed":
                return yield* failedResponse(method, event.response);
              case "error":
                return yield* streamError(method, event);
            }
            return out;
          }),
        ),
        Stream.flatMap(Stream.fromIterable),
      );

      const finish = Stream.unwrap(
        Effect.gen(function* () {
          if (terminal === undefined) {
            return yield* invalidOutput(method, "Responses stream ended before completion");
          }
          const out: Array<Response.StreamPartEncoded> = [];
          for (const id of openText) out.push({ type: "text-end", id });
          for (const ids of openReasoning.values()) {
            for (const id of ids) out.push({ type: "reasoning-end", id });
          }
          out.push({
            type: "finish",
            reason: finishReasonOf(terminal, hasToolCalls),
            usage: usageOf(terminal.usage),
          });
          return Stream.fromIterable(out);
        }),
      );

      return Stream.concat(parts, finish);
    }),
  );
