import * as Anthropic from "@distilled.cloud/anthropic";
import type { Credentials } from "@distilled.cloud/anthropic/Credentials";
import { AiError, LanguageModel as AiLanguageModel, Prompt, Response, Tool } from "effect/ai";
import { toCodecAnthropic } from "effect/ai/AnthropicStructuredOutput";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/**
 * Generation settings applied to every request made through an
 * {@link LanguageModel} layer. They map onto the Messages API body.
 */
export interface LanguageModelParameters {
  /**
   * Maximum number of tokens to generate. The Messages API requires it.
   * @default 4096
   */
  maxTokens?: number;
  /** Sampling temperature (0–1). Lower values are more deterministic. */
  temperature?: number;
  /** Nucleus-sampling probability mass. */
  topP?: number;
  /** Only sample from the top K options for each token. */
  topK?: number;
  /** Custom sequences that stop generation when emitted. */
  stopSequences?: string[];
  /**
   * Enable extended thinking with a token budget (must be below
   * `maxTokens`). Thinking is surfaced as `reasoning` parts; its signature
   * is preserved in part metadata so multi-turn tool use round-trips.
   */
  thinking?: { budgetTokens: number };
}

/** Options for {@link LanguageModel}. */
export interface LanguageModelOptions {
  /** Claude model id, e.g. `claude-haiku-4-5-20251001` or `claude-opus-4-1`. */
  model: string;
  /** Generation settings applied to every request. */
  parameters?: LanguageModelParameters;
}

/**
 * An `effect/ai` `LanguageModel` backed by Anthropic's Messages API, so any
 * Effect AI program — `LanguageModel.generateText`, `streamText`,
 * `generateObject`, `Chat`, toolkits — runs against Claude.
 *
 * Supports text and image/PDF/plain-text document inputs, system prompts,
 * function tools (with `toolChoice`), structured output via JSON Schema,
 * extended thinking, and token-level streaming via server-sent events.
 * Anthropic server tools (web search, code execution, …) are not exposed
 * through this adapter.
 *
 * The layer needs Anthropic `Credentials` (an inference API key) and an
 * `HttpClient`. Inside an Alchemy stack the provider credentials come from
 * `Anthropic.providers()`; inside a Worker or Function provide
 * `Anthropic.fromApiKey(key)` (or `Anthropic.CredentialsFromEnv`) and
 * `FetchHttpClient.layer`.
 *
 * ### Generate Text
 * **Example:** One-shot generation
 * ```typescript
 * import { LanguageModel } from "effect/ai";
 * import * as FetchHttpClient from "effect/http/FetchHttpClient";
 *
 * const Claude = Anthropic.LanguageModel({
 *   model: "claude-haiku-4-5-20251001",
 *   parameters: { maxTokens: 1024 },
 * }).pipe(
 *   Layer.provide(Anthropic.CredentialsFromEnv),
 *   Layer.provide(FetchHttpClient.layer),
 * );
 *
 * const response = yield* LanguageModel.generateText({
 *   prompt: "Say hello.",
 * }).pipe(Effect.provide(Claude));
 * console.log(response.text);
 * ```
 *
 * ### Stream Text
 * **Example:** Stream deltas as they arrive
 * ```typescript
 * yield* LanguageModel.streamText({ prompt: "Write a haiku." }).pipe(
 *   Stream.runForEach((part) =>
 *     part.type === "text-delta" ? Console.log(part.delta) : Effect.void,
 *   ),
 *   Effect.provide(Claude),
 * );
 * ```
 *
 * ### Tool Calling
 * **Example:** Call tools with a Toolkit
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
 * const response = yield* LanguageModel.generateText({
 *   prompt: "What's the weather in Seattle?",
 *   toolkit: Weather,
 * }).pipe(
 *   Effect.provide(Weather.toLayer({
 *     get_weather: () => Effect.succeed({ temperatureF: 72 }),
 *   })),
 *   Effect.provide(Claude),
 * );
 * ```
 *
 * ### Structured Output
 * **Example:** Decode the response with an Effect Schema
 * ```typescript
 * const { value } = yield* LanguageModel.generateObject({
 *   prompt: "Return a short greeting.",
 *   schema: Schema.Struct({ greeting: Schema.String }),
 * }).pipe(Effect.provide(Claude));
 * ```
 *
 * @layer
 * @provides effect/ai/LanguageModel
 * @product Anthropic
 * @category AI
 */
