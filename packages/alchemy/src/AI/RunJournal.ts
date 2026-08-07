/**
 * The RUN JOURNAL — the kernel's durability seam for run state, and
 * the heart of the bootstrap's restart surface
 * (designs/ai/bootstrap.md §3): a kernel that finds a `RunJournal` in
 * its interpret context SAVES each run's thread at every park (and on
 * crash), REMOVES it on settle, and RESTORES persisted runs — parked,
 * threads primed — when the agent's actor is interpreted at boot.
 *
 * Restart therefore preserves conversations while the process (and
 * the BEHAVIOR — charter code, tools) changes underneath them:
 * level-triggered stances re-render from the new code at the next
 * tick; the thread neither knows nor cares that the process died.
 *
 * OPTIONAL by design (same seam pattern as `KernelObserver` and
 * `WireMode`): absent, the in-memory kernel behaves exactly as
 * before — runs live as long as the process.
 *
 * The journal stores the prompt ENCODED (via the `Prompt` schema, so
 * it is JSON-safe); implementations decide the substrate — bun:sqlite
 * locally, DO storage in the cloud.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { KernelObservation } from "./Observer.ts";

export interface RunSnapshot {
  readonly term: string;
  readonly key: string;
  /** Samplings performed so far. */
  readonly tick: number;
  /** Next observation seq — restore continues the cursor, so socket
   *  subscribers and chat projections never see a seq collision. */
  readonly observed: number;
  /** Activated skills (effective when the stance also mentions them). */
  readonly active: ReadonlyArray<string>;
  /** The thread, encoded with the `Prompt` schema (JSON-safe). */
  readonly prompt: unknown;
  /** The run's durable observation log tail (socket replay window). */
  readonly log: ReadonlyArray<KernelObservation>;
}

export class RunJournal extends Context.Service<
  RunJournal,
  {
    /** Upsert a run's snapshot — called at every park and on crash. */
    readonly save: (snapshot: RunSnapshot) => Effect.Effect<void>;
    /** All persisted runs for one agent term, for restore at boot. */
    readonly restore: (
      term: string,
    ) => Effect.Effect<ReadonlyArray<RunSnapshot>>;
    /** Drop a settled run — settled runs are not restored. */
    readonly remove: (term: string, key: string) => Effect.Effect<void>;
  }
>()("alchemy/AI/RunJournal") {}
