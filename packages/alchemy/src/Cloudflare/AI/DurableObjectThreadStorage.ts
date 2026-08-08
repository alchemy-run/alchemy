/**
 * `AI.ThreadStorage` over DURABLE OBJECT storage — the substrate half
 * of the Cloudflare driver: one DO instance IS one session, so this
 * module implements a single session's {@link ThreadHandle} over the
 * instance's own storage rows, plus the host-level accessors (meta,
 * inbox, reminders) the burst host needs beyond the shared contract.
 *
 * Storage layout (one session per DO):
 *
 * ```
 * inbox:{seq}      pending inputs, drained per burst
 * msg:{seq}        thread messages, appended (the transcript)
 * obs:{seq}        durable observations — the session's own
 *                  projection, replayable from any cursor
 * remind:{fireAt}  scheduled notes (the alarm re-arms from these)
 * meta             { tick, observed, active[], settled?, seq,
 *                    drained, busy? }
 * ```
 *
 * Writes that must be atomic (a message batch + its seq bump, an
 * observation + its cursor) go through ONE `storage.put(entries)` —
 * workerd's output gate makes the pair durable before anything
 * leaves the DO.
 */
import * as Effect from "effect/Effect";
import * as Prompt from "effect/unstable/ai/Prompt";
import type { SessionObservation } from "../../AI/Observer.ts";
import type { SessionMeta, ThreadHandle } from "../../AI/ThreadStorage.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { DurableObjectState } from "../Workers/DurableObjectState.ts";

/**
 * DO storage is a RUNTIME capability, but the shared `ThreadHandle`
 * contract is plain effects — and this object is only ever
 * constructed inside a DO, where every read/write happens inside an
 * event that satisfies the capability. Seal once here rather than
 * threading the phantom through every storage site.
 */
const sealed = <A, E>(
  effect: Effect.Effect<A, E, RuntimeContext>,
): Effect.Effect<A, E> => Effect.provide(effect, RuntimeContext.phantom);

export const INBOX = "inbox:";
export const MSG = "msg:";
export const OBS = "obs:";
export const REMIND = "remind:";
export const META = "meta";

/** Zero-padded so lexical key order IS arrival order. */
export const seqKey = (prefix: string, seq: number) =>
  `${prefix}${String(seq).padStart(12, "0")}`;

export const seqOf = (prefix: string, key: string) =>
  Number(key.slice(prefix.length));

/**
 * The DO session's full meta — the shared {@link SessionMeta} (which
 * carries the liveness marker and the settled outcome) plus this
 * substrate's row bookkeeping.
 */
export interface DurableSessionMeta extends SessionMeta {
  /** Next row seq (shared by message and inbox rows). */
  readonly seq: number;
  /**
   * The drain WATERMARK: inbox rows below this seq are already in the
   * thread. Inputs are appended (with this watermark advanced, in one
   * atomic write) BEFORE their inbox rows are deleted, so a crash
   * between the two redelivers rows the watermark tells us to discard
   * — at-least-once drain, exactly-once append.
   */
  readonly drained: number;
}

export const emptyMeta: DurableSessionMeta = {
  tick: 0,
  observed: 0,
  active: [],
  seq: 0,
  drained: 0,
};

export interface DurableObjectSessionStorage {
  readonly readMeta: Effect.Effect<DurableSessionMeta>;
  readonly writeMeta: (meta: DurableSessionMeta) => Effect.Effect<void>;
  readonly listRows: <A>(prefix: string) => Effect.Effect<Array<[string, A]>>;
  /** Append thread rows + bump the message seq, atomically. */
  readonly appendThread: (
    messages: ReadonlyArray<Prompt.MessageEncoded>,
  ) => Effect.Effect<void>;
  /** The shared storage contract, over this DO's rows. */
  readonly handle: ThreadHandle;
}

/**
 * One session's storage over its own Durable Object. Building the
 * object only captures `state`; storage is touched lazily inside
 * request-time effects (the DO constructor also runs at PLAN time,
 * against a mock state).
 */