export const LanguageModel = (
  options: LanguageModelOptions,
): Layer.Layer<AiLanguageModel.LanguageModel, never, Credentials | HttpClient.HttpClient> =>
  Layer.effect(AiLanguageModel.LanguageModel, makeLanguageModel(options));

/**
 * Build an Effect AI `LanguageModel` service over the Messages API. The
 * `Credentials` and `HttpClient` in context at construction are captured
 * and used for every call.
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
    const context = yield* Effect.context<Credentials | HttpClient.HttpClient>();
    return yield* AiLanguageModel.make({
      codecTransformer: toCodecAnthropic,
      generateText: (options) =>
        Effect.gen(function* () {
          const request = yield* toRequest(options, model, parameters);
          const message = yield* Anthropic.createMessage(request).pipe(
            Effect.provideContext(context),
            Effect.mapError((cause) => toAiError(cause, "generateText")),
          );
          return yield* toResponseParts(message);
        }),
      streamText: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const request = yield* toRequest(options, model, parameters);
            return Anthropic.createMessageStream(request).pipe(
              Stream.provideContext(context),
              Stream.mapError((cause) => toAiError(cause, "streamText")),
              Stream.mapAccumEffect(() => initialStreamState, handleStreamEvent, {
                onHalt: finalizeStream,
              }),
            );
          }),
        ),
    });
  });

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const MODULE = "Anthropic.LanguageModel";

const aiError = (method: string, reason: AiError.AiErrorReason) =>
  AiError.make({ module: MODULE, method, reason });

const invalidRequest = (description: string, parameter?: string) =>
  aiError(
    "request",
    new AiError.InvalidRequestError({
      description,
      ...(parameter !== undefined ? { parameter } : {}),
    }),
  );

const invalidOutput = (description: string) =>
  aiError("response", new AiError.InvalidOutputError({ description }));

/** Map the SDK's typed failures onto Effect AI's semantic error reasons. */
const toAiError = (cause: Anthropic.AnthropicOpError, method: string): AiError.AiError => {
  const description =
    "message" in cause && typeof cause.message === "string" ? cause.message : undefined;
  switch (cause._tag) {
    case "InvalidRequest":
    case "RequestTooLarge":
      return aiError(method, new AiError.InvalidRequestError({ description }));
    case "ResourceNotFound":
      // On the Messages API the only addressable resource is the model.
      return aiError(method, new AiError.InvalidRequestError({ parameter: "model", description }));
    case "AuthenticationFailed":
      return aiError(method, new AiError.AuthenticationError({ kind: "InvalidKey", description }));
    case "MissingAnthropicCredentials":
      return aiError(method, new AiError.AuthenticationError({ kind: "MissingKey", description }));
    case "PermissionDenied":
      return aiError(
        method,
        new AiError.AuthenticationError({ kind: "InsufficientPermissions", description }),
      );
    case "PaymentRequired":
      return aiError(method, new AiError.QuotaExhaustedError({}));
    case "RateLimited":
      return aiError(
        method,
        new AiError.RateLimitError(
          cause.retryAfter !== undefined ? { retryAfter: cause.retryAfter } : {},
        ),
      );
    case "Overloaded":
    case "ApiServerError":
    case "RequestTimeout":
      return aiError(
        method,
        new AiError.InternalProviderError({
          description: description ?? `Anthropic returned ${cause._tag}`,
        }),
      );
    default:
      return aiError(
        method,
        new AiError.UnknownError({
          description: [cause._tag, description].filter(Boolean).join(": "),
        }),
      );
  }
};

