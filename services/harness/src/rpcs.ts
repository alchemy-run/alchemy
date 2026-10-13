import * as AI from "alchemy/AI/Client";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

const Failure = Schema.Union([AI.SessionError, AI.Unsupported]);

/** The machine a session runs on. */
export const Machine = Schema.Struct({
  /**
   * `suspended`: stopped, its workspace snapshotted; resumes on the next turn.
   * `starting` / `suspending`: on its way to running / suspended.
   */
  state: Schema.Literals(["running", "suspended", "starting", "suspending"]),
  /** Where it runs, e.g. "Cloudflare Container". */
  platform: Schema.String,
  /** The platform's size for it, e.g. "standard-4". */
  instance: Schema.String,
  vcpus: Schema.Number,
  memoryBytes: Schema.Number,
  diskBytes: Schema.Number,
  /** Where it last ran, e.g. "SJC (US)". */
  location: Schema.optional(Schema.String),
  /** Live, while running. */
  usage: Schema.optional(
    Schema.Struct({
      memoryUsedBytes: Schema.Number,
      diskUsedBytes: Schema.Number,
      uptimeSeconds: Schema.Number,
    }),
  ),
});
export type Machine = typeof Machine.Type;

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
  /** The session's machine; `stats` reads live usage from it (when running). */
  Rpc.make("machine", {
    payload: { ...Session, stats: Schema.optional(Schema.Boolean) },
    success: Machine,
    error: Failure,
  }),
  /**
   * The session's agent and machine state, from this object's records only:
   * never starts the machine. What session lists show.
   */
  Rpc.make("summary", {
    payload: Session,
    success: Schema.Struct({
      machine: Machine.fields.state,
      session: Schema.optional(AI.SessionInfo),
    }),
    error: Failure,
  }),
  /** Stop the session's machine (its work saved) and archive it; a new prompt brings it back. */
  Rpc.make("settle", { payload: Session, success: Machine, error: Failure }),
  /** Snapshot the machine's work and stop it. */
  Rpc.make("suspend", { payload: Session, success: Machine, error: Failure }),
  /** Start the machine again (a turn also does). */
  Rpc.make("resume", { payload: Session, success: Machine, error: Failure }),
  /** Keystrokes for the session's shell. */
  Rpc.make("terminalInput", { payload: { ...Session, data: Schema.String }, error: Failure }),
  Rpc.make("terminalResize", {
    payload: { ...Session, cols: Schema.Number, rows: Schema.Number },
    error: Failure,
  }),
) {}
