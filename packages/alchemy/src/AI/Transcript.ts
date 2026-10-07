import {
  emptyUsage,
  type ContentBlock,
  type PermissionOption,
  type PlanEntry,
  type SessionEvent,
  type SessionState,
  type ToolCall,
  type ToolContent,
  type TurnStatus,
  type Usage,
} from "./Session.ts";

/** One part of a message, in the order it happened. */
export type TranscriptPart =
  | {
      readonly type: "text";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly type: "reasoning";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly type: "tool";
      readonly id: string;
      readonly tool: ToolCall;
      readonly state: "running" | "ok" | "error";
      /** Streamed output while running, then the tool's final content. */
      readonly output: string;
      readonly content: ReadonlyArray<ToolContent>;
    }
  | { readonly type: "plan"; readonly id: string; readonly entries: ReadonlyArray<PlanEntry> }
  | {
      readonly type: "permission";
      readonly id: string;
      readonly requestId: string;
      readonly tool: ToolCall;
      readonly options: ReadonlyArray<PermissionOption>;
    }
  | {
      readonly type: "question";
      readonly id: string;
      readonly requestId: string;
      readonly question: string;
    }
  | {
      readonly type: "subagent";
      readonly id: string;
      readonly title: string;
      readonly done: boolean;
    }
  | {
      readonly type: "notice";
      readonly id: string;
      readonly text: string;
      readonly level: "info" | "error";
    };

export interface TranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  /** The turn an assistant message belongs to. */
  readonly turnId?: string;
  /** Assistant messages: `streaming` until the turn ends, then its status. */
  readonly status?: "streaming" | TurnStatus;
  readonly parts: ReadonlyArray<TranscriptPart>;
  readonly usage?: Usage;
}

/** A session's conversation, folded from its event log. */
export interface Transcript {
  readonly messages: ReadonlyArray<TranscriptMessage>;
  /** `new` until the session's first event. */
  readonly state: SessionState | "new";
  readonly model: string | undefined;
  /** Totals across turns. */
  readonly usage: Usage;
  /** Cursor of the last folded event — resume `events({ after })` from here. */
  readonly cursor: number;
  /** When the running turn started (ms since epoch). */
  readonly turnStartedAt: number | undefined;
  /** Requests waiting on an answer (`respond`). */
  readonly pending: ReadonlyArray<string>;
}

export const emptyTranscript: Transcript = {
  messages: [],
  state: "new",
  model: undefined,
  usage: emptyUsage,
  cursor: 0,
  turnStartedAt: undefined,
  pending: [],
};

const blocksText = (blocks: ReadonlyArray<ContentBlock>) =>
  blocks.map((b) => (b.type === "text" ? b.text : "")).join("");

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
  cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
});

/** The open assistant message for the running turn, created on demand. */
const withAssistant = (
  t: Transcript,
  turnId: string,
  f: (parts: ReadonlyArray<TranscriptPart>) => ReadonlyArray<TranscriptPart>,
): ReadonlyArray<TranscriptMessage> => {
  const last = t.messages.at(-1);
  if (last?.role === "assistant" && last.turnId === turnId) {
    return [...t.messages.slice(0, -1), { ...last, parts: f(last.parts) }];
  }
  return [
    ...t.messages,
    { id: `a:${turnId}`, role: "assistant", turnId, status: "streaming", parts: f([]) },
  ];
};

const upsert = (
  parts: ReadonlyArray<TranscriptPart>,
  id: string,
  f: (prev: TranscriptPart | undefined) => TranscriptPart,
) => {
  const i = parts.findIndex((p) => p.id === id);
  return i === -1 ? [...parts, f(undefined)] : parts.map((p, j) => (j === i ? f(p) : p));
};

const doneStreaming = (parts: ReadonlyArray<TranscriptPart>) =>
  parts.map((p) => (p.type === "text" || p.type === "reasoning" ? { ...p, streaming: false } : p));

/** The turn the running assistant message belongs to (events between turns attach to the last). */
const currentTurn = (t: Transcript) =>
  [...t.messages].reverse().find((m) => m.role === "assistant")?.turnId ?? "turn";

/**
 * Fold one session event into a transcript. Pure and incremental: replay a
 * session's log from cursor 0, then keep folding live events — the same
 * shape `useChat`-style UIs render (messages made of text, reasoning, tool,
 * plan and approval parts), without any UI library.
 *
 * ```typescript
 * let transcript = AI.emptyTranscript;
 * yield* session.events().pipe(
 *   Stream.runForEach((event) => Effect.sync(() => {
 *     transcript = AI.reduceTranscript(transcript, event);
 *   })),
 * );
 * ```
 */