export const makeDurableObjectSessionStorage = (
  state: DurableObjectState["Service"],
): DurableObjectSessionStorage => {
  const storage = state.storage;

  const readMeta = sealed(
    Effect.map(
      storage.get<DurableSessionMeta>(META).pipe(Effect.orDie),
      (found) => found ?? emptyMeta,
    ),
  );
  const writeMeta = (meta: DurableSessionMeta) =>
    sealed(storage.put(META, meta).pipe(Effect.orDie));

  const listRows = <A>(prefix: string) =>
    sealed(
      storage.list<A>({ prefix }).pipe(
        Effect.orDie,
        Effect.map((map) => [...map.entries()]),
      ),
    );

  const appendThread = (messages: ReadonlyArray<Prompt.MessageEncoded>) =>
    sealed(
      Effect.gen(function* () {
        if (messages.length === 0) return;
        const meta = yield* readMeta;
        const entries: Record<string, unknown> = {};
        let seq = meta.seq;
        for (const message of messages) {
          entries[seqKey(MSG, seq++)] = message;
        }
        // rows + seq in ONE put: no crash point between them
        entries[META] = { ...meta, seq } satisfies DurableSessionMeta;
        yield* storage.put(entries).pipe(Effect.orDie);
      }),
    );

  const handle: ThreadHandle = {
    meta: sealed(
      Effect.map(
        storage.get<DurableSessionMeta>(META).pipe(Effect.orDie),
        (found) =>
          found === undefined
            ? undefined
            : {
                tick: found.tick,
                observed: found.observed,
                active: found.active,
                busy: found.busy,
                settled: found.settled,
              },
      ),
    ),
    // the shared fields merge into the superset row — the row
    // bookkeeping (seq, drained) is never touched here
    putMeta: (meta) =>
      Effect.gen(function* () {
        const full = yield* readMeta;
        yield* writeMeta({ ...full, ...meta });
      }),
    putInbox: (input) =>
      sealed(
        Effect.gen(function* () {
          const full = yield* readMeta;
          // one atomic write: a crash can never leave a row the
          // counter would overwrite
          yield* storage
            .put({
              [seqKey(INBOX, full.seq)]: input,
              [META]: {
                ...full,
                seq: full.seq + 1,
              } satisfies DurableSessionMeta,
            })
            .pipe(Effect.orDie);
          return full.seq;
        }),
      ),
    listInbox: sealed(
      Effect.gen(function* () {
        const full = yield* readMeta;
        const rows = yield* listRows<unknown>(INBOX);
        return rows.flatMap(([k, input]) => {
          const seq = seqOf(INBOX, k);
          return seq >= full.drained ? [{ seq, input }] : [];
        });
      }),
    ),
    deleteInbox: (seqs) =>
      seqs.length === 0
        ? Effect.void
        : sealed(
            storage
              .delete(seqs.map((seq) => seqKey(INBOX, seq)))
              .pipe(Effect.orDie, Effect.asVoid),
          ),
    // the ATOMIC ADMIT: thread rows + watermark + meta in ONE put
    admit: ({ messages, drainedTo, meta }) =>
      sealed(
        Effect.gen(function* () {
          const full = yield* readMeta;
          const entries: Record<string, unknown> = {};
          let seq = full.seq;
          for (const message of messages) {
            entries[seqKey(MSG, seq++)] = message;
          }
          entries[META] = {
            ...full,
            ...meta,
            seq,
            drained: drainedTo,
          } satisfies DurableSessionMeta;
          yield* storage.put(entries).pipe(Effect.orDie);
        }),
      ),
    messages: Effect.map(listRows<Prompt.MessageEncoded>(MSG), (rows) =>
      rows.map(([, message]) => message),
    ),
    appendMessages: appendThread,
    replaceMessages: (messages) =>
      sealed(
        Effect.gen(function* () {
          const existing = yield* listRows<unknown>(MSG);
          if (existing.length > 0) {
            yield* storage.delete(existing.map(([k]) => k)).pipe(Effect.orDie);
          }
          const meta = yield* readMeta;
          const entries: Record<string, unknown> = {};
          let seq = 0;
          for (const message of messages) {
            entries[seqKey(MSG, seq++)] = message;
          }
          entries[META] = { ...meta, seq } satisfies DurableSessionMeta;
          yield* storage.put(entries).pipe(Effect.orDie);
        }),
      ),
    // the observation row and its cursor land in ONE atomic write —
    // a restored session can never re-issue a used seq
    appendObservation: (observation, meta) =>
      sealed(
        Effect.gen(function* () {
          const full = yield* readMeta;
          yield* storage
            .put({
              [seqKey(OBS, observation.seq)]: observation,
              [META]: { ...full, ...meta } satisfies DurableSessionMeta,
            })
            .pipe(Effect.orDie);
        }),
      ),
    observations: (fromSeq) =>
      Effect.map(listRows<SessionObservation>(OBS), (rows) =>
        rows.flatMap(([k, observation]) =>
          seqOf(OBS, k) >= fromSeq ? [observation] : [],
        ),
      ),
  };

  return { readMeta, writeMeta, listRows, appendThread, handle };
};
