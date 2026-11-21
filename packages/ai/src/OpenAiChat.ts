/**
 * Answers an OpenAI chat-completions request with an Effect AI
 * `LanguageModel`. A coding agent that brings its own model client
 * (OpenCode, nanocode) sends requests in that format; tool calls are
 * returned to the agent, which runs them itself.
 *
 * @internal
 * @module
 */
import {
  Tool as AiTool,
  type LanguageModel,
  type Prompt,
  type Response,
  type Toolkit,
} from "effect/ai";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

interface ChatMessage {
  readonly role: "system" | "developer" | "user" | "assistant" | "tool";
  readonly content?: string | ReadonlyArray<ContentPart> | null;
  readonly tool_calls?: ReadonlyArray<{
    readonly id: string;
    readonly function: { readonly name: string; readonly arguments: string };
  }>;
  readonly tool_call_id?: string;
}

/** The parts of a chat-completions request the harness reads. */
export interface ChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools?: ReadonlyArray<{
    readonly function: {
      readonly name: string;
      readonly description?: string;
      readonly parameters?: object;
    };
  }>;
}

/** One answer, as the bridge turns back into a chat completion. */
export interface ChatReply {
  readonly content: string;
  readonly reasoning?: string;
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    /** The arguments as JSON text. */
    readonly arguments: string;
  }>;
  readonly finishReason: "stop" | "length" | "tool_calls";
  readonly usage: { readonly input: number; readonly output: number };
}

const textOf = (content: ChatMessage["content"]): string =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

const promptOf = (messages: ReadonlyArray<ChatMessage>): Prompt.RawInput => {
  const names = new Map<string, string>();
  const out: Array<Prompt.MessageEncoded> = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "developer":
        out.push({ role: "system", content: textOf(message.content) });
        break;
      case "user":
        out.push({
          role: "user",
          content:
            typeof message.content === "string"
              ? message.content
              : (message.content ?? []).flatMap((part): Array<Prompt.UserMessagePartEncoded> => {
                  if (part.type === "text") return [{ type: "text", text: part.text }];
                  const data = /^data:([^;,]+);base64,(.*)$/.exec(part.image_url.url);
                  return data === null
                    ? []
                    : [{ type: "file", mediaType: data[1]!, data: data[2]! }];
                }),
        });
        break;
      case "assistant": {
        const text = textOf(message.content);
        for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
        out.push({
          role: "assistant",
          content: [
            ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
            ...(message.tool_calls ?? []).map((call) => ({
              type: "tool-call" as const,
              id: call.id,
              name: call.function.name,
              params: parse(call.function.arguments),
            })),
          ],
        });
        break;
      }
      case "tool":
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: message.tool_call_id ?? "",
              name: names.get(message.tool_call_id ?? "") ?? "tool",
              isFailure: false,
              result: textOf(message.content),
            },
          ],
        });
        break;
    }
  }
  return out;
};

/** The tools the agent offers, as an Effect toolkit that is declared but never run. */
const toolkitOf = (
  tools: NonNullable<ChatRequest["tools"]>,
): Toolkit.WithHandler<Record<string, AiTool.Any>> => ({
  tools: Object.fromEntries(
    tools.map((tool) => [
      tool.function.name,
      AiTool.dynamic(tool.function.name, {
        description: tool.function.description ?? tool.function.name,
        parameters: (tool.function.parameters ?? { type: "object", properties: {} }) as never,
      }),
    ]),
  ) as Record<string, AiTool.Any>,
  handle: (() => Effect.die(new Error("The agent runs tool calls itself"))) as never,
});

/** Answer one request. */
export const complete = (
  languageModel: LanguageModel.LanguageModel,
  request: ChatRequest,
): Effect.Effect<ChatReply, unknown> =>
  Effect.suspend(() => {
    let content = "";
    let reasoning = "";
    const toolCalls: Array<ChatReply["toolCalls"][number]> = [];
    let reason: Response.FinishReason | undefined;
    let usage = { input: 0, output: 0 };
    const onPart = (part: Response.StreamPartEncoded) =>
      Effect.suspend(() => {
        switch (part.type) {
          case "text-delta":
            content += part.delta;
            return Effect.void;
          case "reasoning-delta":
            reasoning += part.delta;
            return Effect.void;
          case "tool-call":
            toolCalls.push({
              id: part.id,
              name: part.name,
              arguments: JSON.stringify(part.params ?? {}),
            });
            return Effect.void;
          case "finish": {
            const used = part.usage as Response.Usage;
            reason = part.reason;
            usage = {
              input: used.inputTokens.total ?? used.inputTokens.uncached ?? 0,
              output: used.outputTokens.total ?? 0,
            };
            return Effect.void;
          }
          case "error":
            return Effect.fail(part.error);
          default:
            return Effect.void;
        }
      });
    // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- tool calls are not resolved here, so the toolkit's handlers are never needed
    const stream = languageModel
      .streamText({
        prompt: promptOf(request.messages),
        toolkit: toolkitOf(request.tools ?? []),
        disableToolCallResolution: true,
        toolCallValidation: "deferred",
      })
      .pipe(
        Stream.runForEach((part) => onPart(part as unknown as Response.StreamPartEncoded)),
      ) as Effect.Effect<void, unknown>;
    return Effect.map(stream, (): ChatReply => ({
      content,
      ...(reasoning.length > 0 ? { reasoning } : {}),
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : reason === "length" ? "length" : "stop",
      usage,
    }));
  });

/**
 * A reply as the server-sent events of a streamed chat completion: one
 * chunk with everything the model said, one with why it stopped and what
 * it used, then `[DONE]`.
 */
export const toEventStream = (reply: ChatReply, model: string, id: string): string => {
  const chunk = (choice: object, usage?: object) =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, ...choice }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`;
  return [
    chunk({
      delta: {
        role: "assistant",
        ...(reply.content.length > 0 ? { content: reply.content } : {}),
        ...(reply.reasoning === undefined ? {} : { reasoning_content: reply.reasoning }),
        ...(reply.toolCalls.length > 0
          ? {
              tool_calls: reply.toolCalls.map((call, index) => ({
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      },
      finish_reason: null,
    }),
    chunk(
      { delta: {}, finish_reason: reply.finishReason },
      {
        prompt_tokens: reply.usage.input,
        completion_tokens: reply.usage.output,
        total_tokens: reply.usage.input + reply.usage.output,
      },
    ),
    "data: [DONE]\n\n",
  ].join("");
};
