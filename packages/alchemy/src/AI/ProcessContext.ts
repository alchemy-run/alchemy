import type * as Effect from "effect/Effect";
import type { Event } from "./Event.ts";

/**
 * The handle a **deterministic** process handler receives (reassess §C):
 * `AI.process(term, (item, ctx) => Effect<Out, Err, R>)` lifts ordinary
 * Effect code into a term's full `ProcessService` — mailbox, `dispatch =
 * send + await`, steer, interrupt — so a coordinator
 * written as plain code (fan out with `Effect.all`, route with `Match`,
 * dispatch child agents via their resolved tags) is a first-class
 * process without hand-rolling the five verbs.
 *
 * `ctx` is the handler's window onto its own run's Trace: `emit`/`post`
 * write durable rows under the run's session, so a hand-written
 * coordinator's timeline and the run inspector render identically to a
 * prose process's. The handler dispatches to children by resolving
 * their tags from context itself (`yield* Sage` → `sage.dispatch(item)`)
 * — the ambient context is the one the process's Layer was built in.
 */
export interface ProcessContext {
  /**
   * Publish a typed message on a declared {@link Event} (canon §4
   * addition 1): ONE durable `message.emitted` Trace row AND a typed
   * publication on the EventBus, so subscribers (machine-observed halts,
   * front doors tailing the bus) see exactly what the Trace records.
   *
   * Durability note: the memory kernel has no staged-commit machinery —
   * the row commits immediately (matching every other `ctx.*` emit) and
   * the bus publication follows it; atomic commit with the run's
   * terminal row is the Phase-3 ledger's job. Channel-backed sources
   * publish on the harness bus in the memory kernel (the per-cloud
   * channel Layer owns real-world publication).
   *
   * The declared publications of a term are its bare `${X}` Event
   * mentions (the publish grant, canon §2a) — topology metadata; this
   * method accepts any source at the type level.
   */
  emit<In>(source: Event<In>, payload: In): Effect.Effect<void>;
  /** Write a durable event row to this run's Trace (observability). */
  emit(type: string, payload?: unknown): Effect.Effect<void>;
  /**
   * Post an authored message into the run's thread — a `message.posted`
   * row the chunk fold renders as an authored bubble (the deterministic
   * analogue of a prose coordinator's `post_reply` tool). `author` is
   * the speaker's name (a member agent, or the coordinator itself).
   */
  post(author: string, text: string): Effect.Effect<void>;
  /**
   * Run one named child task with parent-side lifecycle facts.
   *
   * Emits `child.started` immediately, then `child.completed` or
   * `child.failed` with one stable run id. The serving fold reconciles
   * those rows into a clickable `data-run` pill; clicking follows the
   * child's own ring in the inspector while its final result is later
   * posted into the thread via `ctx.post`.
   */
  run<A, E, R>(
    agent: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R>;
}
