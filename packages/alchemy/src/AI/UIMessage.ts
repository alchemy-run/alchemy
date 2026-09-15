import type { UIMessage, UIMessageChunk, UIMessagePart } from "ai";
import { renderCrash, STOPPED_TEXT } from "./DriverCore.ts";
import type { SessionObservation, TokenUsage } from "./Events.ts";

/**
 * What an assistant message's metadata says about its samplings: the
 * model of the LAST one (a burst normally samples with one model) and
 * the token bill SUMMED over the burst. Clients show the chip and
 * price the sum; a burst whose samplings reported nothing carries
 * neither key.
 */
export interface SamplingMetadata {
  readonly model?: string;
  readonly usage?: TokenUsage;
}

/** Sum two bills field by field; absent fields stay absent. */
export const addUsage = (
  a: TokenUsage | undefined,
  b: TokenUsage | undefined,
): TokenUsage | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const out: { -readonly [K in keyof TokenUsage]: TokenUsage[K] } = { ...a };
  for (const k of Object.keys(b) as Array<keyof TokenUsage>) {
    out[k] = (out[k] ?? 0) + (b[k] ?? 0);
  }
  return out;
};

/** Fold one sampling's `model` + `usage` into the running metadata. */
const stampSampling = (
  current: SamplingMetadata,
  observation: Extract<SessionObservation, { type: "assistant" }>,
): SamplingMetadata => ({
  ...current,
  ...(observation.model === undefined ? {} : { model: observation.model }),
  ...(() => {
    const usage = addUsage(current.usage, observation.usage);
    return usage === undefined ? {} : { usage };
  })(),
});

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
 * One `input` observation as the user message it is. The id is the
 * MESSAGE's durable identity (`Message.id`, stamped on the row at the
 * door) — stable across snapshot and socket replay, and the same
 * handle any domain store (a posts tree) knows the message by. Rows
 * written before messages carried ids fall back to the seq
 * (`u-${seq}`).
 */
export const inputToUIMessage = (
  observation: Extract<SessionObservation, { type: "input" }>,
): UIMessage => ({
  id: observation.id ?? `u-${observation.seq}`,
  role: "user",
  parts: [{ type: "text", text: observation.text }],
  // structural provenance (author, note/reminder) + wall-clock time —
  // clients read these, never the in-band text markers
  metadata: {
    at: observation.at,
    ...(observation.author !== undefined ? { author: observation.author } : {}),
    ...(observation.kind !== undefined ? { kind: observation.kind } : {}),
  },
});

/**
 * A tool's FAILURE as the text a client shows: a declared failure
 * arrives as its encoded record (`{ _tag, message, … }`), a plain
 * failure as a string. `String(record)` would read `[object Object]`.
 */
export { STOPPED_TEXT } from "./DriverCore.ts";

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
 * messages; EACH SAMPLING is one assistant message (id'd by the row
 * that opened it — a live `tool-call`, else its `assistant` row) with
 * reasoning + text + dynamic-tool parts, tool results upgrading their
 * call's state wherever the call lives. Per-sampling messages keep
 * public prose, thinking, and execution individually addressable
 * instead of welding a whole burst into one message. The in-flight
 * sampling (when given) rides along as a final streaming-state
 * assistant message, so pollers render tokens as they accumulate.
 * {@link makeChunkTranslator} is the live half.
 */
