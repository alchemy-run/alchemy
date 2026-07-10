/**
 * The pure fold from kernel events to protocol chunks
 * (designs/ai/serving.md): one run's `KernelEvent`s — live firehose or
 * durable trace replay — become the AI SDK UI message stream.
 *
 * Two sources, one fold:
 *
 * - **Live** (`kernel.events` filtered to the session): `model.delta`
 *   rows stream text incrementally — the UI sees tokens as they land.
 * - **Replay** (`kernel.trace` from a cursor): deltas are live-only
 *   (§2.3), so the assistant text is reconstructed from the
 *   `turn.halted` row's `text` payload — the fold synthesizes a
 *   start/delta/end block when the turn completed without streamed
 *   deltas. Reconnects therefore render the full message.
 *
 * The fold is a pure state machine (`foldEvent`), so live and replay
 * paths cannot drift.
 */
import * as Stream from "effect/Stream";
import type { KernelEvent } from "../Kernel.ts";
import type { UIMessage, UIMessageChunk } from "./Protocol.ts";

export interface ChunkFoldState {
  /** `start` emitted? */
  readonly started: boolean;
  /**
   * A step is open. Kernel event order is model.requested →
   * model.completed → tool.* (tools execute AFTER the round returns),
   * while the AI SDK expects tool parts INSIDE their step — so a step
   * closes lazily at the NEXT round boundary (or the halt), never at
   * model.completed.
   */
  readonly stepOpen: boolean;
  /** The open text block's id (the model command that streams it). */
  readonly openTextId: string | undefined;
  /** The open reasoning block's id. Reasoning is live-only (§ replay). */
  readonly openReasoningId: string | undefined;
  /** Whether any text was streamed via deltas this turn. */
  readonly sawDeltas: boolean;
  /** Pending ask payloads by askId — merged into the answered update. */
  readonly asks: ReadonlyMap<string, unknown>;
}

export const initialChunkFoldState: ChunkFoldState = {
  started: false,
  stepOpen: false,
  openTextId: undefined,
  openReasoningId: undefined,
  sawDeltas: false,
  asks: new Map(),
};

const payloadOf = (event: KernelEvent): Record<string, unknown> =>
  (event.payload ?? {}) as Record<string, unknown>;

