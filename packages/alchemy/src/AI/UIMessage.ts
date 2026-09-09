import type { UIMessage, UIMessageChunk, UIMessagePart } from "ai";
import { renderCrash } from "./DriverCore.ts";
import type { SessionObservation } from "./Events.ts";

/** The IN-FLIGHT sampling a projection may accumulate from
 *  `assistant-delta` and live `tool-call` observations — transient:
 *  the final `assistant` observation restates the whole sampling. */
export interface StreamingSample {
  readonly tick: number;
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }>;
}

/**
 * One `input` observation as the user message it is. Ids are the
 * durable seq (`u-${seq}`) so a snapshot and a socket replay of the
 * same row agree — a client dedupes on it.
 */
export const inputToUIMessage = (
  observation: Extract<SessionObservation, { type: "input" }>,
): UIMessage => ({
  id: `u-${observation.seq}`,
  role: "user",
  parts: [{ type: "text", text: observation.text }],
  // structural provenance (note/reminder) + wall-clock time —
  // clients read these, never the in-band text markers
  metadata: {
    at: observation.at,
    ...(observation.kind !== undefined ? { kind: observation.kind } : {}),
  },
});

/**
 * A tool's FAILURE as the text a client shows: a declared failure
 * arrives as its encoded record (`{ _tag, message, … }`), a plain
 * failure as a string. `String(record)` would read `[object Object]`.
 */
/** What a call cut short by the round's end says in place of its
 *  result — the operator's stop, or the session's settle. */
export const STOPPED_TEXT =
  "stopped — the round ended before this call answered";

export const renderToolFailure = (output: unknown): string => {
  if (typeof output === "string") return output;
  if (typeof output === "object" && output !== null) {
    const record = output as { _tag?: unknown; message?: unknown };
    const tag = typeof record._tag === "string" ? record._tag : undefined;
    const message =
      typeof record.message === "string" ? record.message : undefined;
    if (tag !== undefined && message !== undefined) return `${tag}: ${message}`;
    if (message !== undefined) return message;
    if (tag !== undefined) return tag;
    return JSON.stringify(output) ?? String(output);
  }
  return String(output);
};

/**
 * The Vercel AI SDK adapter, snapshot half — driver vocabulary
 * rendered into the `useChat` wire protocol (designs/ai/streaming.md;
 * only TYPES are imported from `ai`, no runtime dependency): reduce a
 * session's observation log into AI SDK UIMessages. Inputs are user
 * messages; a BURST of samplings (everything between inputs) is one
 * assistant message whose parts are step-start + reasoning + text +
 * dynamic-tool parts, with tool results upgrading their call's
 * state. The in-flight sampling (when given) rides along as a final
 * streaming-state assistant message, so pollers render tokens as
 * they accumulate. {@link makeChunkTranslator} is the live half.
 */
