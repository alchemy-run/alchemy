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
import type { SessionObservation } from "./EventStream.ts";

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
  /**
   * The round LIVENESS marker: present while a round is owed a reply,
   * cleared at quiescence. An engine that finds it set on entry knows
   * the previous attempt DIED mid-round — eviction, restart, or crash,
   * all indistinguishable on disk and all recovered the same way.
   * `attempts` counts consecutive re-entries on the SAME round; any
   * completed sampling resets it (progress-keyed budgets, not
   * wall-clock).
   */
  readonly busy?: { readonly attempts: number; readonly since: number };
  /** The settled outcome — a settled session answers late dispatches
   *  with it and is never restored. */
  readonly settled?: { readonly outcome: unknown };
}

/** One pending inbox row. */
export interface InboxRow {
  readonly seq: number;
  readonly input: unknown;
  /** QUIET inputs (`send(…, { wake: false })`) join whatever round
   *  happens anyway but never open one — a parked session stays
   *  parked with these accumulating as context. */
  readonly quiet?: boolean;
}

/** One session's storage — all reads and writes for `${term}/${key}`. */
export interface ThreadHandle {
  /** The persisted meta, or `undefined` if nothing was ever written. */
  readonly meta: Effect.Effect<SessionMeta | undefined>;
  readonly putMeta: (meta: SessionMeta) => Effect.Effect<void>;
  /**
   * Durably queue one input, returning its inbox seq — the engine
   * pairs in-flight waiters to their inputs by this seq.
   */
  readonly putInbox: (
    input: unknown,
    options?: { readonly quiet?: boolean },
  ) => Effect.Effect<number>;
  /** Pending inbox rows at or above the drain watermark, in order. */
  readonly listInbox: Effect.Effect<ReadonlyArray<InboxRow>>;
  /** Drop consumed inbox rows (best-effort — the watermark already
   *  guards against re-admission). */
  readonly deleteInbox: (seqs: ReadonlyArray<number>) => Effect.Effect<void>;
  /**
   * The ATOMIC ADMIT — the crash-consistency heart of the drain:
   * append the admitted inputs to the thread, advance the inbox
   * watermark past them, and persist the meta (typically opening the
   * round's busy marker), in ONE write. Every crash point around it
   * converges: rows below the watermark are never re-admitted; rows
   * not yet admitted redeliver.
   */
  readonly admit: (options: {
    readonly messages: ReadonlyArray<Prompt.MessageEncoded>;
    readonly drainedTo: number;
    readonly meta: SessionMeta;
  }) => Effect.Effect<void>;
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

export interface ThreadStorageService {
  /** Open (or create) one session's handle. */
  readonly open: (term: string, key: string) => Effect.Effect<ThreadHandle>;
  /** Keys with persisted state for one term — the restore surface. */
  readonly keys: (term: string) => Effect.Effect<ReadonlyArray<string>>;
  /** Drop one session's rows entirely. */
  readonly remove: (term: string, key: string) => Effect.Effect<void>;
}

export class ThreadStorage extends Context.Service<
  ThreadStorage,
  ThreadStorageService
>()("alchemy/AI/ThreadStorage") {}

interface MemorySession {
  meta: SessionMeta | undefined;
  messages: Array<Prompt.MessageEncoded>;
  log: Array<SessionObservation>;
  inbox: Array<InboxRow>;
  inboxSeq: number;
  drained: number;
}

/**
 * One in-memory `ThreadStorage` instance: plain Maps, exactly as
 * durable as the process. Also what hosts hand ephemeral sessions
 * (a spawn worker inside a Durable Object).
 */
export const makeMemoryThreadStorage = (): ThreadStorageService => {
  {
    const sessions = new Map<string, MemorySession>();
    const row = (term: string, key: string): MemorySession => {
      const id = `${term}\u0000${key}`;
      let session = sessions.get(id);
      if (session === undefined) {
        session = {
          meta: undefined,
          messages: [],
          log: [],
          inbox: [],
          inboxSeq: 0,
          drained: 0,
        };
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
            putInbox: (input, inboxOptions) =>
              Effect.sync(() => {
                const seq = session.inboxSeq++;
                session.inbox.push({
                  seq,
                  input,
                  quiet: inboxOptions?.quiet === true,
                });
                return seq;
              }),
            listInbox: Effect.sync(() =>
              session.inbox.filter(
                (inboxRow) => inboxRow.seq >= session.drained,
              ),
            ),
            deleteInbox: (seqs) =>
              Effect.sync(() => {
                const drop = new Set(seqs);
                session.inbox = session.inbox.filter(
                  (inboxRow) => !drop.has(inboxRow.seq),
                );
              }),
            admit: ({ messages, drainedTo, meta }) =>
              Effect.sync(() => {
                session.messages.push(...messages);
                session.drained = drainedTo;
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
  }
};

/**
 * The in-memory `ThreadStorage` Layer — the default substrate for
 * `DriverLocal`. Fresh state per Layer build (layers memoize by
 * reference, so one assembly shares one store).
 */
export const MemoryThreadStorage: Layer.Layer<ThreadStorage> = Layer.sync(
  ThreadStorage,
  makeMemoryThreadStorage,
);