// ---------------------------------------------------------------------------
// Prompt → Messages API request
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>;
interface MessageParam {
  role: "user" | "assistant";
  content: Block[];
}

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const dataOf = (data: string | Uint8Array): string =>
  typeof data === "string"
    ? data.startsWith("data:")
      ? data.slice(data.indexOf(",") + 1)
      : data
    : base64(data);

const isUrl = (data: string | Uint8Array | URL): data is URL | string =>
  data instanceof URL || (typeof data === "string" && /^https?:\/\//.test(data));

const fileBlock = (part: Prompt.FilePart) =>
  Effect.gen(function* () {
    const { mediaType, data } = part;
    if (mediaType.startsWith("image/")) {
      return {
        type: "image",
        source: isUrl(data)
          ? { type: "url", url: data.toString() }
          : { type: "base64", media_type: mediaType, data: dataOf(data as string | Uint8Array) },
      };
    }
    if (mediaType === "application/pdf") {
      return {
        type: "document",
        ...(part.fileName ? { title: part.fileName } : {}),
        source: isUrl(data)
          ? { type: "url", url: data.toString() }
          : { type: "base64", media_type: mediaType, data: dataOf(data as string | Uint8Array) },
      };
    }
    if (mediaType === "text/plain" && !(data instanceof URL)) {
      return {
        type: "document",
        ...(part.fileName ? { title: part.fileName } : {}),
        source: {
          type: "text",
          media_type: "text/plain",
          data: typeof data === "string" ? data : new TextDecoder().decode(data),
        },
      };
    }
    return yield* invalidRequest(
      `Unsupported file media type '${mediaType}' (supported: image/*, application/pdf, text/plain)`,
    );
  });

const anthropicMeta = (options: unknown): Record<string, unknown> | undefined => {
  const meta = (options as { anthropic?: unknown } | undefined)?.anthropic;
  return meta !== null && typeof meta === "object" ? (meta as Record<string, unknown>) : undefined;
};

const stringify = (value: unknown) =>
  Effect.try({
    try: () => JSON.stringify(value) ?? "null",
    catch: () => invalidRequest("Tool result is not JSON serializable"),
  });

const convertPrompt = (prompt: Prompt.Prompt) =>
  Effect.gen(function* () {
    const system: Array<{ type: "text"; text: string }> = [];
    const messages: MessageParam[] = [];
    // The Messages API requires user/assistant alternation and carries tool
    // results inside user turns, so consecutive same-role turns are merged.
    const append = (role: MessageParam["role"], content: Block[]) => {
      if (content.length === 0) return;
      const last = messages[messages.length - 1];
      if (last !== undefined && last.role === role) last.content.push(...content);
      else messages.push({ role, content });
    };

    for (const message of prompt.content) {
      switch (message.role) {
        case "system":
          if (message.content.length > 0) system.push({ type: "text", text: message.content });
          break;
        case "user": {
          const content: Block[] = [];
          for (const part of message.content) {
            if (part.type === "text") {
              if (part.text.length > 0) content.push({ type: "text", text: part.text });
            } else if (part.type === "file") {
              content.push(yield* fileBlock(part));
            }
          }
          append("user", content);
          break;
        }
        case "assistant": {
          const content: Block[] = [];
          for (const part of message.content) {
            if (part.type === "text") {
              if (part.text.length > 0) content.push({ type: "text", text: part.text });
            } else if (part.type === "reasoning") {
              // Thinking blocks can only be replayed with their signature.
              const meta = anthropicMeta(part.options);
              if (typeof meta?.redactedData === "string") {
                content.push({ type: "redacted_thinking", data: meta.redactedData });
              } else if (typeof meta?.signature === "string") {
                content.push({ type: "thinking", thinking: part.text, signature: meta.signature });
              }
            } else if (part.type === "tool-call" && !part.providerExecuted) {
              content.push({
                type: "tool_use",
                id: part.id,
                name: part.name,
                input: part.params ?? {},
              });
            }
          }
          append("assistant", content);
          break;
        }
        case "tool": {
          const content: Block[] = [];
          for (const part of message.content) {
            if (part.type !== "tool-result" || part.providerExecuted) continue;
            content.push({
              type: "tool_result",
              tool_use_id: part.id,
              content:
                typeof part.result === "string" ? part.result : yield* stringify(part.result),
              ...(part.isFailure ? { is_error: true } : {}),
            });
          }
          append("user", content);
          break;
        }
      }
    }
    return { system, messages };
  });

const toTools = (options: AiLanguageModel.ProviderOptions) =>
  Effect.gen(function* () {
    if (options.tools.length === 0) return {};
    if (options.tools.some(Tool.isProviderDefined)) {
      return yield* invalidRequest(
        "Provider-defined tools are not supported by Anthropic.LanguageModel",
      );
    }
    const choice = options.toolChoice;
    const selected =
      typeof choice === "object" && "oneOf" in choice
        ? options.tools.filter((tool) => choice.oneOf.includes(tool.name))
        : options.tools;
    const tools = yield* Effect.try({
      try: () =>
        selected.map((tool) => ({
          name: tool.name,
          description: Tool.getDescription(tool),
          input_schema: Tool.getJsonSchema(tool),
        })),
      catch: () => invalidRequest("Tool parameters cannot be represented as JSON Schema"),
    });
    const tool_choice =
      choice === "none"
        ? { type: "none" }
        : choice === "required"
          ? { type: "any" }
          : typeof choice === "object" && "tool" in choice
            ? { type: "tool", name: choice.tool }
            : typeof choice === "object" && "oneOf" in choice && choice.mode === "required"
              ? { type: "any" }
              : { type: "auto" };
    return { tools, tool_choice };
  });

const toRequest = (
  options: AiLanguageModel.ProviderOptions,
  model: string,
  parameters: LanguageModelParameters | undefined,
) =>
  Effect.gen(function* () {
    const { system, messages } = yield* convertPrompt(options.prompt);
    const tools = yield* toTools(options);
    const format = options.responseFormat;
    const schema =
      format.type === "json"
        ? yield* Effect.try({
            try: () => toCodecAnthropic(format.schema as any).jsonSchema,
            catch: () =>
              aiError(
                "request",
                new AiError.UnsupportedSchemaError({
                  description: "Schema is not supported by Anthropic structured output",
                }),
              ),
          })
        : undefined;
    const request = {
      model,
      max_tokens: parameters?.maxTokens ?? 4096,
      messages,
      ...(system.length > 0 ? { system } : {}),
      ...tools,
      ...(schema !== undefined
        ? { output_config: { format: { type: "json_schema", schema } } }
        : {}),
      ...(parameters?.temperature !== undefined ? { temperature: parameters.temperature } : {}),
      ...(parameters?.topP !== undefined ? { top_p: parameters.topP } : {}),
      ...(parameters?.topK !== undefined ? { top_k: parameters.topK } : {}),
      ...(parameters?.stopSequences !== undefined
        ? { stop_sequences: parameters.stopSequences }
        : {}),
      ...(parameters?.thinking !== undefined
        ? { thinking: { type: "enabled", budget_tokens: parameters.thinking.budgetTokens } }
        : {}),
    };
    // SAFETY: the blocks above are built to the Messages API wire shapes; the
    // generated request type is a wide union of every block variant.
    return request as unknown as Anthropic.CreateMessageRequest;
  });

// ---------------------------------------------------------------------------
// Messages API response → Effect AI parts
// ---------------------------------------------------------------------------

const finishReason = (reason: string | null | undefined): Response.FinishReason => {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool-calls";
    case "refusal":
      return "content-filter";
    case null:
    case undefined:
      return "unknown";
    default:
      return "other";
  }
};

