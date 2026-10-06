import * as Stream from "effect/Stream";
import type { SessionEvent } from "./Session.ts";

/**
 * One chunk of the AI SDK UI message stream protocol (what `useChat` reads).
 * Plain JSON — no dependency on the `ai` package.
 */
export type UIMessageChunk =
  | { readonly type: "start"; readonly messageId?: string }
  | { readonly type: "start-step" }
  | { readonly type: "finish-step" }
  | { readonly type: "finish" }
  | { readonly type: "text-start"; readonly id: string }
  | { readonly type: "text-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "text-end"; readonly id: string }
  | { readonly type: "reasoning-start"; readonly id: string }
  | { readonly type: "reasoning-delta"; readonly id: string; readonly delta: string }
  | { readonly type: "reasoning-end"; readonly id: string }
  | {
      readonly type: "tool-input-available";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
      readonly dynamic: true;
    }
  | {
      readonly type: "tool-output-available";
      readonly toolCallId: string;
      readonly output: unknown;
      readonly dynamic: true;
    }
  | {
      readonly type: "tool-output-error";
      readonly toolCallId: string;
      readonly errorText: string;
      readonly dynamic: true;
    }
  | { readonly type: `data-${string}`; readonly id?: string; readonly data: unknown }
  | { readonly type: "error"; readonly errorText: string };

/**
 * Translate a session's events into the AI SDK UI message stream protocol,
 * so `useChat` (Vercel AI SDK) and `useAgentChat` render a coding-agent
 * session unmodified. Each turn is one assistant message.
 *
 * What chat messages can't express travels as typed data parts:
 * `data-plan` (plan updates), `data-diff` (file edits), `data-subagent`,
 * `data-permission` (approval requests — answer with `respond`), and
 * `data-usage`.
 *
 * Serve it as server-sent events with the protocol header:
 *
 * ```typescript
 * HttpServerResponse.stream(
 *   AI.toUIMessageStream(session.events({ after })).pipe(
 *     Stream.map((chunk) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)),
 *   ),
 *   { contentType: "text/event-stream", headers: { "x-vercel-ai-ui-message-stream": "v1" } },
 * );
 * ```
 */
export const toUIMessageStream = <E, R>(
  events: Stream.Stream<SessionEvent, E, R>,
): Stream.Stream<UIMessageChunk, E, R> =>
  Stream.suspend(() => {
    // Text/reasoning parts open lazily on their first delta and close at turn end.
    const openText = new Set<string>();
    const openReasoning = new Set<string>();
    const closeAll = (): UIMessageChunk[] => {
      const out: UIMessageChunk[] = [
        ...[...openReasoning].map((id): UIMessageChunk => ({ type: "reasoning-end", id })),
        ...[...openText].map((id): UIMessageChunk => ({ type: "text-end", id })),
      ];
      openText.clear();
      openReasoning.clear();
      return out;
    };
    return events.pipe(
      Stream.flatMap((event): Stream.Stream<UIMessageChunk> => {
        const chunks: UIMessageChunk[] = [];
        switch (event.type) {
          case "turn.started":
            chunks.push({ type: "start", messageId: event.turnId }, { type: "start-step" });
            break;
          case "message.delta":
            if (event.role !== "assistant") break;
            if (!openText.has(event.itemId)) {
              openText.add(event.itemId);
              chunks.push({ type: "text-start", id: event.itemId });
            }
            chunks.push({ type: "text-delta", id: event.itemId, delta: event.text });
            break;
          case "reasoning.delta":
            if (!openReasoning.has(event.itemId)) {
              openReasoning.add(event.itemId);
              chunks.push({ type: "reasoning-start", id: event.itemId });
            }
            chunks.push({ type: "reasoning-delta", id: event.itemId, delta: event.text });
            break;
          case "tool.started":
            chunks.push({
              type: "tool-input-available",
              toolCallId: event.itemId,
              toolName: event.tool.name ?? event.tool.kind,
              input: event.tool.input ?? { title: event.tool.title },
              dynamic: true,
            });
            break;
          case "tool.completed":
            chunks.push(
              event.status === "ok"
                ? {
                    type: "tool-output-available",
                    toolCallId: event.itemId,
                    output: event.content,
                    dynamic: true,
                  }
                : {
                    type: "tool-output-error",
                    toolCallId: event.itemId,
                    errorText:
                      event.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") ||
                      "tool failed",
                    dynamic: true,
                  },
            );
            for (const c of event.content) {
              if (c.type === "diff")
                chunks.push({ type: "data-diff", id: `${event.itemId}:${c.path}`, data: c });
            }
            break;
          case "plan.updated":
            chunks.push({ type: "data-plan", id: "plan", data: event.entries });
            break;
          case "subagent.started":
          case "subagent.completed":
            chunks.push({ type: "data-subagent", id: event.subagentId, data: event });
            break;
          case "permission.requested":
          case "question.asked":
            chunks.push({ type: "data-permission", id: event.requestId, data: event });
            break;
          case "usage":
            chunks.push({ type: "data-usage", data: event.usage });
            break;
          case "error":
            chunks.push({ type: "error", errorText: event.message });
            break;
          case "turn.completed":
            chunks.push(...closeAll());
            if (event.result.status === "failed") {
              chunks.push({ type: "error", errorText: event.result.error ?? "turn failed" });
            }
            chunks.push(
              { type: "data-usage", data: event.result.usage },
              { type: "finish-step" },
              { type: "finish" },
            );
            break;
          default:
            break;
        }
        return Stream.fromIterable(chunks);
      }),
    );
  });
