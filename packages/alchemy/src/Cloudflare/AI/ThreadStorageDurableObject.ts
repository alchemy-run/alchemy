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
import type { SessionObservation } from "../../AI/Events.ts";
import type { Message } from "../../AI/Message.ts";
import {
  contextRef,
  type GenerationRecord,
  type SessionMeta,
  type ThreadHandle,
} from "../../AI/ThreadStorage.ts";
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
/** GenerationRecords, keyed by generation number. */
export const GEN = "gen:";
/** Archived thread rows of closed generations. */
export const ARC = "arc:";
export const META = "meta";

/** Zero-padded so lexical key order IS arrival order. */
export const seqKey = (prefix: string, seq: number) =>
  `${prefix}${String(seq).padStart(12, "0")}`;

export const seqOf = (prefix: string, key: string) =>
  Number(key.slice(prefix.length));

/** `arc:{generation}:{seq}` — both zero-padded, so lexical order is
 *  numeric order within a generation. */
export const arcKey = (generation: number, seq: number) =>
  `${ARC}${String(generation).padStart(12, "0")}:${String(seq).padStart(12, "0")}`;

const arcPrefix = (generation: number) =>
  `${ARC}${String(generation).padStart(12, "0")}:`;

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

/** Inbox row envelope — the identified message plus row flags.
 *  Legacy shapes (`{ input, quiet }` and raw values) are wrapped
 *  with a seq-deterministic id at read. */
interface InboxEnvelope {
  readonly message: Message<unknown>;
  readonly quiet: boolean;
  readonly kind?: "reminder";
}

const isInboxEnvelope = (row: unknown): row is InboxEnvelope =>
  typeof row === "object" &&
  row !== null &&
  "message" in row &&
  typeof (row as { message?: { id?: unknown } }).message?.id === "string" &&
  typeof (row as InboxEnvelope).quiet === "boolean";

