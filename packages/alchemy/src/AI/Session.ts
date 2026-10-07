/**
 * The shared vocabulary of coding-agent sessions — harness-agnostic.
 *
 * Every harness (Claude Code, Codex, OpenCode, Pi, any ACP agent) is driven
 * through the same {@link Session} interface and reports progress as the
 * same {@link SessionEvent} stream. Each harness's native protocol is
 * normalized into these events by its server; harness-specific extras live on
 * the harness's own session type (e.g. `Anthropic.ClaudeCodeSession`).
 *
 * Everything here is a `Schema`, so the same types travel over RPC
 * (`AI.SessionRpcs`), persist in a session store, and decode in browsers.
 */
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { RuntimeContext } from "../RuntimeContext.ts";

//#region Content

/** Position in a session's event log. Monotonic per session; resume with `events({ after })`. */
export const Cursor = Schema.Number;
export type Cursor = typeof Cursor.Type;

export const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
export const ImageBlock = Schema.Struct({
  type: Schema.Literal("image"),
  mimeType: Schema.String,
  /** Base64-encoded image bytes. */
  data: Schema.String,
});
export const ContentBlock = Schema.Union([TextBlock, ImageBlock]);
export type ContentBlock = typeof ContentBlock.Type;

/** A user turn: plain text or content blocks. */
export const Prompt = Schema.Union([Schema.String, Schema.Array(ContentBlock)]);
export type Prompt = typeof Prompt.Type;

/** Normalize a {@link Prompt} to content blocks. */
export const promptBlocks = (prompt: Prompt): ReadonlyArray<ContentBlock> =>
  typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt;

//#endregion

//#region Tools, plans, permissions

export const ToolKind = Schema.Literals([
  "shell",
  "edit",
  "read",
  "search",
  "fetch",
  "mcp",
  "think",
  "other",
]);
export type ToolKind = typeof ToolKind.Type;

export const ToolCall = Schema.Struct({
  kind: ToolKind,
  /** Human-readable summary (`Edit src/index.ts`, `pnpm test`). */
  title: Schema.String,
  /** The harness-native tool name. */
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
});
export type ToolCall = typeof ToolCall.Type;

export const ToolContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("diff"),
    path: Schema.String,
    oldText: Schema.optional(Schema.String),
    newText: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("terminal"),
    output: Schema.String,
    exitCode: Schema.optional(Schema.Number),
  }),
]);
export type ToolContent = typeof ToolContent.Type;

export const PlanEntry = Schema.Struct({
  content: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed"]),
});
export type PlanEntry = typeof PlanEntry.Type;

export const PermissionOption = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["allow_once", "allow_always", "reject_once", "reject_always"]),
});
export type PermissionOption = typeof PermissionOption.Type;

/** An answer to a `permission.requested` or `question.asked` event. */
export const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("permission"), optionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("cancelled") }),
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
]);
export type Answer = typeof Answer.Type;

//#endregion

//#region Turns, usage, state

export const Usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  /** Cost in USD, when the harness reports it. */
  costUsd: Schema.optional(Schema.Number),
});
export type Usage = typeof Usage.Type;

export const emptyUsage: Usage = { inputTokens: 0, outputTokens: 0 };

export const TurnStatus = Schema.Literals([
  "completed",
  "interrupted",
  "failed",
  "max_tokens",
  "refused",
]);
export type TurnStatus = typeof TurnStatus.Type;

export const TurnResult = Schema.Struct({
  turnId: Schema.String,
  status: TurnStatus,
  /** The final assistant message of the turn. */
  message: Schema.Array(ContentBlock),
  usage: Usage,
  error: Schema.optional(Schema.String),
});
export type TurnResult = typeof TurnResult.Type;

export const SessionState = Schema.Literals(["idle", "running", "awaiting_input", "closed"]);
export type SessionState = typeof SessionState.Type;

/**
 * What a harness can do natively. Missing capabilities degrade rather than
 * disappear: `steering: "interrupt-restart"` steers by interrupting the turn
 * and starting a new one; unsupported `fork`/`rollback` fail with
 * {@link Unsupported}.
 */