export const toUIMessages = (
  log: ReadonlyArray<SessionObservation>,
  streaming?: StreamingSample | undefined,
): Array<UIMessage> => {
  const messages: Array<UIMessage> = [];
  let assistant:
    | {
        message: UIMessage;
        parts: Array<UIMessagePart<any, any>>;
        tick: number;
      }
    | undefined;
  const toolParts = new Map<string, any>();
  // delegations observed mid-sampling ("dispatched" precedes its
  // sampling's consolidated `assistant`) — matched to tool parts by
  // name, in order, when the sampling lands
  const pendingDispatches: Array<{
    toolName: string;
    agent: string;
    child: string | undefined;
  }> = [];

  // the input that woke the round in flight — every sampling is, by
  // the session's own physics, part of the REPLY to the input before
  // it, and each message carries that edge (`replyTo`) so clients
  // thread on data, not on heuristics
  let lastInputId: string | undefined;

  // one message PER SAMPLING: a row of a new tick closes the previous
  // sampling's message and opens a fresh one (a `tool-call` streamed
  // mid-sampling and its `assistant` restatement share the tick, so
  // they share the message)
  const openSampling = (observation: {
    seq: number;
    at: number;
    tick: number;
  }) => {
    if (assistant === undefined || assistant.tick !== observation.tick) {
      const parts: Array<UIMessagePart<any, any>> = [{ type: "step-start" }];
      const message: UIMessage = {
        id: `a-${observation.seq}`,
        role: "assistant",
        parts,
        metadata: {
          at: observation.at,
          ...(lastInputId === undefined ? {} : { replyTo: lastInputId }),
        },
      };
      assistant = { message, parts, tick: observation.tick };
      messages.push(message);
    }
    return assistant;
  };
  // the sampling's prose splices ahead of any tool part its live
  // `tool-call` rows already placed — right after the step marker
  const PROSE_AT = 1;
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
        const input = inputToUIMessage(observation);
        lastInputId = input.id;
        messages.push(input);
        break;
      }
      // a call the sampling made before it completed — its handler is
      // running (or the process died mid-handler); the viewer sees the
      // call now, as a running tool part, restated when the row lands
      case "tool-call": {
        const current = openSampling(observation);
        toolPart(current, {
          id: observation.toolCallId,
          name: observation.toolName,
          input: observation.input,
        });
        break;
      }
      case "assistant": {
        const current = openSampling(observation);
        // what sampled and what it cost — this sampling's bill
        current.message.metadata = stampSampling(
          (current.message.metadata ?? {}) as SamplingMetadata,
          observation,
        );
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
            // how long the sampling took — the closest thing to "how
            // long it thought" the transcript records; the UI labels
            // the folded trace with it ("Thought for 4s")
            providerMetadata: { alchemy: { ms: observation.ms } },
          });
        }
        if (observation.text.length > 0) {
          prose.push({ type: "text", text: observation.text });
        }
        current.parts.splice(PROSE_AT, 0, ...prose);
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
      ...(lastInputId === undefined
        ? {}
        : { metadata: { replyTo: lastInputId } }),
    });
  }
  return messages;
};

/**
 * The observation seqs behind ONE UIMessage — the redaction span for
 * `Sessions.redact`. Groups the log exactly as {@link toUIMessages}
 * does, so deleting `a-<seq>` takes the one SAMPLING (its
 * `tool-call`/`assistant`/`tool-result` rows and the `dispatched`
 * markers around it), an input's message id (or legacy `u-<seq>`)
 * takes the one input, `crash-<seq>` the one crash. `settled` rows
 * are never part of a span — the session's end is not a message.
 * Unknown ids answer empty.
 */
export const observationSpan = (
  log: ReadonlyArray<SessionObservation>,
  messageId: string,
): Array<number> => {
  const groups = new Map<string, Array<number>>();
  let assistant: { seqs: Array<number>; tick: number } | undefined;
  // mid-sampling rows (dispatched markers) that precede their
  // sampling's first row — they belong to it
  let pending: Array<number> = [];
  // a call's result may land after its sampling's message closed
  // (the next tick opened) — route it to the call's own message
  const callGroups = new Map<string, Array<number>>();
  for (const observation of log) {
    switch (observation.type) {
      case "input":
        assistant = undefined;
        pending = [];
        groups.set(observation.id ?? `u-${observation.seq}`, [observation.seq]);
        break;
      case "crashed":
        assistant = undefined;
        pending = [];
        groups.set(`crash-${observation.seq}`, [observation.seq]);
        break;
      case "aborted":
        // part of the sampling it ended; alone when nothing had sampled
        if (assistant !== undefined) assistant.seqs.push(observation.seq);
        else groups.set(`abort-${observation.seq}`, [observation.seq]);
        assistant = undefined;
        pending = [];
        break;
      // one group PER SAMPLING, named by whichever row OPENED it — a
      // `tool-call` streamed before its sampling completed, else the
      // `assistant` row (exactly as `toUIMessages` ids the message)
      case "tool-call":
      case "assistant":
        if (assistant === undefined || assistant.tick !== observation.tick) {
          assistant = { seqs: [], tick: observation.tick };
          groups.set(`a-${observation.seq}`, assistant.seqs);
        }
        assistant.seqs.push(...pending, observation.seq);
        pending = [];
        if (observation.type === "tool-call") {
          callGroups.set(observation.toolCallId, assistant.seqs);
        } else {
          for (const call of observation.toolCalls) {
            callGroups.set(call.id, assistant.seqs);
          }
        }
        break;
      case "tool-result": {
        const group = callGroups.get(observation.toolCallId) ?? assistant?.seqs;
        if (group !== undefined) group.push(observation.seq);
        else pending.push(observation.seq);
        break;
      }
      case "settled":
        break;
      default:
        if (assistant !== undefined) assistant.seqs.push(observation.seq);
        else pending.push(observation.seq);
        break;
    }
  }
  return groups.get(messageId) ?? [];
};