interface UsageCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Anthropic's `input_tokens` excludes cache reads/writes, which are reported separately. */
const toUsage = (usage: UsageCounts) => {
  const uncached = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return new Response.Usage({
    inputTokens: { uncached, total: uncached + cacheRead + cacheWrite, cacheRead, cacheWrite },
    outputTokens: { total: output, text: undefined, reasoning: undefined },
  });
};

type ResponseBlock = { type: string } & Record<string, unknown>;

const toResponseParts = (message: Anthropic.Message) =>
  Effect.gen(function* () {
    const parts: Array<Response.PartEncoded> = [
      { type: "response-metadata", id: message.id, modelId: message.model, timestamp: undefined },
    ];
    for (const raw of message.content as unknown as ResponseBlock[]) {
      switch (raw.type) {
        case "text":
          if (typeof raw.text === "string" && raw.text.length > 0) {
            parts.push({ type: "text", text: raw.text });
          }
          break;
        case "thinking":
          parts.push({
            type: "reasoning",
            text: String(raw.thinking ?? ""),
            metadata: { anthropic: { signature: String(raw.signature ?? "") } },
          });
          break;
        case "redacted_thinking":
          parts.push({
            type: "reasoning",
            text: "",
            metadata: { anthropic: { redactedData: String(raw.data ?? "") } },
          });
          break;
        case "tool_use":
          if (typeof raw.id !== "string" || typeof raw.name !== "string") {
            return yield* invalidOutput("tool_use block is missing its id or name");
          }
          parts.push({ type: "tool-call", id: raw.id, name: raw.name, params: raw.input ?? {} });
          break;
        default:
          // Server-tool blocks (web search, code execution, …) are not
          // surfaced by this adapter.
          break;
      }
    }
    parts.push({
      type: "finish",
      reason: finishReason(message.stop_reason),
      usage: toUsage(message.usage),
    });
    return parts;
  });