/** One event in, zero-or-more chunks out — the whole protocol mapping. */
export const foldEvent = (
  state: ChunkFoldState,
  event: KernelEvent,
): readonly [ChunkFoldState, ReadonlyArray<UIMessageChunk>] => {
  const chunks: UIMessageChunk[] = [];
  let next = state;

  // the message opens on the first event of the run, whatever it is
  if (!state.started) {
    chunks.push({ type: "start", messageId: event.session ?? event.id });
    next = { ...next, started: true };
  }

  const payload = payloadOf(event);
  switch (event.type) {
    case "run.admitted":
      // the input side — the transcript view reads it; the chunk
      // stream (which renders the ASSISTANT message) does not
      break;

    case "model.requested":
      if (next.stepOpen) chunks.push({ type: "finish-step" });
      chunks.push({ type: "start-step" });
      next = { ...next, stepOpen: true };
      break;

    case "model.delta": {
      // reasoning deltas ride the same live event, marked by kind —
      // they open their own block (typically before the text block)
      if (payload.kind === "reasoning") {
        const blockId = `${event.cause ?? "text"}:r`;
        if (next.openReasoningId !== blockId) {
          if (next.openReasoningId !== undefined) {
            chunks.push({ type: "reasoning-end", id: next.openReasoningId });
          }
          chunks.push({ type: "reasoning-start", id: blockId });
          next = { ...next, openReasoningId: blockId };
        }
        chunks.push({
          type: "reasoning-delta",
          id: blockId,
          delta: String(payload.delta ?? ""),
        });
        break;
      }
      const blockId = event.cause ?? "text";
      if (next.openReasoningId !== undefined) {
        chunks.push({ type: "reasoning-end", id: next.openReasoningId });
        next = { ...next, openReasoningId: undefined };
      }
      if (next.openTextId !== blockId) {
        if (next.openTextId !== undefined) {
          chunks.push({ type: "text-end", id: next.openTextId });
        }
        chunks.push({ type: "text-start", id: blockId });
        next = { ...next, openTextId: blockId, sawDeltas: true };
      }
      chunks.push({
        type: "text-delta",
        id: blockId,
        delta: String(payload.delta ?? ""),
      });
      break;
    }

    case "model.completed":
      if (next.openReasoningId !== undefined) {
        chunks.push({ type: "reasoning-end", id: next.openReasoningId });
        next = { ...next, openReasoningId: undefined };
      }
      if (next.openTextId !== undefined) {
        chunks.push({ type: "text-end", id: next.openTextId });
        next = { ...next, openTextId: undefined };
      }
      // the step stays open: this round's tools settle after the wire
      // call returns and must render inside the step
      break;

    case "tool.requested":
      chunks.push(
        {
          type: "tool-input-start",
          toolCallId: String(payload.callId),
          toolName: String(payload.name),
        },
        {
          type: "tool-input-available",
          toolCallId: String(payload.callId),
          toolName: String(payload.name),
          input: payload.params,
        },
      );
      break;

    case "tool.completed":
      chunks.push({
        type: "tool-output-available",
        toolCallId: String(payload.callId),
        output: payload.result,
      });
      break;

    case "tool.failed":
      chunks.push({
        type: "tool-output-error",
        toolCallId: String(payload.callId),
        errorText: String(payload.result ?? "tool failed"),
      });
      break;

    case "message.posted": {
      // a deterministic process's ctx.post — an authored bubble
      const id = event.id;
      chunks.push({
        type: "data-message",
        id,
        data: {
          author: String(payload.author ?? ""),
          text: String(payload.text ?? ""),
        },
      });
      break;
    }

    case "child.started":
    case "child.completed":
    case "child.failed": {
      const runId = String(payload.runId ?? event.cause ?? event.id);
      chunks.push({
        type: "data-run",
        id: runId,
        data: {
          runId,
          agent: String(payload.agent ?? "agent"),
          status:
            event.type === "child.started"
              ? "running"
              : event.type === "child.completed"
                ? "completed"
                : "failed",
          ...(event.type === "child.failed" && {
            error: String(payload.error ?? "child run failed"),
          }),
        },
      });
      break;
    }

    case "run.resolved":
      if (payload.deterministic === true) {
        chunks.push({
          type: "data-resolution",
          id: event.id,
          data: { summary: String(payload.value ?? "resolved") },
        });
      }
      break;

    case "ask.requested": {
      const askId = String(payload.askId);
      chunks.push({
        type: "data-ask",
        id: askId,
        data: { askId, status: "pending", payload: payload.payload },
      });
      next = {
        ...next,
        asks: new Map(next.asks).set(askId, payload.payload),
      };
      break;
    }

    case "ask.answered": {
      const askId = String(payload.askId);
      chunks.push({
        type: "data-ask",
        id: askId,
        data: {
          askId,
          status: "answered",
          // reconciliation REPLACES the part's data: carry the original
          // payload forward so the UI keeps rendering the question
          payload: next.asks.get(askId),
          verdict: String(payload.verdict ?? "answered"),
        },
      });
      break;
    }

    case "turn.halted": {
      // a TURN boundary, not the run's end: process runs iterate many
      // turns per run — the window closes on run.settled, never here
      if (next.openTextId !== undefined) {
        chunks.push({ type: "text-end", id: next.openTextId });
        next = { ...next, openTextId: undefined };
      }
      const outcome = String(payload.outcome ?? "Completed");
      if (outcome === "Completed") {
        // replay path: deltas are live-only, so a replayed turn carries
        // its text on the halt row — synthesize the block (inside the
        // still-open final step)
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!next.sawDeltas && text.length > 0) {
          const blockId = event.cause ?? "text";
          chunks.push(
            { type: "text-start", id: blockId },
            { type: "text-delta", id: blockId, delta: text },
            { type: "text-end", id: blockId },
          );
        }
      }
      if (next.stepOpen) {
        chunks.push({ type: "finish-step" });
        next = { ...next, stepOpen: false };
      }
      if (outcome === "Interrupted") {
        chunks.push({ type: "abort", reason: "interrupted" });
      } else if (outcome !== "Completed") {
        chunks.push({ type: "error", errorText: `run halted: ${outcome}` });
      }
      break;
    }

    case "run.settled": {
      // the run's uniform durable terminal — the window closes here
      if (next.openReasoningId !== undefined) {
        chunks.push({ type: "reasoning-end", id: next.openReasoningId });
        next = { ...next, openReasoningId: undefined };
      }
      if (next.openTextId !== undefined) {
        chunks.push({ type: "text-end", id: next.openTextId });
        next = { ...next, openTextId: undefined };
      }
      if (next.stepOpen) {
        chunks.push({ type: "finish-step" });
        next = { ...next, stepOpen: false };
      }
      if (payload.outcome === "Failed") {
        chunks.push({
          type: "error",
          errorText: String(payload.error ?? "run failed"),
        });
      }
      chunks.push({ type: "finish" });
      break;
    }

    default:
      // turn.steered, run.iteration, check.*, run.resolved… are loop /
      // control surface — not part of the chat message rendering (they
      // remain visible on the trace endpoint)
      break;
  }

  return [next, chunks];
};