export const Capabilities = Schema.Struct({
  steering: Schema.Literals(["native", "interrupt-restart"]),
  queuedPrompts: Schema.Boolean,
  fork: Schema.Boolean,
  rollback: Schema.Boolean,
  subagents: Schema.Boolean,
  plans: Schema.Boolean,
  reasoning: Schema.Boolean,
  /** The session's model can change mid-session (`setModel`). */
  modelSwitching: Schema.Boolean,
});
export type Capabilities = typeof Capabilities.Type;

//#endregion

//#region Events

const at = Schema.Number;

const event = <const Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) =>
  Schema.Struct({
    type: Schema.Literal(type),
    cursor: Cursor,
    sessionId: Schema.String,
    /** Set on events from a subagent's session. */
    parentId: Schema.optional(Schema.String),
    at,
    ...fields,
  });

export const TurnStarted = event("turn.started", { turnId: Schema.String });
export const MessageDelta = event("message.delta", {
  itemId: Schema.String,
  role: Schema.Literals(["assistant", "user"]),
  text: Schema.String,
});
export const MessageCompleted = event("message.completed", {
  itemId: Schema.String,
  role: Schema.Literals(["assistant", "user"]),
  content: Schema.Array(ContentBlock),
});
export const ReasoningDelta = event("reasoning.delta", {
  itemId: Schema.String,
  text: Schema.String,
});
export const ToolStarted = event("tool.started", { itemId: Schema.String, tool: ToolCall });
export const ToolOutput = event("tool.output", { itemId: Schema.String, chunk: Schema.String });
export const ToolCompleted = event("tool.completed", {
  itemId: Schema.String,
  status: Schema.Literals(["ok", "error"]),
  content: Schema.Array(ToolContent),
});
export const PlanUpdated = event("plan.updated", { entries: Schema.Array(PlanEntry) });
export const PermissionRequested = event("permission.requested", {
  requestId: Schema.String,
  tool: ToolCall,
  options: Schema.Array(PermissionOption),
});
export const QuestionAsked = event("question.asked", {
  requestId: Schema.String,
  question: Schema.String,
});
export const SubagentStarted = event("subagent.started", {
  subagentId: Schema.String,
  title: Schema.String,
});
export const SubagentCompleted = event("subagent.completed", { subagentId: Schema.String });
export const UsageUpdated = event("usage", { usage: Usage });
export const TurnCompleted = event("turn.completed", { turnId: Schema.String, result: TurnResult });
export const StateChanged = event("state", { state: SessionState });
export const ErrorEvent = event("error", { message: Schema.String });
/** The session's model changed; it applies from the next turn (or immediately, where native). */
export const ModelChanged = event("model.changed", { model: Schema.String });

/** Everything a session reports, in log order. Discriminated by `type`. */
export const SessionEvent = Schema.Union([
  TurnStarted,
  MessageDelta,
  MessageCompleted,
  ReasoningDelta,
  ToolStarted,
  ToolOutput,
  ToolCompleted,
  PlanUpdated,
  PermissionRequested,
  QuestionAsked,
  SubagentStarted,
  SubagentCompleted,
  UsageUpdated,
  TurnCompleted,
  StateChanged,
  ErrorEvent,
  ModelChanged,
]);
export type SessionEvent = typeof SessionEvent.Type;

/** An event before the store stamps its `cursor` / `at`. */
export type SessionEventInput = SessionEvent extends infer E
  ? E extends SessionEvent
    ? Omit<E, "cursor" | "at" | "sessionId">
    : never
  : never;

//#endregion

//#region Session