export const toUIMessages = (
  log: ReadonlyArray<SessionObservation>,
  streaming?: StreamingSample | undefined,
): Array<UIMessage> => {
  const messages: Array<UIMessage> = [];
  let assistant:
    | { message: UIMessage; parts: Array<UIMessagePart<any, any>> }
    | undefined;
  const toolParts = new Map<string, any>();
  // delegations observed mid-sampling ("dispatched" precedes its
  // burst's consolidated `assistant`) — matched to tool parts by
  // name, in order, when the burst lands
  const pendingDispatches: Array<{
    toolName: string;
    agent: string;
    child: string | undefined;
  }> = [];
  // the sampling whose step is open, and where in the parts it began:
  // a `tool-call` row opens the step (the call streamed before the
  // sampling completed) and its `assistant` restatement joins it —
  // one step per sampling, with the text ahead of the calls as the
  // model produced it
  let stepTick: number | undefined;
  let stepAt = 0;

  const openAssistant = (observation: { seq: number; at: number }) => {
    if (assistant === undefined) {
      const parts: Array<UIMessagePart<any, any>> = [];
      const message: UIMessage = {
        id: `a-${observation.seq}`,
        role: "assistant",
        parts,
        metadata: { at: observation.at },
      };
      assistant = { message, parts };
      messages.push(message);
    }
    return assistant;
  };
  const openStep = (tick: number) => {
    const current = assistant!;
    if (stepTick !== tick) {
      current.parts.push({ type: "step-start" });
      stepTick = tick;
      stepAt = current.parts.length;
    }
    return current;
  };
  /** A call's part — the one already announced by its `tool-call`
   *  row, else a new one. */
  /** Every call still awaiting its result ends as a failure that says
   *  so — the round that owed the result is over. */
  const closeOpenCalls = (why: string) => {
    for (const part of toolParts.values()) {
      if (part.state === "input-available") {
        part.state = "output-error";
        part.errorText = why;
      }
    }
  };

  const toolPart = (
    current: { parts: Array<UIMessagePart<any, any>> },
    call: { id: string; name: string; input: unknown },
  ) => {
    const known = toolParts.get(call.id);
    if (known !== undefined) return known;
    const part: any = {
      type: "dynamic-tool" as const,
      toolName: call.name,
      toolCallId: call.id,
      state: "input-available" as const,
      input: call.input,
    };
    toolParts.set(call.id, part);
    current.parts.push(part);
    return part;
  };

  for (const observation of log) {
    switch (observation.type) {
      case "dispatched": {
        pendingDispatches.push({
          toolName: observation.toolName,
          agent: observation.agent,
          child: observation.child,
        });
        break;
      }
      case "input": {
        assistant = undefined;
        stepTick = undefined;
        messages.push(inputToUIMessage(observation));
        break;
      }
      // a call the sampling made before it completed — its handler is
      // running (or the process died mid-handler); the viewer sees the
      // call now, as a running tool part, restated when the row lands
      case "tool-call": {
        openAssistant(observation);
        const current = openStep(observation.tick);
        toolPart(current, {
          id: observation.toolCallId,
          name: observation.toolName,
          input: observation.input,
        });
        break;
      }
      case "assistant": {
        openAssistant(observation);
        const current = openStep(observation.tick);
        // the sampling's prose came BEFORE its calls — ahead of any
        // part its `tool-call` rows already placed in this step
        const prose: Array<UIMessagePart<any, any>> = [];
        if (
          observation.reasoning !== undefined &&
          observation.reasoning.length > 0
        ) {
          prose.push({
            type: "reasoning",
            text: observation.reasoning,
            state: "done",
          });
        }
        if (observation.text.length > 0) {
          prose.push({ type: "text", text: observation.text });
        }
        current.parts.splice(stepAt, 0, ...prose);
        for (const call of observation.toolCalls) {
          const part = toolPart(current, call);
          // a delegation call carries its identity — the client links
          // the card straight to the worker thread, no heuristics
          const dispatched = pendingDispatches.findIndex(
            (candidate) => candidate.toolName === call.name,
          );
          if (dispatched >= 0) {
            const [match] = pendingDispatches.splice(dispatched, 1);
            part.dispatch = { agent: match!.agent, child: match!.child };
          }
        }
        break;
      }
      case "tool-result": {
        const part = toolParts.get(observation.toolCallId);
        if (part !== undefined) {
          part.state = observation.isFailure
            ? "output-error"
            : "output-available";
          if (observation.isFailure) {
            part.errorText = renderToolFailure(observation.output);
          } else {
            part.output = observation.output;
          }
        }
        break;
      }
      case "crashed": {
        // a crash must be VISIBLE to pollers — dropping it leaves the
        // client staring at recovery notes with no cause in sight
        assistant = undefined;
        stepTick = undefined;
        messages.push({
          id: `crash-${observation.seq}`,
          role: "assistant",
          parts: [
            {
              type: "text",
              text: `Session crashed: ${renderCrash(observation.error)}`,
            },
          ],
          metadata: { at: observation.at },
        });
        break;
      }
      // a settle cuts a round the same way an abort does (`Sessions.stop`,
      // the supervision cascade): calls the round had in flight never
      // get their `tool-result` row — the projection closes them, or a
      // card would say "running" over a session that is gone
      case "settled": {
        closeOpenCalls(STOPPED_TEXT);
        break;
      }
      case "aborted": {
        // the operator's stop ends the burst: the message it cut short
        // wears `aborted` (the live translator's `finish` carries the
        // same metadata); a stop before any sampling landed stands
        // alone. The next sampling starts a fresh assistant message.
        closeOpenCalls(STOPPED_TEXT);
        if (assistant !== undefined) {
          assistant.message.metadata = {
            ...(assistant.message.metadata as object | undefined),
            aborted: true,
          };
        } else {
          messages.push({
            id: `abort-${observation.seq}`,
            role: "assistant",
            parts: [],
            metadata: { at: observation.at, aborted: true },
          });
        }
        assistant = undefined;
        stepTick = undefined;
        break;
      }
      default:
        break;
    }
  }

  if (
    streaming !== undefined &&
    (streaming.text.length > 0 ||
      streaming.reasoning.length > 0 ||
      streaming.toolCalls.length > 0)
  ) {
    const parts: Array<UIMessagePart<any, any>> = [];
    if (streaming.reasoning.length > 0) {
      parts.push({
        type: "reasoning",
        text: streaming.reasoning,
        state: "streaming",
      });
    }
    if (streaming.text.length > 0) {
      parts.push({ type: "text", text: streaming.text, state: "streaming" });
    }
    for (const call of streaming.toolCalls) {
      parts.push({
        type: "dynamic-tool",
        toolName: call.name,
        toolCallId: call.id,
        state: "input-available",
        input: call.input,
      } as never);
    }
    messages.push({
      id: `live-${streaming.tick}`,
      role: "assistant",
      parts,
    });
  }
  return messages;
};

