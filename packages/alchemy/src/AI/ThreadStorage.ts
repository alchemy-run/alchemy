/**
 * `ThreadStorage` — WHERE A RUN'S DURABLE FACTS LIVE. This is the driver's
 * storage seam: everything about a run that must survive beyond the
 * current process/isolate goes through one {@link ThreadHandle} —
 * the thread messages (the model's working context), the observation
 * log (the run's own replayable projection), and the run meta (tick,
 * observation cursor, active skills).
 *
 * `DriverCore` is written against this contract and nothing else, so
 * the substrate is a Layer choice, never a driver choice:
 *
 * ```ts
 * AI.DriverCore.pipe(Layer.provide(AI.MemoryThreadStorage))          // ephemeral
 * AI.DriverCore.pipe(Layer.provide(SqliteThreadStorage(".alchemy/runs.db"))) // durable
 * // DO storage implements the same handle inside DriverCloudflare
 * ```
 *
 * What deliberately does NOT live here: waiters, sockets, in-flight
 * work — anything process-shaped. Those belong to the HOST (the
 * resident loop, or the Durable Object burst), not to storage.
 *
 * Messages and observations cross this seam ENCODED (JSON-safe): the
 * contract is storable rows, not live objects.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Prompt from "effect/unstable/ai/Prompt";
import type { RunObservation } from "./Observer.ts";

/** The run facts that ride beside the thread: restored at boot so a
 *  revived run continues its tick count and observation cursor. */
export interface RunMeta {
  /** Samplings performed so far. */
  readonly tick: number;
  /** Next observation seq — restore continues the cursor, so socket
   *  subscribers and chat projections never see a seq collision. */
  readonly observed: number;
  /** Activated skills (effective when the stance also mentions them). */
  readonly active: ReadonlyArray<string>;
}

/** One run's storage — all reads and writes for `${term}/${key}`. */
export interface ThreadHandle {
  /** The persisted meta, or `undefined` if nothing was ever written. */
  readonly meta: Effect.Effect<RunMeta | undefined>;
  readonly putMeta: (meta: RunMeta) => Effect.Effect<void>;
  /** The thread, in order — encoded rows (JSON-safe). */
  readonly messages: Effect.Effect<ReadonlyArray<Prompt.MessageEncoded>>;
  readonly appendMessages: (
    messages: ReadonlyArray<Prompt.MessageEncoded>,
  ) => Effect.Effect<void>;
  /** Replace the whole thread — compaction's one mutation. */
  readonly replaceMessages: (
    messages: ReadonlyArray<Prompt.MessageEncoded>,
  ) => Effect.Effect<void>;
  /**
   * Append one durable observation AND persist the meta whose
   * `observed` cursor accounts for it — one call so implementations
   * can make the pair atomic (a crash between row and cursor must
   * never let a restored run re-issue a used seq).
   */
  readonly appendObservation: (
    observation: RunObservation,
    meta: RunMeta,
  ) => Effect.Effect<void>;
  /** The durable log from a cursor — what a socket's
   *  `subscribe {fromSeq}` replays. */
  readonly observations: (
    fromSeq: number,
  ) => Effect.Effect<ReadonlyArray<RunObservation>>;
}

export class ThreadStorage extends Context.Service<
  ThreadStorage,
  {
    /** Open (or create) one run's handle. */
    readonly open: (term: string, key: string) => Effect.Effect<ThreadHandle>;
    /** Keys with persisted state for one term — the restore surface. */
    readonly keys: (term: string) => Effect.Effect<ReadonlyArray<string>>;
    /** Drop a settled run — settled runs are never restored. */
    readonly remove: (term: string, key: string) => Effect.Effect<void>;
  }
>()("alchemy/AI/ThreadStorage") {}

interface MemoryRun {
  meta: RunMeta | undefined;
  messages: Array<Prompt.MessageEncoded>;
  log: Array<RunObservation>;
}

/**
 * The in-memory `ThreadStorage`: plain Maps, exactly as durable as
 * the process — the default substrate for `DriverCore`. Fresh state
 * per Layer build (layers memoize by reference, so one assembly
 * shares one store).
 */
export const MemoryThreadStorage: Layer.Layer<ThreadStorage> = Layer.sync(
  ThreadStorage,
  () => {
    const runs = new Map<string, MemoryRun>();
    const row = (term: string, key: string): MemoryRun => {
      const id = `${term}\u0000${key}`;
      let run = runs.get(id);
      if (run === undefined) {
        run = { meta: undefined, messages: [], log: [] };
        runs.set(id, run);
      }
      return run;
    };
    return ThreadStorage.of({
      open: (term, key) =>
        Effect.sync(() => {
          const run = row(term, key);
          return {
            meta: Effect.sync(() => run.meta),
            putMeta: (meta) =>
              Effect.sync(() => {
                run.meta = meta;
              }),
            messages: Effect.sync(() => run.messages),
            appendMessages: (messages) =>
              Effect.sync(() => {
                run.messages.push(...messages);
              }),
            replaceMessages: (messages) =>
              Effect.sync(() => {
                run.messages = [...messages];
              }),
            appendObservation: (observation, meta) =>
              Effect.sync(() => {
                run.log.push(observation);
                // ring: mirror the chat projection's eviction policy
                if (run.log.length > 2000) run.log.splice(0, 500);
                run.meta = meta;
              }),
            observations: (fromSeq) =>
              Effect.sync(() =>
                run.log.filter((observation) => observation.seq >= fromSeq),
              ),
          } satisfies ThreadHandle;
        }),
      // a fresh build has no keys (nothing survives the process), but a
      // REUSED instance restores — which is what lets a test drive the
      // restore path without sqlite: build a second driver over the
      // same MemoryThreadStorage value and the parked runs come back
      keys: (term) =>
        Effect.sync(() => {
          const prefix = `${term}\u0000`;
          const found: Array<string> = [];
          for (const [id, run] of runs) {
            if (id.startsWith(prefix) && run.meta !== undefined) {
              found.push(id.slice(prefix.length));
            }
          }
          return found;
        }),
      remove: (term, key) =>
        Effect.sync(() => {
          runs.delete(`${term}\u0000${key}`);
        }),
    });
  },
);
