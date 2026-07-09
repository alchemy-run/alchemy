import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "../RuntimeContext.ts";

/**
 * The live handle every interpreted **process term** produces — one
 * shape for Agent and Loop alike, the only two interpretable kinds (see
 * designs/ai/reports/agent-loop-algebra.md; capability terms and control
 * refs are compiled into their host process, never interpreted).
 *
 * Semantically a process term denotes a **Process**: `In → Run<Out, Err>`, where
 * a Run emits `KernelEvent`s (covariant), accepts steering (contravariant),
 * and completes with `Out` — an Effect `Channel` in denotation, though the
 * public surface deliberately stays these five verbs (the Channel's
 * canonical eliminations), not the seven-parameter algebra:
 *
 * 1. `dispatch` — the Effect view of one run: admit + await the done value.
 * 2. `send` — the admission half of `dispatch` alone (durable, idempotent,
 *    ordered enqueue; no join). The conformance suite asserts the identity
 *    `dispatch = send + await` — if `send` ever grows semantics beyond
 *    admission, there are two protocols again.
 * 3. `run` — the trigger-lift (`effect ∘ serve`): serve the term's
 *    triggers forever. `never` is a theorem (the trigger stream is
 *    unbounded), not a declaration — and on some harnesses "running"
 *    degenerates to "reachable" (a ring compiled to routes + alarms).
 * 4. `steer` — the run's contravariant input: mid-run messages admitted
 *    durably and promoted at the next iteration boundary (never
 *    mid-turn); promotion resets the step allowance. Under
 *    `AI.concurrency > 1` steering needs a run key (the work item's
 *    world identity) — typed in Phase 2.
 * 5. `interrupt` — not part of the channel algebra at all: Scope
 *    authority (§0.6 "authority flows down"), realized as a control
 *    admission through the same inbox. In-flight tool calls settle as
 *    interrupted results (the pairing invariant extends to abandonment),
 *    the fold runs, and a model-visible marker enters the Trace.
 *
 * Identity: a run is keyed by `(term, work item)` — **world identity
 * rides in `In`** (a GitHub issue, a Discord thread). There is no session
 * management API and no durable run object; "a run is active" is
 * derivable from the admission ledger + Trace.
 *
 * All five are runtime verbs, colored with `RuntimeContext`.
 */
export interface ProcessService<Out = void, In = unknown, Err = never> {
  /** Admit one work item and await its run's resolution (admit + join). */
  dispatch(item: In): Effect.Effect<Out, Err, RuntimeContext>;
  /** Admit one work item, fire-and-forget (the admission half alone). */
  send(item: In): Effect.Effect<void, never, RuntimeContext>;
  /** Serve the ring: consume triggers and dispatch runs until interrupted. */
  run(): Effect.Effect<never, Err, RuntimeContext>;
  /** Mid-run input, promoted at the next iteration boundary. */
  steer(input: unknown): Effect.Effect<void, never, RuntimeContext>;
  /** Scope authority: settle in-flight work as interrupted, fold, mark. */
  interrupt(): Effect.Effect<void, never, RuntimeContext>;
}
