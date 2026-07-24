import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Prompt from "effect/unstable/ai/Prompt";
import type { Fragment } from "./Prose.ts";

/**
 * A compaction request — the ONE mutation a charter may ask of its
 * thread. Applied by the kernel at the next sampling boundary, never
 * mid-assembly; always recorded, never silent. The frozen head is
 * untouched either way.
 */
export type CompactPlan =
  | {
      /**
       * Drop matching messages from the thread, replaced by a single
       * archived-messages marker (restorable-eviction discipline: the
       * marker says content was removed; nothing is silently rewritten).
       */
      readonly drop: (entry: Prompt.Message, index: number) => boolean;
    }
  | {
      /**
       * Restart the thread as frozen head + `summary` delivered as a
       * situation — the reset-with-handoff pattern. Prefer summaries the
       * MODEL wrote (a `handoff` inline tool): self-authored restatements
       * commit better than kernel-authored ones. A reset clears the
       * thread's delivery logs, so standing state (the current
       * situation) and still-true notes restate themselves into the
       * fresh thread.
       */
      readonly reset: { readonly summary: string };
    };

/**
 * The RUN a charter is executing inside — its world identity and its
 * thread (the conversation). The kernel provides it to INIT (which
 * runs once per run at admit, when the thread already exists — so
 * thread-scoped setup like a workspace checkout keyed by `thread.key`
 * belongs there), to the charter's TURN, and to tool handlers.
 * `AI.Tick` is the one runtime fact init never sees.
 *
 * The asymmetry is the design: `entries` is READ-ONLY and `compact` is
 * the only mutation — the thread stays kernel-owned; the loop gets a
 * lever, not a pen.
 */
export interface ThreadService {
  /**
   * The run's key — caller-chosen world identity (`owner/repo#7`) when
   * admitted with one, kernel-minted otherwise.
   */
  readonly key: string;
  /**
   * ESTIMATED size of the current thread in tokens (chars/4 heuristic —
   * a policy input, not a bill).
   */
  readonly tokens: Effect.Effect<number>;
  /** Read-only access to the thread's messages. */
  readonly entries: Effect.Effect<ReadonlyArray<Prompt.Message>>;
  /** Request compaction; applied at the next sampling boundary. */
  readonly compact: (plan: CompactPlan) => Effect.Effect<void>;
}

export class Thread extends Context.Service<Thread, ThreadService>()(
  "alchemy/AI/Thread",
) {}

/**
 * The current TICK — the sampling iteration of the loop. Provided by
 * the kernel alongside {@link Thread}; carries per-tick facts and the
 * note collector behind {@link say}.
 */
export interface TickService {
  /** Samplings performed so far in this run (0 on the first tick). */
  readonly count: number;
  /**
   * Register a note for delivery (usually via {@link say}). Notes are
   * COLLECTED, not appended: the kernel dedupes them by rendered text
   * against the thread's delivered log, so re-entrant turns never
   * double-say.
   */
  readonly say: (note: Fragment) => Effect.Effect<void>;
}

export class Tick extends Context.Service<Tick, TickService>()(
  "alchemy/AI/Tick",
) {}

/**
 * Say something ONCE — the charter's event channel, beside the stance.
 *
 * Where the returned stance is STANDING STATE (diffed, superseding,
 * restored when it reverts), a `say` is an EVENT: delivered the first
 * time its text appears, never revoked, never restated. Delivery is
 * deduped by rendered content against the current thread — so the
 * turn stays re-entrant (re-running it re-collects the same text and
 * delivers nothing), a CHANGED text is a new event, and a compaction
 * reset re-delivers notes that are still being said (the fresh thread
 * hasn't heard them).
 *
 * ```ts
 * return Effect.gen(function* () {
 *   const n = yield* Ref.get(attempts);
 *   if (n > 0) yield* AI.say`Attempt ${n} of 5 — a failed run parks.`;
 *   return yield* AI.prose`…stance…`;
 * });
 * ```
 *
 * Notes arrive as `<note>` user messages AFTER any situation of the
 * same tick (read the state, then the remark). Mentions in a note
 * render as names but GRANT NOTHING — capability comes from the
 * stance alone.
 */
export const say = <const Refs extends any[]>(
  template: TemplateStringsArray,
  ...refs: Refs
): Effect.Effect<void, never, Tick> =>
  Effect.flatMap(Tick, (tick) =>
    tick.say({
      "~alchemy/Kind": "Fragment",
      template,
      refs,
    }),
  );