/**
 * Does an event belong to the run with this admission session? Process
 * runs iterate turns, each with a DERIVED session (`X#0/i2`) — prefix
 * matching folds a whole run, agent or process, into one window.
 */
export const inRun = (event: KernelEvent, session: string): boolean =>
  event.session === session ||
  (event.session !== undefined && event.session.startsWith(`${session}/`));

/** Slice an event stream down to ONE run and end it when it settles. */
export const sessionEvents = <E>(
  events: Stream.Stream<KernelEvent, E>,
  session: string,
): Stream.Stream<KernelEvent, E> =>
  events.pipe(
    Stream.filter((event) => inRun(event, session)),
    Stream.takeUntil((event) => event.type === "run.settled"),
  );

/**
 * Materialize one run's chunks into the assistant `UIMessage` — the
 * transcript's write path (designs/ai/serving.md §2). Parts appear in
 * first-touch order; tool and ask parts reconcile in place as their
 * later chunks land, mirroring how `useChat` itself builds the message.
 */
export const chunksToMessage = (
  chunks: ReadonlyArray<UIMessageChunk>,
): UIMessage => {
  let id = "assistant";
  const order: string[] = [];
  const parts = new Map<string, Record<string, unknown>>();
  const touch = (key: string, part: Record<string, unknown>) => {
    if (!parts.has(key)) order.push(key);
    parts.set(key, { ...parts.get(key), ...part });
  };
  for (const chunk of chunks) {
    switch (chunk.type) {
      case "start":
        if (chunk.messageId !== undefined) id = chunk.messageId;
        break;
      case "text-start":
        touch(`text:${chunk.id}`, { type: "text", text: "" });
        break;
      case "text-delta": {
        const key = `text:${chunk.id}`;
        touch(key, {
          type: "text",
          text: String(parts.get(key)?.text ?? "") + chunk.delta,
        });
        break;
      }
      case "text-end":
        touch(`text:${chunk.id}`, { state: "done" });
        break;
      case "reasoning-start":
        touch(`reasoning:${chunk.id}`, { type: "reasoning", text: "" });
        break;
      case "reasoning-delta": {
        const key = `reasoning:${chunk.id}`;
        touch(key, {
          type: "reasoning",
          text: String(parts.get(key)?.text ?? "") + chunk.delta,
        });
        break;
      }
      case "reasoning-end":
        touch(`reasoning:${chunk.id}`, { state: "done" });
        break;
      case "tool-input-available":
        touch(`tool:${chunk.toolCallId}`, {
          type: "dynamic-tool",
          toolName: chunk.toolName,
          toolCallId: chunk.toolCallId,
          state: "input-available",
          input: chunk.input,
        });
        break;
      case "tool-output-available":
        touch(`tool:${chunk.toolCallId}`, {
          state: "output-available",
          output: chunk.output,
        });
        break;
      case "tool-output-error":
        touch(`tool:${chunk.toolCallId}`, {
          state: "output-error",
          errorText: chunk.errorText,
        });
        break;
      case "data-ask":
        touch(`ask:${chunk.id}`, {
          type: "data-ask",
          id: chunk.id,
          data: chunk.data,
        });
        break;
      case "data-message":
        touch(`msg:${chunk.id}`, {
          type: "data-message",
          id: chunk.id,
          data: chunk.data,
        });
        break;
      case "data-run":
        touch(`run:${chunk.id}`, {
          type: "data-run",
          id: chunk.id,
          data: chunk.data,
        });
        break;
      case "data-resolution":
        touch(`resolution:${chunk.id}`, {
          type: "data-resolution",
          id: chunk.id,
          data: chunk.data,
        });
        break;
      default:
        break;
    }
  }
  return {
    id,
    role: "assistant",
    parts: order.map((key) => parts.get(key)!) as unknown as UIMessage["parts"],
  };
};

/** Fold a run's events into the UI message chunk stream. */
export const toChunks = <E>(
  events: Stream.Stream<KernelEvent, E>,
): Stream.Stream<UIMessageChunk, E> =>
  events.pipe(
    Stream.mapAccumArray(
      () => initialChunkFoldState,
      (state, batch) => {
        let current = state;
        const out: UIMessageChunk[] = [];
        for (const event of batch) {
          const [next, chunks] = foldEvent(current, event);
          current = next;
          out.push(...chunks);
        }
        return [current, out] as const;
      },
    ),
  );
