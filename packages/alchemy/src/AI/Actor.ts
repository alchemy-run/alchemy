import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * The Actor — what the kernel returns when it interprets any term's
 * charter: a mailbox with a serial run loop, spoken to only in the
 * actor verbs. Hand it work (`dispatch`/`send`), talk to a run
 * mid-flight (`steer`), resolve a run from the outside (`settle`).
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
 * Runs are keyed at admission; `steer`/`settle` address them by that
 * key.
 */
export interface Actor<In = unknown> {
  /**
   * Admit one work item and await its run's resolution (admit + join).
   * `options.key` names the run (see {@link Actor.send}).
   */
  dispatch(
    item: In,
    options?: { readonly key?: string },
  ): Effect.Effect<unknown, never, RuntimeContext>;
  /**
   * Admit one work item, fire-and-forget (the admission half alone).
   *
   * `options.key` is the run's CALLER-CHOSEN name — the world identity
   * to correlate by (`owner/repo#7`). Naming the run is what makes
   * `steer(key, …)` and `settle(key, …)` addressable from code that
   * never saw a kernel-minted session.
   */
  send(
    item: In,
    options?: { readonly key?: string },
  ): Effect.Effect<void, never, RuntimeContext>;
  /**
   * Run-key–addressed input: deliver a message to a SPECIFIC run,
   * promoted at the run's next boundary (wakes a parked run for
   * another work round).
   */
  steer(runKey: string, input: In): Effect.Effect<void, never, RuntimeContext>;
  /** Mid-run input to the active run, promoted at the next boundary. */
  steer(input: In): Effect.Effect<void, never, RuntimeContext>;
  /**
   * End a SPECIFIC run from the outside: the run resolves with `event`
   * as its outcome. The caller that consumed the wire owns run endings
   * — the kernel just runs the loop. Settling a key with no live run
   * is an idempotent no-op (the run may have settled already — the
   * world outranks the org's beliefs).
   */
  settle(
    runKey: string,
    event: unknown,
  ): Effect.Effect<void, never, RuntimeContext>;
  /** Scope authority: settle in-flight work as interrupted. */
  interrupt(): Effect.Effect<void, never, RuntimeContext>;
}
