/**
 * `ThreadStorage` — WHERE A SESSION'S DURABLE FACTS LIVE. This is the driver's
 * storage seam: everything about a session that must survive beyond the
 * current process/isolate goes through one {@link ThreadHandle} —
 * the thread messages (the model's working context), the observation
 * log (the session's own replayable projection), and the session meta (tick,
 * observation cursor, active skills).
 *
 * `DriverCore` is written against this contract and nothing else, so
 * the substrate is a Layer choice, never a driver choice:
 *
 * ```ts
 * AI.DriverCore.pipe(Layer.provide(AI.MemoryThreadStorage))          // ephemeral
 * AI.DriverCore.pipe(Layer.provide(SqliteThreadStorage(".alchemy/sessions.db"))) // durable
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
import type { SessionObservation } from "./Observer.ts";

/** The session facts that ride beside the thread: restored at boot so a
 *  revived session continues its tick count and observation cursor. */
export interface SessionMeta {
  /** Samplings performed so far. */
  readonly tick: number;
  /** Next observation seq — restore continues the cursor, so socket
   *  subscribers and chat projections never see a seq collision. */
  readonly observed: number;
  /** Activated skills (effective when the stance also mentions them). */
  readonly active: ReadonlyArray<string>;
}

/** One session's storage — all reads and writes for `${term}/${key}`. */
export interface ThreadHandle {
  /** The persisted meta, or `undefined` if nothing was ever written. */
  readonly meta: Effect.Effect<SessionMeta | undefined>;
  readonly putMeta: (meta: SessionMeta) => Effect.Effect<void>;
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
   * never let a restored session re-issue a used seq).
   */
  readonly appendObservation: (
    observation: SessionObservation,
    meta: SessionMeta,
  ) => Effect.Effect<void>;
  /** The durable log from a cursor — what a socket's
   *  `subscribe {fromSeq}` replays. */
  readonly observations: (
    fromSeq: number,
  ) => Effect.Effect<ReadonlyArray<SessionObservation>>;
}

export class ThreadStorage extends Context.Service<
  ThreadStorage,
  {
    /** Open (or create) one session's handle. */
    readonly open: (term: string, key: string) => Effect.Effect<ThreadHandle>;
    /** Keys with persisted state for one term — the restore surface. */
    readonly keys: (term: string) => Effect.Effect<ReadonlyArray<string>>;
    /** Drop a settled session — settled sessions are never restored. */
    readonly remove: (term: string, key: string) => Effect.Effect<void>;
  }
>()("alchemy/AI/ThreadStorage") {}

interface MemorySession {
  meta: SessionMeta | undefined;
  messages: Array<Prompt.MessageEncoded>;
  log: Array<SessionObservation>;
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
    const sessions = new Map<string, MemorySession>();
    const row = (term: string, key: string): MemorySession => {
      const id = `${term}\u0000${key}`;
      let session = sessions.get(id);
      if (session === undefined) {
        session = { meta: undefined, messages: [], log: [] };
        sessions.set(id, session);
      }
      return session;
    };
    return ThreadStorage.of({
      open: (term, key) =>
        Effect.sync(() => {
          const session = row(term, key);
          return {
            meta: Effect.sync(() => session.meta),
            putMeta: (meta) =>
              Effect.sync(() => {
                session.meta = meta;
              }),
            messages: Effect.sync(() => session.messages),
            appendMessages: (messages) =>
              Effect.sync(() => {
                session.messages.push(...messages);
              }),
            replaceMessages: (messages) =>
              Effect.sync(() => {
                session.messages = [...messages];
              }),
            appendObservation: (observation, meta) =>
              Effect.sync(() => {
                session.log.push(observation);
                // ring: mirror the chat projection's eviction policy
                if (session.log.length > 2000) session.log.splice(0, 500);
                session.meta = meta;
              }),
            observations: (fromSeq) =>
              Effect.sync(() =>
                session.log.filter((observation) => observation.seq >= fromSeq),
              ),
          } satisfies ThreadHandle;
        }),
      // a fresh build has no keys (nothing survives the process), but a
      // REUSED instance restores — which is what lets a test drive the
      // restore path without sqlite: build a second driver over the
      // same MemoryThreadStorage value and the parked sessions come back
      keys: (term) =>
        Effect.sync(() => {
          const prefix = `${term}\u0000`;
          const found: Array<string> = [];
          for (const [id, session] of sessions) {
            if (id.startsWith(prefix) && session.meta !== undefined) {
              found.push(id.slice(prefix.length));
            }
          }
          return found;
        }),
      remove: (term, key) =>
        Effect.sync(() => {
          sessions.delete(`${term}\u0000${key}`);
        }),
    });
  },
);
