import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
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
       * Restart the thread from `summary` alone — the
       * reset-with-handoff pattern. Prefer summaries the MODEL wrote
       * (a `handoff` inline tool): self-authored restatements commit
       * better than kernel-authored ones. A reset clears the thread's
       * say log, so still-true notes re-deliver into the fresh thread;
       * the system prompt (the turn's render) needs no restating — it
       * is delivered whole at every sampling.
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
  /**
   * ANSWER the current round: resolve every pending dispatch waiter
   * with `value`, from wherever the answer is actually produced (a
   * tool handler, usually — the moment the artifact exists). Replying
   * does NOT park or end the run: the model may keep working; parking
   * stays quiescence, ending stays `settle`. A round that never
   * replies answers with its quiescent text (the fallback). Waiters
   * are a batch: every caller currently awaiting this run receives
   * the same value.
   */
  readonly reply: (value: unknown) => Effect.Effect<void>;
  /**
   * Schedule a note to THIS run's future self. Returns immediately —
   * the note is DATA `(fireAt, text)`, delivered as an ordinary inbox
   * message at fireAt: a wake if the run is parked by then, a queued
   * message if busy, dropped if settled. The clock is the KERNEL's
   * and lives exactly as long as the run does: a fiber on the
   * in-memory kernel (runs are process-lifetime there), a Durable
   * Object alarm on a durable kernel.
   */
  readonly remind: (delay: Duration.Input, note: string) => Effect.Effect<void>;
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
 * Say something — append one message to the thread, delivered before
 * this tick's sampling. A PLAIN effect: no dedupe, no memory, no
 * kernel judgment — calling it is delivering it, so the author's
 * CONDITION is the whole delivery policy. Guard it like any other
 * side effect:
 *
 * ```ts
 * return Effect.gen(function* () {
 *   const { count } = yield* AI.Tick;
 *   if (count === 30) {
 *     yield* AI.say`30 of 40 samplings spent — converge now.`;
 *   }
 *   return yield* AI.prose`…stance…`;
 * });
 * ```
 *
 * (An unguarded `say` in a turn delivers EVERY tick — occasionally
 * what you want, usually not. The kernel clears collected says on a
 * retried turn attempt, so transient retries never double-deliver.)
 *
 * Notes arrive as `<note>` user messages, in emission order — the ONE
 * explicit injection channel: every message in the thread traces to a
 * `say` call site, a tool result, or a steer from the world. Mentions
 * in a note render as names but GRANT NOTHING — capability comes from
 * the stance alone.
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

/**
 * Answer the current round from wherever the answer is produced —
 * usually the tool handler that just created the artifact:
 *
 * ```ts
 * const openPullRequest = yield* AI.Tool("open_pull_request")`…`(
 *   Effect.fn(function* (params) {
 *     const pull = yield* open(params);
 *     yield* AI.reply(pull.ref);   // ← the caller has its answer NOW
 *     return `opened ${pull.url} — wrap up or keep working`;
 *   }),
 * );
 * ```
 *
 * Replying neither parks nor ends the run — the model may continue
 * (clean up, comment, start CI); parking stays quiescence, ending
 * stays `settle`. A round that never replies answers with its
 * quiescent text.
 */
export const reply = (value: unknown): Effect.Effect<void, never, Thread> =>
  Effect.flatMap(Thread, (thread) => thread.reply(value));