/** A pre-Message envelope (`{ input, quiet }`). */
const isLegacyEnvelope = (
  row: unknown,
): row is { readonly input: unknown; readonly quiet: boolean } =>
  typeof row === "object" &&
  row !== null &&
  "input" in row &&
  "quiet" in row &&
  typeof (row as { quiet: unknown }).quiet === "boolean";

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
export const makeThreadStorageDurableObject = (
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
    // the shared fields are REPLACED wholesale (so an absent `busy`
    // clears the marker); only the row bookkeeping (seq, drained)
    // survives from the previous value
    putMeta: Effect.fn(function* (meta) {
      const full = yield* readMeta;
      yield* writeMeta({ ...meta, seq: full.seq, drained: full.drained });
    }),
    putInbox: (message, inboxOptions) =>
      sealed(
        Effect.gen(function* () {
          const full = yield* readMeta;
          // pending-id idempotency: a retried delivery answers the
          // existing row's seq instead of duplicating it
          const rows = yield* listRows<unknown>(INBOX);
          for (const [k, row] of rows) {
            const seq = seqOf(INBOX, k);
            if (seq < full.drained) continue;
            if (isInboxEnvelope(row) && row.message.id === message.id) {
              return seq;
            }
          }
          // one atomic write: a crash can never leave a row the
          // counter would overwrite
          yield* storage
            .put({
              [seqKey(INBOX, full.seq)]: {
                message,
                quiet: inboxOptions?.quiet === true,
                ...(inboxOptions?.kind === undefined
                  ? {}
                  : { kind: inboxOptions.kind }),
              } satisfies InboxEnvelope,
              [META]: {
                ...full,
                seq: full.seq + 1,
              } satisfies DurableSessionMeta,
            })
            .pipe(Effect.orDie);
          return full.seq;
        }),
      ),
    putInboxBatch: (inputs) =>
      sealed(
        Effect.gen(function* () {
          const full = yield* readMeta;
          const pending = new Map<string, number>();
          for (const [k, row] of yield* listRows<unknown>(INBOX)) {
            const seq = seqOf(INBOX, k);
            if (seq < full.drained) continue;
            if (isInboxEnvelope(row)) pending.set(row.message.id, seq);
          }
          // every fresh row AND the advanced counter in ONE storage
          // put — a dispatch's pre-history and its waking input are
          // atomic; rows whose id is already pending answer that seq
          let next = full.seq;
          const entries: Record<string, unknown> = {};
          const seqs = inputs.map((entry) => {
            const known = pending.get(entry.message.id);
            if (known !== undefined) return known;
            const seq = next++;
            pending.set(entry.message.id, seq);
            entries[seqKey(INBOX, seq)] = {
              message: entry.message,
              quiet: entry.quiet === true,
              ...(entry.kind === undefined ? {} : { kind: entry.kind }),
            } satisfies InboxEnvelope;
            return seq;
          });
          if (next > full.seq) {
            entries[META] = {
              ...full,
              seq: next,
            } satisfies DurableSessionMeta;
            yield* storage.put(entries).pipe(Effect.orDie);
          }
          return seqs;
        }),
      ),
    listInbox: sealed(
      Effect.gen(function* () {
        const full = yield* readMeta;
        const rows = yield* listRows<unknown>(INBOX);
        return rows.flatMap(([k, row]) => {
          const seq = seqOf(INBOX, k);
          if (seq < full.drained) return [];
          // envelope rows carry the flags; legacy rows (either the
          // pre-Message envelope or a raw value) wrap with a
          // seq-deterministic id so re-reads agree
          if (isInboxEnvelope(row)) {
            return [
              {
                seq,
                message: row.message,
                quiet: row.quiet,
                ...(row.kind === undefined ? {} : { kind: row.kind }),
              },
            ];
          }
          const legacy = isLegacyEnvelope(row)
            ? { content: row.input, quiet: row.quiet }
            : { content: row, quiet: false };
          return [
            {
              seq,
              message: { id: `m-legacy-${seq}`, content: legacy.content },
              quiet: legacy.quiet,
            },
          ];
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
    // the ledgered replace: archived copies of the current surface,
    // the record, the new surface, and the seq — ONE put (plus the
    // old rows' delete), landed together by workerd's output gate
    advanceGeneration: (advance) =>
      sealed(
        Effect.gen(function* () {
          // identity is lazy: the plan-time mock state has no id
          const name = String(state.id.name);
          const slash = name.indexOf("/");
          const term = slash < 0 ? name : name.slice(0, slash);
          const key = slash < 0 ? name : name.slice(slash + 1);
          const meta = yield* readMeta;
          const records = yield* listRows<GenerationRecord>(GEN);
          const tip =
            records.length === 0
              ? 0
              : records[records.length - 1]![1].generation;
          const current = yield* listRows<Prompt.MessageEncoded>(MSG);
          const entries: Record<string, unknown> = {};
          for (const [k, message] of current) {
            entries[arcKey(tip, seqOf(MSG, k))] = message;
          }
          const generation = tip + 1;
          const record: GenerationRecord = {
            ref: contextRef(term, key, generation),
            generation,
            parent: advance.parent ?? contextRef(term, key, tip),
            author: advance.author,
            kind: advance.kind,
            ...(advance.doc === undefined ? {} : { doc: advance.doc }),
            dropped: advance.dropped,
            tokensBefore: advance.tokensBefore,
            tokensAfter: advance.tokensAfter,
            at: Date.now(),
          };
          entries[seqKey(GEN, generation)] = record;
          let seq = 0;
          for (const message of advance.surface) {
            entries[seqKey(MSG, seq++)] = message;
          }
          entries[META] = { ...meta, seq } satisfies DurableSessionMeta;
          // mirror replaceMessages: old rows deleted, then the batch
          if (current.length > 0) {
            yield* storage.delete(current.map(([k]) => k)).pipe(Effect.orDie);
          }
          yield* storage.put(entries).pipe(Effect.orDie);
          return record;
        }),
      ),
    lineage: Effect.map(listRows<GenerationRecord>(GEN), (rows) =>
      rows.map(([, record]) => record).reverse(),
    ),
    messagesAt: (generation) =>
      sealed(
        Effect.gen(function* () {
          const records = yield* listRows<GenerationRecord>(GEN);
          const tip =
            records.length === 0
              ? 0
              : records[records.length - 1]![1].generation;
          const rows =
            generation === tip
              ? yield* listRows<Prompt.MessageEncoded>(MSG)
              : yield* listRows<Prompt.MessageEncoded>(arcPrefix(generation));
          return rows.map(([, message]) => message);
        }),
      ),
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
              [META]: {
                ...meta,
                seq: full.seq,
                drained: full.drained,
              } satisfies DurableSessionMeta,
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
    // seqs are minted by the meta's `observed` cursor, never by row
    // scans — a deleted seq is retired forever, so redaction cannot
    // collide with future appends
    deleteObservations: (seqs) =>
      seqs.length === 0
        ? Effect.void
        : sealed(
            storage
              .delete(seqs.map((seq) => seqKey(OBS, seq)))
              .pipe(Effect.orDie, Effect.asVoid),
          ),
  };

  return { readMeta, writeMeta, listRows, appendThread, handle };
};
