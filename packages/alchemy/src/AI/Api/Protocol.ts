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
  ToolInputStartChunk,
  ToolInputAvailableChunk,
  ToolOutputAvailableChunk,
  ToolOutputErrorChunk,
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

/** Extract the concatenated text of a message's text parts. */
export const messageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => String((part as { text?: unknown }).text ?? ""))
    .join("");

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