export const StartSession = Schema.Struct({
  /** Session id; generated when omitted. Use a stable id to make `start` idempotent. */
  id: Schema.optional(Schema.String),
  /** Working directory. @default the harness server's `cwd` */
  cwd: Schema.optional(Schema.String),
  /** Check out a ref (optionally onto a new branch) before the first turn. */
  checkout: Schema.optional(
    Schema.Struct({ ref: Schema.String, branch: Schema.optional(Schema.String) }),
  ),
  /** Model for this session. @default the harness server's `model`. Change it later with `setModel`. */
  model: Schema.optional(Schema.String),
  systemPrompt: Schema.optional(Schema.String),
  /** `auto` approves every tool call; `ask` surfaces `permission.requested` events. @default "auto" */
  approvals: Schema.optional(Schema.Literals(["auto", "ask"])),
  /** Which configured account the session uses (harness-specific). */
  account: Schema.optional(Schema.String),
  /** Optional first turn. */
  prompt: Schema.optional(Prompt),
});
export type StartSession = typeof StartSession.Type;

export const SessionInfo = Schema.Struct({
  id: Schema.String,
  harness: Schema.String,
  state: SessionState,
  capabilities: Capabilities,
  usage: Usage,
  cwd: Schema.String,
  /** The model the session uses, when known. */
  model: Schema.optional(Schema.String),
  /** Cursor of the latest event. */
  cursor: Cursor,
});
export type SessionInfo = typeof SessionInfo.Type;

export const TurnInfo = Schema.Struct({ turnId: Schema.String, cursor: Cursor });
export type TurnInfo = typeof TurnInfo.Type;

/** A session operation failed. */
export class SessionError extends Schema.TaggedError<SessionError>()("SessionError", {
  sessionId: Schema.optional(Schema.String),
  message: Schema.String,
}) {}

/** The harness can't do this natively (see {@link Capabilities}). */
export class Unsupported extends Schema.TaggedError<Unsupported>()("Unsupported", {
  harness: Schema.String,
  operation: Schema.String,
}) {}

/**
 * A running coding-agent session. Methods map 1:1 onto `AI.SessionRpcs`, so
 * exposing a session over RPC is a pure mapping (`AI.makeSessionHandlers`).
 */
export interface Session {
  readonly id: string;
  readonly harness: string;
  readonly capabilities: Capabilities;
  /** Start a turn (queued behind a running turn when the harness supports it). */
  readonly prompt: (prompt: Prompt) => Effect.Effect<TurnInfo, SessionError, RuntimeContext>;
  /** Redirect the running turn — natively, or by interrupt-and-restart. */
  readonly steer: (prompt: Prompt) => Effect.Effect<void, SessionError, RuntimeContext>;
  readonly interrupt: () => Effect.Effect<void, SessionError, RuntimeContext>;
  /**
   * Switch the session's model. Takes effect immediately where the harness
   * supports it natively, otherwise from the next turn; fails with
   * {@link Unsupported} when the harness can't switch (`capabilities.modelSwitching`).
   */
  readonly setModel: (
    model: string,
  ) => Effect.Effect<void, SessionError | Unsupported, RuntimeContext>;
  /** Answer a `permission.requested` / `question.asked` event. */
  readonly respond: (
    requestId: string,
    answer: Answer,
  ) => Effect.Effect<void, SessionError, RuntimeContext>;
  /** Wait for a turn to finish (the latest turn when omitted). */
  readonly result: (turnId?: string) => Effect.Effect<TurnResult, SessionError, RuntimeContext>;
  /** The session's events from `after` onward: replay, then live. */
  readonly events: (options?: {
    readonly after?: Cursor;
  }) => Stream.Stream<SessionEvent, SessionError, RuntimeContext>;
  readonly info: () => Effect.Effect<SessionInfo, SessionError, RuntimeContext>;
  readonly fork: () => Effect.Effect<Session, SessionError | Unsupported, RuntimeContext>;
  readonly close: () => Effect.Effect<void, SessionError, RuntimeContext>;
}

/** A harness: starts and finds sessions. */
export interface Harness {
  readonly name: string;
  readonly capabilities: Capabilities;
  readonly start: (options?: StartSession) => Effect.Effect<Session, SessionError, RuntimeContext>;
  readonly get: (id: string) => Effect.Effect<Session, SessionError, RuntimeContext>;
  readonly list: () => Effect.Effect<ReadonlyArray<SessionInfo>, SessionError, RuntimeContext>;
}

//#endregion
