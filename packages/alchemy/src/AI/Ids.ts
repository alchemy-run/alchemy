import * as Effect from "effect/Effect";
import type * as IdGenerator from "effect/unstable/ai/IdGenerator";

/**
 * Deterministic identity for the step machine and the Trace (§2.3, §9.3):
 * ids are **derived from position, never minted** — `step` is pure (no id
 * generation inside it), and replay of the same positions collides
 * idempotently instead of duplicating.
 *
 * Two id spaces, deliberately distinct (they must not be conflated):
 *
 * - **Command ids** — ours, from `(session, stepIndex, ordinal)`. Used for
 *   Trace event ids, `cause` chains, budget rows, ask correlation, and
 *   steer targeting.
 * - **Tool call ids** — provider-minted (`ToolCallPart.id`). Used for
 *   tool-pairing and suspension bookkeeping (§2.4: key on callId, never
 *   tool name). The bridge: a `ToolRequested` event's id is
 *   `eventId(modelCommandId, "call", callId)`.
 */

/**
 * A run's session key: `(term, work item)` — world identity rides in `In`
 * (§2.1). `promptHash:workItemKey`.
 */
export type SessionKey = string;

/** Deterministic command identity, derived from position. */
export const commandId = (
  session: SessionKey,
  /** Increments once per `step()` invocation. */
  stepIndex: number,
  /** Index of the command in `step()`'s returned `Command[]`. */
  ordinal: number,
): string => `cmd:${session}:${stepIndex}:${ordinal}`;

/**
 * Durable event identity, derived from the command that caused it (plus a
 * disambiguator for events that occur multiple times per command, e.g. a
 * provider-minted tool call id).
 */
export const eventId = (
  cause: string,
  kind: string,
  disambiguator?: string,
): string =>
  disambiguator === undefined
    ? `${cause}:${kind}`
    : `${cause}:${kind}:${disambiguator}`;

/**
 * A deterministic per-turn `IdGenerator` for effect/ai: provider adapters
 * fill missing part ids through this service, so providing a positional
 * counter (instead of the random `defaultIdGenerator`) makes even
 * gap-filled ids replay-stable.
 */
export const deterministicIdGenerator = (
  session: SessionKey,
  stepIndex: number,
): IdGenerator.Service => {
  let n = 0;
  return {
    generateId: () => Effect.sync(() => `gen:${session}:${stepIndex}:${n++}`),
  };
};