export const reduceTranscript = (t: Transcript, e: SessionEvent): Transcript => {
  if (e.cursor <= t.cursor && t.cursor !== 0) return t; // replayed duplicate
  const next = { ...t, cursor: e.cursor };
  switch (e.type) {
    case "state":
      return {
        ...next,
        state: e.state,
        turnStartedAt: e.state === "running" ? t.turnStartedAt : undefined,
      };
    case "model.changed":
      return { ...next, model: e.model };
    case "turn.started":
      return {
        ...next,
        state: "running",
        turnStartedAt: e.at,
        messages: withAssistant(t, e.turnId, (parts) => parts),
      };
    case "message.completed":
      return e.role === "user"
        ? {
            ...next,
            messages: [
              ...t.messages,
              {
                id: e.itemId,
                role: "user",
                parts: [
                  { type: "text", id: e.itemId, text: blocksText(e.content), streaming: false },
                ],
              },
            ],
          }
        : next;
    case "message.delta":
      if (e.role !== "assistant") return next;
      return {
        ...next,
        messages: withAssistant(t, currentTurn(t), (parts) =>
          upsert(parts, e.itemId, (prev) => ({
            type: "text",
            id: e.itemId,
            text: (prev?.type === "text" ? prev.text : "") + e.text,
            streaming: true,
          })),
        ),
      };
    case "reasoning.delta":
      return {
        ...next,
        messages: withAssistant(t, currentTurn(t), (parts) =>
          upsert(parts, `r:${e.itemId}`, (prev) => ({
            type: "reasoning",
            id: `r:${e.itemId}`,
            text: (prev?.type === "reasoning" ? prev.text : "") + e.text,
            streaming: true,
          })),
        ),
      };
    case "tool.started":
      return {
        ...next,
        messages: withAssistant(t, currentTurn(t), (parts) =>
          upsert(parts, e.itemId, () => ({
            type: "tool",
            id: e.itemId,
            tool: e.tool,
            state: "running",
            output: "",
            content: [],
          })),
        ),
      };
    case "tool.output":
      return {
        ...next,
        messages: withAssistant(t, currentTurn(t), (parts) =>
          upsert(parts, e.itemId, (prev) =>
            prev?.type === "tool"
              ? { ...prev, output: prev.output + e.chunk }
              : (prev as TranscriptPart),
          ),
        ),
      };
    case "tool.completed":
      return {
        ...next,
        messages: withAssistant(t, currentTurn(t), (parts) =>
          upsert(parts, e.itemId, (prev) => ({
            type: "tool",
            id: e.itemId,
            tool: prev?.type === "tool" ? prev.tool : { kind: "other", title: "tool" },
            state: e.status,
            output: prev?.type === "tool" ? prev.output : "",
            content: e.content,
          })),
        ),
      };
    case "plan.updated":
      return {
        ...next,
        messages: withAssistant(t, currentTurn(t), (parts) =>
          upsert(parts, "plan", () => ({ type: "plan", id: "plan", entries: e.entries })),
        ),
      };
    case "permission.requested":
      return {
        ...next,
        state: "awaiting_input",
        pending: [...t.pending, e.requestId],
        messages: withAssistant(t, currentTurn(t), (parts) => [
          ...parts,
          {
            type: "permission",
            id: e.requestId,
            requestId: e.requestId,
            tool: e.tool,
            options: e.options,
          },
        ]),
      };
    case "question.asked":
      return {
        ...next,
        state: "awaiting_input",
        pending: [...t.pending, e.requestId],
        messages: withAssistant(t, currentTurn(t), (parts) => [
          ...parts,
          { type: "question", id: e.requestId, requestId: e.requestId, question: e.question },
        ]),
      };
    case "subagent.started":
      return {
        ...next,
        messages: withAssistant(t, currentTurn(t), (parts) =>
          upsert(parts, `s:${e.subagentId}`, () => ({
            type: "subagent",
            id: `s:${e.subagentId}`,
            title: e.title,
            done: false,
          })),
        ),
      };
    case "subagent.completed":
      return {
        ...next,
        messages: withAssistant(t, currentTurn(t), (parts) =>
          upsert(parts, `s:${e.subagentId}`, (prev) => ({
            type: "subagent",
            id: `s:${e.subagentId}`,
            title: prev?.type === "subagent" ? prev.title : "subagent",
            done: true,
          })),
        ),
      };
    case "error":
      return {
        ...next,
        messages: withAssistant(t, currentTurn(t), (parts) => [
          ...parts,
          { type: "notice", id: `e:${e.cursor}`, text: e.message, level: "error" },
        ]),
      };
    case "turn.completed": {
      const messages = withAssistant(t, e.turnId, (parts) => doneStreaming(parts)).map((m) =>
        m.role === "assistant" && m.turnId === e.turnId
          ? { ...m, status: e.result.status, usage: e.result.usage }
          : m,
      );
      return {
        ...next,
        state: "idle",
        turnStartedAt: undefined,
        pending: [],
        usage: addUsage(t.usage, e.result.usage),
        messages:
          e.result.status === "failed" && e.result.error
            ? withAssistant({ ...t, messages }, e.turnId, (parts) => [
                ...parts,
                { type: "notice", id: `f:${e.cursor}`, text: e.result.error!, level: "error" },
              ])
            : messages,
      };
    }
    default:
      return next;
  }
};