/**
 * The observation seqs behind ONE UIMessage — the redaction span for
 * `Sessions.redact`. Groups the log exactly as {@link toUIMessages}
 * does, so deleting `a-<seq>` takes the whole burst (its `assistant`
 * samplings, their `tool-call`/`tool-result` rows, and the
 * `dispatched` markers that preceded it), `u-<seq>` takes the one
 * input, `crash-<seq>` the one crash. `settled` rows are never part
 * of a span — the session's end is not a message. Unknown ids answer
 * empty.
 */
export const observationSpan = (
  log: ReadonlyArray<SessionObservation>,
  messageId: string,
): Array<number> => {
  const groups = new Map<string, Array<number>>();
  let assistant: Array<number> | undefined;
  // mid-sampling rows (dispatched, live tool-calls) that precede
  // their burst's consolidated `assistant` — they belong to it
  let pending: Array<number> = [];
  for (const observation of log) {
    switch (observation.type) {
      case "input":
        assistant = undefined;
        pending = [];
        groups.set(`u-${observation.seq}`, [observation.seq]);
        break;
      case "crashed":
        assistant = undefined;
        pending = [];
        groups.set(`crash-${observation.seq}`, [observation.seq]);
        break;
      case "aborted":
        // part of the burst it ended; alone when nothing had sampled
        if (assistant !== undefined) assistant.push(observation.seq);
        else groups.set(`abort-${observation.seq}`, [observation.seq]);
        assistant = undefined;
        pending = [];
        break;
      // the burst's message is named by whichever row OPENED it — a
      // `tool-call` streamed before its sampling completed, else the
      // `assistant` row (exactly as `toUIMessages` ids the message)
      case "tool-call":
      case "assistant":
        if (assistant === undefined) {
          assistant = [];
          groups.set(`a-${observation.seq}`, assistant);
        }
        assistant.push(...pending, observation.seq);
        pending = [];
        break;
      case "settled":
        break;
      default:
        if (assistant !== undefined) assistant.push(observation.seq);
        else pending.push(observation.seq);
        break;
    }
  }
  return groups.get(messageId) ?? [];
};

/**
 * A stateful translator from a session's live observations to AI SDK
 * UIMessageChunks: emits `start` once, wraps each sampling in
 * `start-step`/`finish-step`, and reports whether the response is
 * COMPLETE (quiescence, settle, or crash) so the HTTP edge knows when
 * to say `finish` and close.
 */
