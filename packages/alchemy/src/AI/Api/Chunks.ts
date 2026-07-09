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
import type { UIMessageChunk } from "./Protocol.ts";

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
  /** Whether any text was streamed via deltas this turn. */
  readonly sawDeltas: boolean;
  /** Pending ask payloads by askId — merged into the answered update. */
  readonly asks: ReadonlyMap<string, unknown>;
}

export const initialChunkFoldState: ChunkFoldState = {
  started: false,
  stepOpen: false,
  openTextId: undefined,
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
      const blockId = event.cause ?? "text";
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

/** Slice an event stream down to ONE run and end it at the halt. */
export const sessionEvents = <E>(
  events: Stream.Stream<KernelEvent, E>,
  session: string,
): Stream.Stream<KernelEvent, E> =>
  events.pipe(
    Stream.filter((event) => event.session === session),
    Stream.takeUntil((event) => event.type === "turn.halted"),
  );

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