// ---------------------------------------------------------------------------
// Streaming: message events → Effect AI stream parts
//
// Content blocks are opened by `content_block_start` (by index), advanced by
// `content_block_delta`, and closed by `content_block_stop`. `message_start`
// carries the input usage, `message_delta` the stop reason and final output
// usage. Errors mid-stream fail the SDK stream with the typed classes.
// ---------------------------------------------------------------------------

interface OpenBlock {
  readonly kind: "text" | "reasoning" | "tool";
  readonly id: string;
  readonly name?: string;
  readonly json?: string;
  readonly signature?: string;
  readonly redactedData?: string;
}

interface StreamState {
  readonly blocks: ReadonlyMap<number, OpenBlock>;
  readonly usage: UsageCounts;
  readonly stopReason: string | null | undefined;
  readonly messageId: string | undefined;
}

const initialStreamState: StreamState = {
  blocks: new Map(),
  usage: {},
  stopReason: undefined,
  messageId: undefined,
};

type StreamParts = Array<Response.StreamPartEncoded>;

const withBlock = (
  state: StreamState,
  index: number,
  block: OpenBlock | undefined,
): StreamState => {
  const blocks = new Map(state.blocks);
  if (block === undefined) blocks.delete(index);
  else blocks.set(index, block);
  return { ...state, blocks };
};

const parseToolInput = (json: string) =>
  json.trim().length === 0
    ? Effect.succeed({})
    : Effect.try({
        try: () => JSON.parse(json) as unknown,
        catch: () => invalidOutput("Streamed tool input is not valid JSON"),
      });

const closeBlock = (state: StreamState, index: number, parts: StreamParts) =>
  Effect.gen(function* () {
    const block = state.blocks.get(index);
    if (block === undefined) return state;
    if (block.kind === "text") {
      parts.push({ type: "text-end", id: block.id });
    } else if (block.kind === "reasoning") {
      parts.push({
        type: "reasoning-end",
        id: block.id,
        metadata: {
          anthropic:
            block.redactedData !== undefined
              ? { redactedData: block.redactedData }
              : { signature: block.signature ?? "" },
        },
      });
    } else {
      parts.push({ type: "tool-params-end", id: block.id });
      parts.push({
        type: "tool-call",
        id: block.id,
        name: block.name ?? "",
        params: yield* parseToolInput(block.json ?? ""),
      });
    }
    return withBlock(state, index, undefined);
  });