export const makeChunkTranslator = () => {
  let started = false;
  let openStep = false;
  // the tick whose step is open because a LIVE tool-call announced it
  // (see the `tool-call` case) — its `assistant` restatement joins that
  // step instead of opening a second one
  let liveStepTick: number | undefined;
  // calls THIS stream has announced — an output for an unseen call
  // (a subscribe that opened mid-burst) must be dropped, or the AI
  // SDK fabricates an orphan tool part with no name and no input
  const knownCalls = new Set<string>();
  // announced calls still owed a result — closed as stopped when the
  // round is cut (abort, settle) instead of running forever in the view
  const openCalls = new Set<string>();

  return (
    observation: SessionObservation,
  ): { chunks: Array<UIMessageChunk>; done: boolean } => {
    const chunks: Array<UIMessageChunk> = [];
    let done = false;

    const closeOpenCalls = () => {
      for (const toolCallId of openCalls) {
        chunks.push({
          type: "tool-output-error",
          toolCallId,
          errorText: STOPPED_TEXT,
          dynamic: true,
        });
      }
      openCalls.clear();
    };

    const closeStep = () => {
      if (openStep) {
        chunks.push({ type: "finish-step" });
        openStep = false;
        liveStepTick = undefined;
      }
    };

    switch (observation.type) {
      // A tool call the in-flight sampling just made: its handler may
      // run for a long time (a machine waking, a tree converging, a
      // test suite) before the durable `assistant` restates it — so
      // the viewer learns of the call NOW, as a running tool part, and
      // is not left staring at nothing while the handler works.
      case "tool-call": {
        if (!started) {
          chunks.push({
            type: "start",
            messageId: `a-live-${observation.tick}`,
            // the wall clock, as a snapshot's message would carry it —
            // the view's day dividers read it
            messageMetadata: { at: observation.at },
          });
          started = true;
        }
        if (!openStep || liveStepTick !== observation.tick) {
          closeStep();
          chunks.push({ type: "start-step" });
          openStep = true;
          liveStepTick = observation.tick;
        }
        knownCalls.add(observation.toolCallId);
        openCalls.add(observation.toolCallId);
        chunks.push({
          type: "tool-input-available",
          toolCallId: observation.toolCallId,
          toolName: observation.toolName,
          input: observation.input,
          dynamic: true,
        });
        break;
      }
      case "assistant": {
        if (!started) {
          chunks.push({
            type: "start",
            messageId: `a-${observation.seq}`,
            messageMetadata: { at: observation.at },
          });
          started = true;
        }
        // the step a live tool-call of THIS sampling already opened is
        // this sampling's step — restate into it
        if (!openStep || liveStepTick !== observation.tick) {
          closeStep();
          chunks.push({ type: "start-step" });
          openStep = true;
        }
        liveStepTick = undefined;
        if (
          observation.reasoning !== undefined &&
          observation.reasoning.length > 0
        ) {
          const reasoningId = `r-${observation.seq}`;
          chunks.push({ type: "reasoning-start", id: reasoningId });
          chunks.push({
            type: "reasoning-delta",
            id: reasoningId,
            delta: observation.reasoning,
          });
          chunks.push({ type: "reasoning-end", id: reasoningId });
        }
        if (observation.text.length > 0) {
          const textId = `t-${observation.seq}`;
          chunks.push({ type: "text-start", id: textId });
          chunks.push({
            type: "text-delta",
            id: textId,
            delta: observation.text,
          });
          chunks.push({ type: "text-end", id: textId });
        }
        for (const call of observation.toolCalls) {
          knownCalls.add(call.id);
          openCalls.add(call.id);
          chunks.push({
            type: "tool-input-available",
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
            dynamic: true,
          });
        }
        // quiescence ends the burst — the assistant message is complete
        if (observation.toolCalls.length === 0) {
          closeStep();
          chunks.push({ type: "finish" });
          done = true;
        }
        break;
      }
      case "tool-result": {
        // orphaned result (call announced before this stream opened):
        // drop it — the durable snapshot restates the full pair
        if (!knownCalls.has(observation.toolCallId)) break;
        openCalls.delete(observation.toolCallId);
        chunks.push(
          observation.isFailure
            ? {
                type: "tool-output-error",
                toolCallId: observation.toolCallId,
                errorText: renderToolFailure(observation.output),
                dynamic: true,
              }
            : {
                type: "tool-output-available",
                toolCallId: observation.toolCallId,
                output: observation.output,
                dynamic: true,
              },
        );
        break;
      }
      case "settled": {
        // the round is cut with the session: calls it had in flight
        // never land their results — closed here, as the snapshot does
        closeOpenCalls();
        closeStep();
        // a stream must resolve cleanly even when the session ended
        // before producing anything (e.g. steering a settled session)
        if (!started) chunks.push({ type: "start" });
        chunks.push({ type: "finish" });
        done = true;
        break;
      }
      case "aborted": {
        // the operator stopped the round: whatever streamed stays, the
        // message wears `aborted` (as the snapshot's does), the turn
        // is over — the client's status returns to ready
        closeOpenCalls();
        closeStep();
        if (!started) {
          chunks.push({ type: "start", messageId: `abort-${observation.seq}` });
        }
        chunks.push({ type: "finish", messageMetadata: { aborted: true } });
        done = true;
        break;
      }
      case "crashed": {
        closeStep();
        if (!started) chunks.push({ type: "start" });
        chunks.push({
          type: "error",
          errorText: renderCrash(observation.error),
        });
        chunks.push({ type: "finish" });
        done = true;
        break;
      }
      default:
        break;
    }
    return { chunks, done };
  };
};
