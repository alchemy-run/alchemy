import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";

/** A reference to a driver session: which term, which key. */
export interface SessionRef {
  readonly term: string;
  readonly key: string;
}

/**
 * The Actor — what the driver returns when it interprets any term's
 * charter: a mailbox with a serial session loop, spoken to only in the
 * actor verbs. Hand it work (`dispatch`/`send`), talk to a session
 * mid-flight (`steer`), resolve a session from the outside (`settle`).
 *
 * Who may hold the Actor is a Layer decision. A PUBLIC {@link Agent}'s
 * tag IS its Actor — agents exist to be called. A sealed domain
 * surface (a business process) is a plain `Context.Service` whose
 * Layer interprets a PRIVATE agent and exposes only its declared
 * Shape — the Actor never leaves the closure.
 *
 * `In` is the term's input alphabet, DERIVED FROM ITS PROSE: the
 * union of the `AI.Event` payloads its charter splices, plus `string`
 * (always allowed). A charter that declares no events leaves `In` at
 * `unknown`. `settle` deliberately stays `unknown` — the outcome
 * belongs to the world, not to the charter's declarations.
 *
 * Sessions are keyed at admission; `steer`/`settle` address them by that
 * key.
 */
export interface Actor<In = unknown> {
  /**
   * Admit one work item and await its session's resolution (admit + join).
   * `options.key` names the session (see {@link Actor.send}).
   */
  dispatch(
    item: In,
    options?: {
      readonly key?: string;
      readonly parent?: SessionRef;
    },
  ): Effect.Effect<unknown, never, RuntimeContext>;
  /**
   * Admit one work item, fire-and-forget (the admission half alone).
   *
   * `options.key` is the session's CALLER-CHOSEN name — the world identity
   * to correlate by (`owner/repo#7`). Naming the session is what makes
   * `steer(key, …)` and `settle(key, …)` addressable from code that
   * never saw a driver-minted session.
   *
   * `options.parent` records WHICH SESSION caused this admission — the
   * driver's own `dispatch` intrinsic stamps it automatically, so
   * observability can reconstruct the delegation tree (issue desk →
   * engineer → …). Purely observational: it never affects routing.
   */
  send(
    item: In,
    options?: {
      readonly key?: string;
      readonly parent?: SessionRef;
      /**
       * `wake: false` delivers WITHOUT waking: the input lands in the
       * session's thread durably, but a parked session stays parked — the
       * accumulated inputs are read on its next wake (an operator
       * message, a reminder, a waking send), and a BUSY session picks
       * them up at its next sampling boundary as usual. The
       * level-triggered delivery mode: events as CONTEXT, not
       * triggers. Default `true` (a send wakes a parked session).
       */
      readonly wake?: boolean;
    },
  ): Effect.Effect<void, never, RuntimeContext>;
  /**
   * Session-key–addressed input: deliver a message to a SPECIFIC session,
   * promoted at the session's next boundary (wakes a parked session for
   * another work round).
   */
  steer(
    sessionKey: string,
    input: In,
  ): Effect.Effect<void, never, RuntimeContext>;
  /** Mid-session input to the active session, promoted at the next boundary. */
  steer(input: In): Effect.Effect<void, never, RuntimeContext>;
  /**
   * End a SPECIFIC session from the outside: the session resolves with `event`
   * as its outcome. The caller that consumed the wire owns session endings
   * — the driver just sessions the loop. Settling a key with no live session
   * is an idempotent no-op (the session may have settled already — the
   * world outranks the org's beliefs).
   */
  settle(
    sessionKey: string,
    event: unknown,
  ): Effect.Effect<void, never, RuntimeContext>;
  /** Scope authority: settle in-flight work as interrupted. */
  interrupt(): Effect.Effect<void, never, RuntimeContext>;
}
