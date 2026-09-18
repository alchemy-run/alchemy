import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Prompt from "effect/unstable/ai/Prompt";
import type { SessionObservation } from "./Events.ts";
import type { Message } from "./Message.ts";

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
   * wall-clock). `invocations` are the messages this round has
   * admitted — persisted with the marker so `Thread.invocations`
   * survives a crash-recovery re-entry.
   */
  readonly busy?: {
    readonly attempts: number;
    readonly since: number;
    readonly invocations?: ReadonlyArray<Message<unknown>>;
  };
  /** The settled outcome — a settled session answers late dispatches
   *  with it and is never restored. */
  readonly settled?: { readonly outcome: unknown };
}

/** One pending inbox row — an identified {@link Message}, normalized
 *  at the door (`Sessions.send`/`dispatch`, a steer, a socket
 *  submit): bare strings and event payloads are wrapped with a
 *  minted id before they land here. */
export interface InboxRow {
  readonly seq: number;
  readonly message: Message<unknown>;
  /** QUIET inputs (`send(…, { wake: false })`) join whatever round
   *  happens anyway but never open one — a parked session stays
   *  parked with these accumulating as context. */
  readonly quiet?: boolean;
  /** Structural provenance riding the row (a `Thread.remind`
   *  delivery) — surfaces on the `input` observation, never parsed
   *  from text. */
  readonly kind?: "reminder";
}

/**
 * Stable address of one GENERATION of a session's context:
 * `"<term>/<key>@<n>"` — usable in URLs, pane tokens, and
 * `Sessions.branch` calls. The chain of generations is the session's
 * context history, git-shaped: each generation is immutable, points
 * at its parent, and carries the distilled doc that opened it.
 */
export const contextRef = (term: string, key: string, generation: number) =>
  `${term}/${key}@${generation}`;

/** Split a {@link contextRef} back into its parts. */
export const parseContextRef = (
  ref: string,
): { term: string; key: string; generation: number } | undefined => {
  const at = ref.lastIndexOf("@");
  const slash = ref.indexOf("/");
  if (at <= slash || slash < 0) return undefined;
  const generation = Number(ref.slice(at + 1));
  if (!Number.isInteger(generation) || generation < 0) return undefined;
  return {
    term: ref.slice(0, slash),
    key: ref.slice(slash + 1, at),
    generation,
  };
};

/**
 * One link in a session's context chain — written when compaction
 * closes a generation and opens the next. Generation 0 is the
 * session's birth and has no record (an empty lineage = still on the
 * birth generation). The record is the INTROSPECTABLE unit: the UI's
 * generation rail renders `doc`, and `messagesAt` recovers what the
 * generation shadowed — nothing is destroyed, the surface is
 * re-pointed.
 */
export interface GenerationRecord {
  /** This generation's address — `contextRef(term, key, generation)`. */
  readonly ref: string;
  readonly generation: number;
  /** The previous generation's ref — or, for a branch birth, the
   *  FOREIGN ref this session was seeded from. */
  readonly parent: string | undefined;
  /** Who advanced it: a policy name (`"observational"`), `"charter"`
   *  (an explicit `thread.compact`), or `"branch"`. */
  readonly author: string;
  readonly kind: "drop" | "reset" | "observe" | "reflect" | "branch";
  /** The distilled artifact this generation opens with (summary or
   *  observation log). */
  readonly doc?: string;
  /** How many messages of the parent generation were shadowed. */
  readonly dropped: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly at: number;
}