const handleStreamEvent = (
  state: StreamState,
  event: Anthropic.CreateMessageStreamResponse,
): Effect.Effect<
  readonly [StreamState, ReadonlyArray<Response.StreamPartEncoded>],
  AiError.AiError
> =>
  Effect.gen(function* () {
    const parts: StreamParts = [];
    let s = state;
    const e = event as unknown as { type: string } & Record<string, any>;
    switch (e.type) {
      case "message_start": {
        const message = e.message as Anthropic.Message;
        s = { ...s, messageId: message.id, usage: { ...message.usage } };
        parts.push({
          type: "response-metadata",
          id: message.id,
          modelId: message.model,
          timestamp: undefined,
        });
        break;
      }
      case "content_block_start": {
        const index = e.index as number;
        const block = e.content_block as ResponseBlock;
        const id = `${s.messageId ?? "msg"}-${index}`;
        if (block.type === "text") {
          parts.push({ type: "text-start", id });
          s = withBlock(s, index, { kind: "text", id });
          if (typeof block.text === "string" && block.text.length > 0) {
            parts.push({ type: "text-delta", id, delta: block.text });
          }
        } else if (block.type === "thinking") {
          parts.push({ type: "reasoning-start", id });
          s = withBlock(s, index, { kind: "reasoning", id });
        } else if (block.type === "redacted_thinking") {
          parts.push({ type: "reasoning-start", id });
          s = withBlock(s, index, {
            kind: "reasoning",
            id,
            redactedData: String(block.data ?? ""),
          });
        } else if (block.type === "tool_use") {
          const toolId = String(block.id);
          const name = String(block.name);
          parts.push({ type: "tool-params-start", id: toolId, name });
          s = withBlock(s, index, { kind: "tool", id: toolId, name, json: "" });
        }
        break;
      }
      case "content_block_delta": {
        const index = e.index as number;
        const block = s.blocks.get(index);
        if (block === undefined) break;
        const delta = e.delta as { type: string } & Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          parts.push({ type: "text-delta", id: block.id, delta: delta.text });
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          parts.push({ type: "reasoning-delta", id: block.id, delta: delta.thinking });
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          s = withBlock(s, index, {
            ...block,
            signature: (block.signature ?? "") + delta.signature,
          });
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          if (delta.partial_json.length > 0) {
            parts.push({ type: "tool-params-delta", id: block.id, delta: delta.partial_json });
          }
          s = withBlock(s, index, { ...block, json: (block.json ?? "") + delta.partial_json });
        }
        break;
      }
      case "content_block_stop":
        s = yield* closeBlock(s, e.index as number, parts);
        break;
      case "message_delta": {
        const usage = (e.usage ?? {}) as UsageCounts;
        s = {
          ...s,
          stopReason: (e.delta as { stop_reason?: string | null } | undefined)?.stop_reason,
          usage: {
            input_tokens: usage.input_tokens ?? s.usage.input_tokens,
            output_tokens: usage.output_tokens ?? s.usage.output_tokens,
            cache_read_input_tokens:
              usage.cache_read_input_tokens ?? s.usage.cache_read_input_tokens,
            cache_creation_input_tokens:
              usage.cache_creation_input_tokens ?? s.usage.cache_creation_input_tokens,
          },
        };
        break;
      }
      default:
        // `message_stop` and `ping` carry nothing to emit.
        break;
    }
    return [s, parts] as const;
  });

const finalizeStream = (state: StreamState): ReadonlyArray<Response.StreamPartEncoded> => {
  const parts: StreamParts = [];
  // Close anything a truncated stream left open (tool calls are not
  // emitted: their input JSON may be incomplete).
  for (const block of state.blocks.values()) {
    if (block.kind === "text") parts.push({ type: "text-end", id: block.id });
    else if (block.kind === "reasoning") parts.push({ type: "reasoning-end", id: block.id });
    else parts.push({ type: "tool-params-end", id: block.id });
  }
  parts.push({
    type: "finish",
    reason: finishReason(state.stopReason),
    usage: toUsage(state.usage),
  });
  return parts;
};