/**
 * A stateful translator from a session's live observations to AI SDK
 * UIMessageChunks — ONE SAMPLING per stream, matching the snapshot's
 * per-sampling messages: emits `start` once (id'd by the sampling's
 * first row, exactly as {@link toUIMessages} names it), and reports
 * COMPLETE (`done`) when the sampling has fully landed — its
 * `assistant` row and every tool result it owed — or the round is cut
 * (abort, settle, crash). The socket transport ends the stream on
 * `done`; the client's persistent view re-subscribes and the next
 * sampling arrives as its own message, so live and hydrated
 * transcripts agree message for message.
 *
 * `options.replyTo` seeds the reply edge for a stream that opened
 * mid-round (the input row was consumed by an earlier stream — the
 * transport remembers it across turns).
 */
export const makeChunkTranslator = (options?: {
  readonly replyTo?: string;
}) => {
  let started = false;
  let openStep = false;
  // calls THIS stream has announced — an output for an unseen call
  // (a subscribe that opened mid-burst) must be dropped, or the AI
  // SDK fabricates an orphan tool part with no name and no input
  const knownCalls = new Set<string>();
  // announced calls still owed a result — closed as stopped when the
  // round is cut (abort, settle) instead of running forever in the view
  const openCalls = new Set<string>();
  // whether this stream's sampling row has landed — with it down and
  // every owed result in, the message is complete
  let sampled = false;
  // this sampling's bill — stamped on the message at `finish`
  let sampling: SamplingMetadata = {};
  // the input that woke the round — the sampling's REPLY edge
  // (`replyTo` in the start chunk's metadata), as the snapshot stamps
  // it; seeded by the transport for mid-round streams
  let lastInputId: string | undefined = options?.replyTo;

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
      }
    };

    const start = (observation: { seq: number; at: number }) => {
      if (started) return;
      chunks.push({
        type: "start",
        // the DURABLE id, exactly as a snapshot names this sampling
        // (`toUIMessages`/`observationSpan` id it by the row that
        // OPENED it) — so a client can address the message later
        // (redaction resolves `a-<seq>`), live or hydrated alike
        messageId: `a-${observation.seq}`,
        // the wall clock, as a snapshot's message would carry it —
        // the view's day dividers read it
        messageMetadata: {
          at: observation.at,
          ...(lastInputId === undefined ? {} : { replyTo: lastInputId }),
        },
      });
      started = true;
    };

    switch (observation.type) {
      // a new round's trigger — remembered so the sampling it wakes
      // carries its reply edge (the input row itself reaches clients
      // via the snapshot; the live feed threads on it)
      case "input": {
        lastInputId = observation.id ?? `u-${observation.seq}`;
        break;
      }
      // A tool call the in-flight sampling just made: its handler may
      // run for a long time (a machine waking, a tree converging, a
      // test suite) before the durable `assistant` restates it — so
      // the viewer learns of the call NOW, as a running tool part, and
      // is not left staring at nothing while the handler works.
      case "tool-call": {
        start(observation);
        if (!openStep) {
          chunks.push({ type: "start-step" });
          openStep = true;
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
        start(observation);
        if (!openStep) {
          chunks.push({ type: "start-step" });
          openStep = true;
        }
        sampled = true;
        sampling = stampSampling(sampling, observation);
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
          chunks.push({
            type: "reasoning-end",
            id: reasoningId,
            // the sampling time, for the folded trace's label
            providerMetadata: { alchemy: { ms: observation.ms } },
          });
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
        // the sampling has LANDED — with no calls (quiescence) the
        // message is complete now; with calls it completes when the
        // last owed result lands (the `tool-result` case below)
        if (openCalls.size === 0) {
          closeStep();
          chunks.push({ type: "finish", messageMetadata: { ...sampling } });
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
        // the sampling's last owed result — its message is complete;
        // the next sampling opens a fresh stream (and message)
        if (sampled && openCalls.size === 0) {
          closeStep();
          chunks.push({ type: "finish", messageMetadata: { ...sampling } });
          done = true;
        }
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
        chunks.push({
          type: "finish",
          messageMetadata: { ...sampling, aborted: true },
        });
        done = true;
        break;
      }
      case "crashed": {
        closeStep();
        // the snapshot's id for a crash row — addressable like any row
        if (!started) {
          chunks.push({ type: "start", messageId: `crash-${observation.seq}` });
        }
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