/** One session's storage — all reads and writes for `${term}/${key}`. */
export interface ThreadHandle {
  /** The persisted meta, or `undefined` if nothing was ever written. */
  readonly meta: Effect.Effect<SessionMeta | undefined>;
  readonly putMeta: (meta: SessionMeta) => Effect.Effect<void>;
  /**
   * Durably queue one message, returning its inbox seq — the engine
   * pairs in-flight waiters to their inputs by this seq. IDEMPOTENT
   * on the message id against PENDING rows: queuing an id already in
   * the inbox answers the existing row's seq instead of duplicating
   * it (a caller retrying a delivery after a crash sends once).
   */
  readonly putInbox: (
    message: Message<unknown>,
    options?: { readonly quiet?: boolean; readonly kind?: "reminder" },
  ) => Effect.Effect<number>;
  /**
   * Durably queue SEVERAL messages in ONE write (one storage put on
   * the durable placement — a dispatch's pre-history plus its waking
   * input land atomically, in order). Answers each row's seq, in
   * input order, with the same pending-id idempotency as `putInbox`.
   */
  readonly putInboxBatch: (
    inputs: ReadonlyArray<{
      readonly message: Message<unknown>;
      readonly quiet?: boolean;
      readonly kind?: "reminder";
    }>,
  ) => Effect.Effect<ReadonlyArray<number>>;
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
  /** Replace the whole thread — compaction's one mutation. Prefer
   *  {@link advanceGeneration}, which replaces AND keeps the shadowed
   *  rows addressable; this remains for callers that intend true
   *  destruction. */
  readonly replaceMessages: (
    messages: ReadonlyArray<Prompt.MessageEncoded>,
  ) => Effect.Effect<void>;
  /**
   * Compaction's ledgered mutation: archive the current surface under
   * the current generation number, install `surface` as the new
   * current messages, and append the {@link GenerationRecord} for the
   * new generation — atomically. Returns the record (with `ref` and
   * `parent` filled in by the storage, which knows term/key and the
   * prior tip). `parent` in the options overrides the computed parent
   * for branch births seeded from a FOREIGN session.
   */
  readonly advanceGeneration: (options: {
    readonly author: string;
    readonly kind: GenerationRecord["kind"];
    readonly doc?: string;
    readonly dropped: number;
    readonly tokensBefore: number;
    readonly tokensAfter: number;
    readonly parent?: string;
    readonly surface: ReadonlyArray<Prompt.MessageEncoded>;
  }) => Effect.Effect<GenerationRecord>;
  /** The context chain, TIP FIRST (empty = still on generation 0). */
  readonly lineage: Effect.Effect<ReadonlyArray<GenerationRecord>>;
  /**
   * The raw messages of any generation — the archived rows for a
   * closed generation, the live surface for the tip. Unknown
   * generations answer empty.
   */
  readonly messagesAt: (
    generation: number,
  ) => Effect.Effect<ReadonlyArray<Prompt.MessageEncoded>>;
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
  /**
   * REDACT rows from the observation log — the operator deleting
   * messages from a transcript. Projection-only: the thread messages
   * (the model's working context) are untouched; compaction owns
   * those. Unknown seqs are ignored.
   */
  readonly deleteObservations: (
    seqs: ReadonlyArray<number>,
  ) => Effect.Effect<void>;
}

export interface ThreadStorageService {
  /** Open (or create) one session's handle. */
  readonly open: (term: string, key: string) => Effect.Effect<ThreadHandle>;
  /** Keys with persisted state for one term — the restore surface. */
  readonly keys: (term: string) => Effect.Effect<ReadonlyArray<string>>;
  /** Drop one session's rows entirely. */
  readonly remove: (term: string, key: string) => Effect.Effect<void>;
}

/**
 * WHERE A SESSION'S DURABLE FACTS LIVE — the driver's storage seam:
 * everything about a session that must survive beyond the current
 * process/isolate goes through one {@link ThreadHandle} — the thread
 * messages (the model's working context), the inbox (atomic admit),
 * the observation log (the session's replayable projection), and the
 * session meta (tick, observation cursor, active skills, liveness).
 *
 * The loop is written against this contract and nothing else, so the
 * substrate is a Layer choice, never a driver choice:
 *
 * ```ts
 * AI.DriverLocal.pipe(Layer.provide(AI.ThreadStorageMemory))   // ephemeral
 * AI.DriverLocal.pipe(
 *   Layer.provide(ThreadStorageSqlite(".alchemy/sessions.db")), // durable
 * )
 * // DO storage implements the same handle inside DriverCloudflare
 * ```
 *
 * What deliberately does NOT live here: waiters, sockets, in-flight
 * work — anything process-shaped. Those belong to the Driver (the
 * resident loop, or the Durable Object burst), not to storage.
 *
 * Messages and observations cross this seam ENCODED (JSON-safe): the
 * contract is storable rows, not live objects.
 */
export class ThreadStorage extends Context.Service<
  ThreadStorage,
  ThreadStorageService
>()("alchemy/AI/ThreadStorage") {}
