/**
 * A pi-ai provider backed by an Effect AI `LanguageModel`: Pi's transcript
 * becomes an Effect `Prompt`, the model's stream parts become Pi's
 * assistant-message events. Tool calls are never resolved here; Pi runs
 * them as its own durable tasks.
 *
 * @internal
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Message,
  Model,
  Provider,
  StopReason,
  TextContent,
  ThinkingContent,
  Tool as PiTool,
  ToolCall as PiToolCall,
  TranscriptContext,
  Usage,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { LanguageModel, Tool as AiTool, type Prompt, type Response, type Toolkit } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { messageOf } from "./promise.ts";

export const API = "alchemy-effect-ai";

export interface ModelOptions {
  /** Tokens of context the model accepts. @default 128000 */
  readonly contextWindow?: number;
  /** Most tokens one answer may have. @default 8192 */
  readonly maxTokens?: number;
  /** Whether the model accepts images. @default false */
  readonly images?: boolean;
}

/** Runs the model's Effect where the harness was yielded. */
export type RunModel = <A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal | undefined,
) => Promise<Exit.Exit<A, E>>;

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const usageOf = (usage: Response.Usage): Usage => {
  const input = usage.inputTokens.total ?? usage.inputTokens.uncached ?? 0;
  const output = usage.outputTokens.total ?? 0;
  return {
    ...emptyUsage(),
    input,
    output,
    cacheRead: usage.inputTokens.cacheRead ?? 0,
    cacheWrite: usage.inputTokens.cacheWrite ?? 0,
    ...(usage.outputTokens.reasoning !== undefined
      ? { reasoning: usage.outputTokens.reasoning }
      : {}),
    totalTokens: input + output,
  };
};

const stopOf = (
  reason: Response.FinishReason,
): Extract<StopReason, "stop" | "length" | "toolUse"> =>
  reason === "tool-calls" ? "toolUse" : reason === "length" ? "length" : "stop";

/** Pi's system messages replayed: the prompt text and the tools in effect. */
const systemOf = (messages: ReadonlyArray<Message>) => {
  const text: string[] = [];
  const sections = new Map<string, string>();
  const tools = new Map<string, PiTool>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text).join("");
    if (content.length > 0) text.push(content);
    for (const [name, section] of Object.entries(message.sections ?? {})) {
      if (section === null) sections.delete(name);
      else sections.set(name, section);
    }
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return { prompt: [...text, ...sections.values()].join("\n\n"), tools: [...tools.values()] };
};

const promptOf = (messages: ReadonlyArray<Message>): Prompt.RawInput => {
  const { prompt } = systemOf(messages);
  const out: Array<Prompt.MessageEncoded> = [];
  if (prompt.length > 0) out.push({ role: "system", content: prompt });
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break;
      case "user":
        out.push({
          role: "user",
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) =>
                  part.type === "text"
                    ? { type: "text" as const, text: part.text }
                    : { type: "file" as const, mediaType: part.mimeType, data: part.data },
                ),
        });
        break;
      case "assistant":
        out.push({
          role: "assistant",
          content: message.content.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : part.type === "thinking"
                ? { type: "reasoning" as const, text: part.thinking }
                : {
                    type: "tool-call" as const,
                    id: part.id,
                    name: part.name,
                    params: part.arguments,
                  },
          ),
        });
        break;
      case "toolResult":
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: message.toolCallId,
              name: message.toolName,
              isFailure: message.isError,
              result: message.content
                .map((part) => (part.type === "text" ? part.text : `[image ${part.mimeType}]`))
                .join("\n"),
            },
          ],
        });
        break;
    }
  }
  return out;
};

/** The tools Pi offers, as an Effect toolkit that is declared but never run. */
const toolkitOf = (
  tools: ReadonlyArray<PiTool>,
): Toolkit.WithHandler<Record<string, AiTool.Any>> => ({
  tools: Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      AiTool.dynamic(tool.name, {
        description: tool.description,
        parameters: tool.parameters as never,
      }),
    ]),
  ) as Record<string, AiTool.Any>,
  handle: (() => Effect.die(new Error("Pi runs tool calls itself"))) as never,
});

/**
 * Stream one answer from an Effect `LanguageModel` as Pi's events.
 */
