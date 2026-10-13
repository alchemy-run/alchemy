import * as AI from "alchemy/AI/Client";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

const Failure = Schema.Union([AI.SessionError, AI.Unsupported]);

/** Every call names the session it acts on. */
const Session = { sessionId: Schema.String };

/**
 * This app's API for an issue's agent (one Durable Object per issue), served
 * over a WebSocket straight to the browser. Shared by the Durable Object and
 * the web UI; browser-safe (schemas only).
 */
export class AgentRpcs extends RpcGroup.make(
  Rpc.make("start", {
    payload: { ...Session, model: Schema.optional(Schema.String) },
    success: AI.SessionInfo,
    error: Failure,
  }),
  Rpc.make("prompt", {
    payload: { ...Session, prompt: AI.Prompt },
    success: AI.TurnInfo,
    error: Failure,
  }),
  Rpc.make("steer", { payload: { ...Session, prompt: AI.Prompt }, error: Failure }),
  Rpc.make("interrupt", { payload: Session, error: Failure }),
  Rpc.make("setModel", { payload: { ...Session, model: Schema.String }, error: Failure }),
  Rpc.make("respond", {
    payload: { ...Session, requestId: Schema.String, answer: AI.Answer },
    error: Failure,
  }),
  Rpc.make("result", {
    payload: { ...Session, turnId: Schema.optional(Schema.String) },
    success: AI.TurnResult,
    error: Failure,
  }),
  Rpc.make("events", {
    payload: { ...Session, after: Schema.optional(AI.Cursor) },
    success: AI.SessionEvent,
    error: Failure,
    stream: true,
  }),
  Rpc.make("info", { payload: Session, success: AI.SessionInfo, error: Failure }),
  /**
   * A shell in the session's container, on a real terminal. Streams its
   * output — first what it printed recently (so a reconnecting client gets
   * its screen back), then live — until the shell exits.
   */
  Rpc.make("terminal", {
    payload: { ...Session, cols: Schema.Number, rows: Schema.Number },
    success: Schema.String,
    error: Failure,
    stream: true,
  }),
  /** Keystrokes for the session's shell. */
  Rpc.make("terminalInput", { payload: { ...Session, data: Schema.String }, error: Failure }),
  Rpc.make("terminalResize", {
    payload: { ...Session, cols: Schema.Number, rows: Schema.Number },
    error: Failure,
  }),
) {}
