/**
 * The Vercel AI SDK adapter — driver vocabulary rendered into the
 * `useChat` wire protocol (designs/ai/streaming.md). The projection
 * ({@link Chats}) stays protocol-neutral; this module is where AI SDK
 * shapes are minted:
 *
 * - {@link toUIMessages} reduces a chat's canonical log (plus the
 *   in-flight sampling) into `UIMessage[]` — the snapshot a client
 *   loads, and re-loads while polling for the live view;
 * - {@link makeChunkTranslator} turns live observations into
 *   `UIMessageChunk`s for an SSE response: one run-burst = one
 *   assistant message, one sampling = one step.
 *
 * Only TYPES are imported from `ai` — the adapter adds no runtime
 * dependency.
 */
import type { UIMessage, UIMessageChunk, UIMessagePart } from "ai";
import type { StreamingSample } from "./Chats.ts";
import { renderCrash } from "./DriverShared.ts";
import type { RunObservation } from "./Observer.ts";

/**
 * Reduce a run's observation log into AI SDK UIMessages: inputs are
 * user messages; a BURST of samplings (everything between inputs) is
 * one assistant message whose parts are step-start + reasoning +
 * text + dynamic-tool parts, with tool results upgrading their
 * call's state. The in-flight sampling (when given) rides along as a
 * final streaming-state assistant message, so pollers render tokens
 * as they accumulate.
 */
export const toUIMessages = (
  log: ReadonlyArray<RunObservation>,
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
        messages.push({
          id: `u-${observation.seq}`,
          role: "user",
          parts: [{ type: "text", text: observation.text }],
          // structural provenance (note/reminder) + wall-clock time —
          // clients read these, never the in-band text markers
          metadata: {
            at: observation.at,
            ...(observation.kind !== undefined
              ? { kind: observation.kind }
              : {}),
          },
        });
        break;
      }
      case "assistant": {
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
        assistant.parts.push({ type: "step-start" });
        if (
          observation.reasoning !== undefined &&
          observation.reasoning.length > 0
        ) {
          assistant.parts.push({
            type: "reasoning",
            text: observation.reasoning,
            state: "done",
          });
        }
        if (observation.text.length > 0) {
          assistant.parts.push({ type: "text", text: observation.text });
        }
        for (const call of observation.toolCalls) {
          const part: any = {
            type: "dynamic-tool" as const,
            toolName: call.name,
            toolCallId: call.id,
            state: "input-available" as const,
            input: call.input,
          };
          // a delegation call carries its identity — the client links
          // the card straight to the worker thread, no heuristics
          const dispatched = pendingDispatches.findIndex(
            (candidate) => candidate.toolName === call.name,
          );
          if (dispatched >= 0) {
            const [match] = pendingDispatches.splice(dispatched, 1);
            part.dispatch = { agent: match!.agent, child: match!.child };
          }
          toolParts.set(call.id, part);
          assistant.parts.push(part);
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
            part.errorText = String(observation.output);
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
              text: `Run crashed: ${renderCrash(observation.error)}`,
            },
          ],
          metadata: { at: observation.at },
        });
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
 * A stateful translator from a run's live observations to AI SDK
 * UIMessageChunks: emits `start` once, wraps each sampling in
 * `start-step`/`finish-step`, and reports whether the response is
 * COMPLETE (quiescence, settle, or crash) so the HTTP edge knows when
 * to say `finish` and close.
 */
export const makeChunkTranslator = () => {
  let started = false;
  let openStep = false;
  // calls THIS stream has announced — an output for an unseen call
  // (a subscribe that opened mid-burst) must be dropped, or the AI
  // SDK fabricates an orphan tool part with no name and no input
  const knownCalls = new Set<string>();

  return (
    observation: RunObservation,
  ): { chunks: Array<UIMessageChunk>; done: boolean } => {
    const chunks: Array<UIMessageChunk> = [];
    let done = false;

    const closeStep = () => {
      if (openStep) {
        chunks.push({ type: "finish-step" });
        openStep = false;
      }
    };

    switch (observation.type) {
      case "assistant": {
        if (!started) {
          chunks.push({ type: "start", messageId: `a-${observation.seq}` });
          started = true;
        }
        closeStep();
        chunks.push({ type: "start-step" });
        openStep = true;
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
        chunks.push(
          observation.isFailure
            ? {
                type: "tool-output-error",
                toolCallId: observation.toolCallId,
                errorText: String(observation.output),
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
        closeStep();
        // a stream must resolve cleanly even when the run ended
        // before producing anything (e.g. steering a settled run)
        if (!started) chunks.push({ type: "start" });
        chunks.push({ type: "finish" });
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
