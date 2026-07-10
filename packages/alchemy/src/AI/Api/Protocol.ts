/**
 * The AI SDK v5 **UI Message Stream protocol** (designs/ai/serving.md):
 * the wire format `useChat` + `DefaultChatTransport` speak — SSE frames
 * of typed JSON chunks, `x-vercel-ai-ui-message-stream: v1`, terminated
 * by `data: [DONE]`. Speaking it verbatim is what makes the existing
 * frontend ecosystem (AI SDK UI, and by extension Cloudflare's
 * `useAgentChat` wrapper) plug into alchemy agents with zero client
 * code.
 *
 * This module is the protocol boundary: effect Schemas for the chunk
 * subset the kernel emits, the inbound chat-request shape, and the SSE
 * framing helpers. Golden tests pin every encoded frame byte-for-byte
 * against the documented examples — a drift here breaks strangers'
 * UIs, not just ours.
 *
 * Reference: https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 */
import * as S from "effect/Schema";

// ─── outbound: UIMessageChunk (the SSE stream) ───────────────────

/** Message lifecycle. */
export const StartChunk = S.Struct({
  type: S.tag("start"),
  messageId: S.optionalKey(S.String),
});
export const FinishChunk = S.Struct({ type: S.tag("finish") });
export const AbortChunk = S.Struct({
  type: S.tag("abort"),
  reason: S.optionalKey(S.String),
});

/**
 * Step boundaries — one step per model round. Required for UIs to
 * correctly stitch multi-round tool turns into one assistant message.
 */
export const StartStepChunk = S.Struct({ type: S.tag("start-step") });
export const FinishStepChunk = S.Struct({ type: S.tag("finish-step") });

/** Text blocks: start → deltas → end, keyed by block id. */
export const TextStartChunk = S.Struct({
  type: S.tag("text-start"),
  id: S.String,
});
export const TextDeltaChunk = S.Struct({
  type: S.tag("text-delta"),
  id: S.String,
  delta: S.String,
});
export const TextEndChunk = S.Struct({
  type: S.tag("text-end"),
  id: S.String,
});

/** Reasoning blocks: start → deltas → end, keyed by block id. */
export const ReasoningStartChunk = S.Struct({
  type: S.tag("reasoning-start"),
  id: S.String,
});
export const ReasoningDeltaChunk = S.Struct({
  type: S.tag("reasoning-delta"),
  id: S.String,
  delta: S.String,
});
export const ReasoningEndChunk = S.Struct({
  type: S.tag("reasoning-end"),
  id: S.String,
});

/** Tool calls: input announced, then settled output (or error). */
export const ToolInputStartChunk = S.Struct({
  type: S.tag("tool-input-start"),
  toolCallId: S.String,
  toolName: S.String,
});
export const ToolInputAvailableChunk = S.Struct({
  type: S.tag("tool-input-available"),
  toolCallId: S.String,
  toolName: S.String,
  input: S.Unknown,
});
export const ToolOutputAvailableChunk = S.Struct({
  type: S.tag("tool-output-available"),
  toolCallId: S.String,
  output: S.Unknown,
});
export const ToolOutputErrorChunk = S.Struct({
  type: S.tag("tool-output-error"),
  toolCallId: S.String,
  errorText: S.String,
});

/**
 * The Ask protocol surfaces as a custom data part (`data-ask`): the
 * asking tool call is genuinely mid-execution (parked), which is a
 * different state machine than the AI SDK's native pre-execution
 * `tool-approval-request` — mapping onto that would lie to the UI.
 * Clients render approve/deny for `data-ask` parts and answer via
 * `POST /api/asks/:id`. Reconciliation by stable `id` (same id ⇒
 * update in place: pending → answered).
 */
/**
 * An authored message posted by a deterministic process's `ctx.post`
 * (reassess §C/§E) — a `message.posted` Trace row. Rendered as an
 * authored bubble, the code analogue of a prose coordinator's
 * `post_reply` tool. Reconciled by stable `id`.
 */
export const DataMessageChunk = S.Struct({
  type: S.tag("data-message"),
  id: S.String,
  data: S.Struct({ author: S.String, text: S.String }),
});

/** A deterministic coordinator's child-agent lifecycle (clickable pill). */
export const DataRunChunk = S.Struct({
  type: S.tag("data-run"),
  id: S.String,
  data: S.Struct({
    runId: S.String,
    agent: S.String,
    status: S.Literals(["running", "completed", "failed"]),
    error: S.optionalKey(S.String),
  }),
});