const streamWith =
  (languageModel: LanguageModel.LanguageModel, run: RunModel) =>
  (
    model: Model<string>,
    context: TranscriptContext,
    options?: { readonly signal?: AbortSignal },
  ) => {
    const events = createAssistantMessageEventStream();
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };
    const indexOf = new Map<string, number>();
    const argumentText = new Map<string, string>();
    const push = (event: AssistantMessageEvent) => events.push(event);

    const onPart = (part: Response.StreamPartEncoded) =>
      Effect.sync(() => {
        switch (part.type) {
          case "text-start": {
            indexOf.set(`text:${part.id}`, partial.content.push({ type: "text", text: "" }) - 1);
            push({ type: "text_start", contentIndex: indexOf.get(`text:${part.id}`)!, partial });
            return;
          }
          case "text-delta": {
            const index = indexOf.get(`text:${part.id}`);
            if (index === undefined) return;
            (partial.content[index] as TextContent).text += part.delta;
            push({ type: "text_delta", contentIndex: index, delta: part.delta, partial });
            return;
          }
          case "text-end": {
            const index = indexOf.get(`text:${part.id}`);
            if (index === undefined) return;
            const content = (partial.content[index] as TextContent).text;
            push({ type: "text_end", contentIndex: index, content, partial });
            return;
          }
          case "reasoning-start": {
            indexOf.set(
              `thinking:${part.id}`,
              partial.content.push({ type: "thinking", thinking: "" }) - 1,
            );
            push({
              type: "thinking_start",
              contentIndex: indexOf.get(`thinking:${part.id}`)!,
              partial,
            });
            return;
          }
          case "reasoning-delta": {
            const index = indexOf.get(`thinking:${part.id}`);
            if (index === undefined) return;
            (partial.content[index] as ThinkingContent).thinking += part.delta;
            push({ type: "thinking_delta", contentIndex: index, delta: part.delta, partial });
            return;
          }
          case "reasoning-end": {
            const index = indexOf.get(`thinking:${part.id}`);
            if (index === undefined) return;
            const content = (partial.content[index] as ThinkingContent).thinking;
            push({ type: "thinking_end", contentIndex: index, content, partial });
            return;
          }
          case "tool-params-start": {
            const index =
              partial.content.push({
                type: "toolCall",
                id: part.id,
                name: part.name,
                arguments: {},
              }) - 1;
            indexOf.set(`tool:${part.id}`, index);
            push({ type: "toolcall_start", contentIndex: index, partial });
            return;
          }
          case "tool-params-delta": {
            const index = indexOf.get(`tool:${part.id}`);
            if (index === undefined) return;
            argumentText.set(part.id, (argumentText.get(part.id) ?? "") + part.delta);
            push({ type: "toolcall_delta", contentIndex: index, delta: part.delta, partial });
            return;
          }
          case "tool-call": {
            let index = indexOf.get(`tool:${part.id}`);
            const args =
              part.params !== null && typeof part.params === "object" && !Array.isArray(part.params)
                ? (part.params as PiToolCall["arguments"])
                : {};
            if (index === undefined) {
              index =
                partial.content.push({
                  type: "toolCall",
                  id: part.id,
                  name: part.name,
                  arguments: args,
                }) - 1;
              indexOf.set(`tool:${part.id}`, index);
              push({ type: "toolcall_start", contentIndex: index, partial });
            }
            const call = partial.content[index] as PiToolCall;
            call.arguments = args;
            push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial });
            return;
          }
          case "finish": {
            partial.usage = usageOf(part.usage as Response.Usage);
            partial.stopReason = stopOf(part.reason);
            return;
          }
          case "error": {
            throw part.error;
          }
          default:
            return;
        }
      });

    const { tools } = systemOf(context.messages);
    // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- tool calls are not resolved here, so the toolkit's handlers are never needed
    const request = languageModel
      .streamText({
        prompt: promptOf(context.messages),
        toolkit: toolkitOf(tools),
        disableToolCallResolution: true,
        toolCallValidation: "deferred",
      })
      .pipe(
        Stream.runForEach((part) => onPart(part as unknown as Response.StreamPartEncoded)),
      ) as Effect.Effect<void, unknown>;

    push({ type: "start", partial });
    void run(request, options?.signal).then((exit) => {
      if (Exit.isSuccess(exit)) {
        if (partial.stopReason === "pending") {
          partial.stopReason = partial.content.some((part) => part.type === "toolCall")
            ? "toolUse"
            : "stop";
        }
        push({
          type: "done",
          reason: partial.stopReason as Extract<StopReason, "stop" | "length" | "toolUse">,
          message: partial,
        });
      } else {
        const aborted = options?.signal?.aborted === true;
        const error: AssistantMessage = {
          ...partial,
          stopReason: aborted ? "aborted" : "error",
          errorMessage: messageOf(exit.cause),
        };
        push({ type: "error", reason: aborted ? "aborted" : "error", error });
      }
    });
    return events;
  };

/** A pi-ai provider named `name` with one model, `name`, backed by `languageModel`. */
export const makeProvider = (
  name: string,
  languageModel: LanguageModel.LanguageModel,
  run: RunModel,
  options: ModelOptions = {},
): Provider => {
  const stream = streamWith(languageModel, run);
  return createProvider({
    id: name,
    name,
    auth: {
      apiKey: {
        name: "Effect LanguageModel",
        resolve: async () => ({ auth: {}, source: "alchemy" }),
      },
    },
    models: [
      {
        id: name,
        name,
        api: API,
        provider: name,
        baseUrl: "",
        input: options.images ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: options.contextWindow ?? 128_000,
        maxTokens: options.maxTokens ?? 8192,
      },
    ],
    api: { stream, streamSimple: stream },
  }) as Provider;
};
