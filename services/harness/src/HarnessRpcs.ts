import * as AI from "alchemy/AI/Client";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { AgentRpcs } from "./AgentRpcs.ts";

/** A session as the list shows it, from its records (no machine is started). */
export const ListedSession = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.Number,
  /** When it was settled (archived, its machine stopped). */
  settledAt: Schema.optional(Schema.Number),
  /** Its machine: running, suspended, or unknown (unreachable). */
  state: Schema.Literals(["running", "suspended", "starting", "suspending", "unknown"]),
  /** Its agent's state (idle, running, …), as last recorded. */
  agent: Schema.optional(AI.SessionInfo.fields.state),
  costUsd: Schema.optional(Schema.Number),
});
export type ListedSession = typeof ListedSession.Type;

/**
 * The harness's API, served by its Worker over HTTP: every session's
 * `AgentRpcs` (each call names its session, and goes to that session's
 * Durable Object), plus the list of sessions. Shared by the Worker, the web
 * UI and the e2e tests; browser-safe (schemas only).
 */
export const HarnessRpcs = AgentRpcs.add(
  /** Every session, newest first, with its agent's and machine's state. */
  Rpc.make("list", { success: Schema.Array(ListedSession) }),
);