/** A deterministic process handler's final resolution. */
export const DataResolutionChunk = S.Struct({
  type: S.tag("data-resolution"),
  id: S.String,
  data: S.Struct({ summary: S.String }),
});

export const DataAskChunk = S.Struct({
  type: S.tag("data-ask"),
  id: S.String,
  data: S.Struct({
    askId: S.String,
    status: S.Literals(["pending", "answered"]),
    payload: S.Unknown,
    verdict: S.optionalKey(S.String),
  }),
});

export const ErrorChunk = S.Struct({
  type: S.tag("error"),
  errorText: S.String,
});

export const UIMessageChunk = S.Union([
  StartChunk,
  FinishChunk,
  AbortChunk,
  StartStepChunk,
  FinishStepChunk,
  TextStartChunk,
  TextDeltaChunk,
  TextEndChunk,
  ReasoningStartChunk,
  ReasoningDeltaChunk,
  ReasoningEndChunk,
  ToolInputStartChunk,
  ToolInputAvailableChunk,
  ToolOutputAvailableChunk,
  ToolOutputErrorChunk,
  DataMessageChunk,
  DataRunChunk,
  DataResolutionChunk,
  DataAskChunk,
  ErrorChunk,
]);
export type UIMessageChunk = typeof UIMessageChunk.Type;

// ─── inbound: UIMessage + the useChat request body ───────────────

/**
 * The part subset we read from inbound messages. Unknown part types
 * must not reject a request (clients send tool/data parts back in
 * their transcripts), so parts decode leniently and the server folds
 * what it understands.
 */
export const UIMessagePart = S.StructWithRest(S.Struct({ type: S.String }), [
  S.Record(S.String, S.Unknown),
]);
export type UIMessagePart = typeof UIMessagePart.Type;

export const UIMessage = S.Struct({
  id: S.String,
  role: S.Literals(["system", "user", "assistant"]),
  parts: S.Array(UIMessagePart),
  metadata: S.optionalKey(S.Unknown),
});
export type UIMessage = typeof UIMessage.Type;

/** `DefaultChatTransport`'s POST body. */
export const ChatRequest = S.Struct({
  /** The conversation id (useChat's chat id). */
  id: S.optionalKey(S.String),
  messages: S.Array(UIMessage),
  trigger: S.optionalKey(S.String),
  messageId: S.optionalKey(S.String),
});
export type ChatRequest = typeof ChatRequest.Type;

/**
 * Project a UI message into conversational memory.
 *
 * Authored `data-message` parts are semantic assistant speech (a
 * deterministic coordinator's `ctx.post`), not UI-only decoration.
 * Omitting them made the next thread turn forget every agent response
 * even though the bubbles were visible in the transcript.
 */
export const messageText = (message: UIMessage): string =>
  message.parts
    .flatMap((part) => {
      if (part.type === "text") {
        return [String((part as { text?: unknown }).text ?? "")];
      }
      if (part.type === "data-message") {
        const data = (
          part as {
            data?: { author?: unknown; text?: unknown };
          }
        ).data;
        return [
          `${String(data?.author ?? "Agent")}: ${String(data?.text ?? "")}`,
        ];
      }
      // legacy prose coordinator: post_reply is a semantic member reply
      if (part.type === "dynamic-tool") {
        const tool = part as {
          toolName?: string;
          input?: { author?: unknown; text?: unknown };
        };
        if (tool.toolName === "post_reply") {
          return [
            `${String(tool.input?.author ?? "Agent")}: ${String(tool.input?.text ?? "")}`,
          ];
        }
      }
      return [];
    })
    .filter((text) => text.length > 0)
    .join("\n");

// ─── SSE framing ─────────────────────────────────────────────────

/** The header that tells `DefaultChatTransport` this is a v1 stream. */
export const STREAM_HEADER = "x-vercel-ai-ui-message-stream";
export const STREAM_HEADER_VALUE = "v1";

export const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  [STREAM_HEADER]: STREAM_HEADER_VALUE,
} as const;

const encodeChunk = S.encodeUnknownSync(UIMessageChunk);

/** One SSE frame: `data: {json}\n\n`. */
export const sseFrame = (chunk: UIMessageChunk): string =>
  `data: ${JSON.stringify(encodeChunk(chunk))}\n\n`;

/** The protocol's stream terminator. */
export const SSE_DONE = "data: [DONE]\n\n";
