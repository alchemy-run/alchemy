import type { HttpEffect } from "alchemy/Http";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Scope } from "effect/Scope";
import type * as Stream from "effect/Stream";
import * as Aggregate from "./Aggregate.ts";
import type { Plan } from "./Backfill.ts";
import type { ReplayInput, ReplayResult } from "./CatchUp.ts";
import type * as Decision from "./Decision.ts";
import { ModelHostedTwice } from "./DefinitionError.ts";
import { DefinitionError } from "./internal.ts";
import type * as Policy from "./Policy.ts";
import type * as Projection from "./Projection.ts";
import type * as DomainStream from "./Stream.ts";
import { TraceJson } from "./Telemetry.ts";
import type * as View from "./View.ts";

/**
 * Capture the services `R` for later use, minus the `Scope`: a captured
 * construction-time scope must never replace the scope of a later request or
 * event (finalizers would attach to the wrong lifetime, and on workerd the
 * work would be pinned to another request's I/O context). Platforms that host
 * a model call this when they are built.
 */
export const captureContext = <R = never>(): Effect.Effect<
  Context.Context<Exclude<R, Scope>>,
  never,
  R
> =>
  Effect.map(
    Effect.context<R>(),
    (context) => Context.omit(Scope)(context) as Context.Context<Exclude<R, Scope>>,
  );

/**
 * Everything a platform persists or sends is plain JSON. The kernel owns the
 * schemas; platforms only move and store these values.
 */
export type Json = unknown;

/**
 * An event envelope in JSON form. `at` is epoch milliseconds.
 */
export const EnvelopeJson = Schema.Struct({
  ...Aggregate.Envelope.fields,
  at: Schema.Number,
  /** Absent on events stored before correlation ids: the command id stands in. */
  correlationId: Schema.optionalKey(Schema.String),
  /** The span that committed the event, so its reactions continue or link to it. */
  trace: Schema.optionalKey(TraceJson),
  /**
   * Set on a compaction's roll-up: the instance's version before it. A view
   * key that already holds events of the instance keeps the roll-up without
   * folding it (see {@link ViewInput.covered}).
   */
  rollup: Schema.optionalKey(Schema.Number),
});
export type EnvelopeJson = typeof EnvelopeJson.Type;

/**
 * A committed event as stored by an aggregate.
 */
export interface StoredEvent {
  readonly event: Json;
  readonly envelope: EnvelopeJson;
}

/**
 * A unit of work routed from one host to another: an event (from an aggregate
 * or a view) to a view or policy. Deliveries are at least once; targets drop
 * duplicates by `(source, seq)`. Platforms must deliver in order per
 * `(source, target)`.
 */
export interface Delivery {
  readonly target: {
    readonly kind: "view" | "policy" | "projection";
    readonly name: string;
    /** The consumer's generation (see `Kernel.generationOf`), when it has been rebuilt. */
    readonly generation?: number;
    /** Rebuilt in the storage it had (see `Kernel.inPlace`): its id says `@` for `#`. */
    readonly inPlace?: boolean;
  };
  /** The target partition: a key's id, or the source stream for an unkeyed policy. */
  readonly key: string;
  /** Named routes (from `keyOf`) the event takes into this key; absent for the default route. */
  readonly routes?: ReadonlyArray<string>;
  /** The source stream, e.g. `Account/a-1` or `Statement/a-1`. */
  readonly source: string;
  /** The event's sequence number in its source stream. */
  readonly seq: number;
  /** The aggregate or view that produced the event. */
  readonly origin: string;
  readonly tag: string;
  readonly event: Json;
  readonly envelope: EnvelopeJson;
  /** For an event from a view: the view's encoded state after it. */
  readonly state?: Json;
  /**
   * History: seeded (story `given`) or replayed to a consumer added after the
   * event (see `CatchUp`). Views and projections apply it, policies ignore it.
   */
  readonly history?: boolean;
  /**
   * For an event from a view: the aggregate event it derives from. Absent,
   * the delivery's own `source` and `seq` are its root.
   */
  readonly root?: Root;
  /**
   * Set on a delivery that revises one the key was given before (see
   * {@link Revision}). Targets handle it apart from their duplicates check;
   * policies ignore it.
   */
  readonly revision?: Revision;
}

/**
 * What a rewrite of a source tells a view or projection key about one event
 * it was given: the delivery that carries it is the event as it is now. The
 * source sends its revisions in order, then one `done`.
 */
export interface Revision {
  /** The rewrite it stems from: the same through every view between. */
  readonly root: string;
  /** Counts the source's revisions, from 1: a key drops one it has already taken. */
  readonly n: number;
  /** What the key was given before; absent when it was given nothing for this event. */
  readonly before?: {
    readonly tag: string;
    readonly event: Json;
    readonly state?: Json;
    readonly routes?: ReadonlyArray<string>;
  };
  /** The key is no longer given the event: the delivery repeats what `before` holds. */
  readonly gone?: true;
  /** No change: the source has sent every change of `root` it has for this key. */
  readonly done?: true;
  /**
   * The rewrite itself, for the events a compaction removed from the source:
   * a view key runs it over the copies it kept (see {@link ViewKit.recall}).
   * The delivery that carries it holds no event.
   */
  readonly recall?: Recall;
}

/** A rewrite as a view key runs it over the inputs it kept of events its source no longer holds. */
export interface Recall {
  /** The rewrite's name, as the model lists it. */
  readonly name: string;
  /** The rewrite's encoded input. */
  readonly input: Json;
  /** The last `seq` a compaction removed from the source: the key's inputs through it are its own. */
  readonly through: number;
}

/** A view key that events a compaction removed had reached. */
export interface Reached {
  readonly name: string;
  readonly key: string;
}

/** One stored row a rewrite changed: replaced (`after`), removed (no `after`) or new (no `before`). */
export interface Change<Row> {
  readonly seq: number;
  readonly before?: Row;
  readonly after?: Row;
}

/** A consumer key a source sent revisions to. */
export interface Revised {
  /** The consumer, by `CatchUp.targetId`. */
  readonly target: string;
  readonly kind: "view" | "projection";
  readonly name: string;
  readonly key: string;
}

/** One delivery a view key applied, with the `seq` of each entry it emitted for it. */
export interface ViewInput {
  readonly delivery: Delivery;
  readonly seqs: ReadonlyArray<number>;
  /**
   * A roll-up of events the key already held when it arrived: kept, so a
   * rewrite of it finds it, and never folded.
   */
  readonly covered?: true;
}

/** A stored view input: rows written before entries were tracked hold the delivery alone. */
export type StoredViewInput = ViewInput | Delivery;

/** A stored view input with its entry seqs, when it has them. */
export const viewInputOf = (
  row: StoredViewInput,
): {
  readonly delivery: Delivery;
  readonly seqs: ReadonlyArray<number> | undefined;
  readonly covered?: true;
} => ("delivery" in row ? row : { delivery: row, seqs: undefined });

/** The revision that carries a rewrite to a view key's own copies, when it holds one from `source`. */
export const recallOf = (
  pending: ReadonlyMap<string, Delivery>,
  source: string,
): Delivery | undefined => {
  const held = pending.get(revisionKey(source, 0));
  return held?.revision?.recall === undefined ? undefined : held;
};

/**
 * The aggregate event a delivery derives from, through any views: its stream
 * and seq. A rebuilt view numbers its entries afresh, but its roots stay.
 */
export interface Root {
  readonly source: string;
  readonly seq: number;
}

/**
 * A client's live read (`watch` or `events`) of one key, in JSON form. A
 * platform that pushes keeps it with the connection (on a WebSocket's
 * attachment, so a hibernated object can resume pushing) and asks the kit's
 * `push` what to send after each commit.
 */
export const Subscription = Schema.Struct({
  /** The client's request id, echoed as is (the client matches it by identity). */
  requestId: Schema.Union([Schema.String, Schema.Number]),
  mode: Schema.Literals(["watch", "events"]),
  /** The client's filter: it narrows what a permitted read sends. */
  where: Schema.optionalKey(Schema.Unknown),
  /** The context the read's middleware provided (see `Domain.RequestContext`), for `validate`. */
  context: Schema.Record(Schema.String, Schema.Unknown),
  /** Progress: the last state version (`watch`) or event `seq` (`events`) sent. */
  cursor: Schema.Number,
  /** Set when the read was refused before reaching the key: the encoded `Exit` to send. */
  refused: Schema.optionalKey(Schema.Unknown),
  /** `events` only: set once the `CaughtUp` frame after the read's history was sent. */
  caughtUpSent: Schema.optionalKey(Schema.Boolean),
  /**
   * Epoch milliseconds until which the read's middleware vouched for the
   * caller (see `Domain.setExpiry`). Once it passes, the platform closes the
   * connection with {@link REAUTHORIZE_CLOSE_CODE} instead of sending more.
   */
  validUntil: Schema.optionalKey(Schema.Number),
});
export type Subscription = typeof Subscription.Type;

/**
 * The close code of a live read's connection whose middleware must run again.
 * The client reconnects at once and resumes from its cursor, so the read's
 * middleware judges the caller afresh.
 */
export const REAUTHORIZE_CLOSE_CODE = 4000;

/** Whether a subscription must be judged again before anything more is sent. */
export const mustReauthorize = (subscription: Subscription, now: number): boolean =>
  subscription.validUntil !== undefined && now >= subscription.validUntil;

/**
 * What to send a subscriber, from a kit's `push`.
 */
export interface Push {
  /** Effect RPC messages (a `Chunk`, then an `Exit` if the read ended), in JSON form. */
  readonly messages: ReadonlyArray<Json>;
  /** The subscription with its progress after these messages. */
  readonly subscription: Subscription;
  /** `validate` rejected the read: send the messages, then close the connection. */
  readonly done: boolean;
}

/**
 * Input to {@link AggregateKit.handle}.
 */
export interface HandleInput {
  readonly id: string;
  /** The stored state, or `null` for an instance that has never committed. */
  readonly state: Json;
  readonly version: number;
  readonly command: Json;
  readonly commandId: string;
  /** The context the command was sent with (see `Domain.RequestContext`). */
  readonly context: Readonly<Record<string, Json>>;
  /** Epoch milliseconds. */
  readonly now: number;
  /** The flow the command belongs to; the command id when it starts one. */
  readonly correlationId?: string;
  /** The span that sent the command. */
  readonly trace?: TraceJson;
  /** Link to `trace` instead of continuing it. */
  readonly link?: boolean;
}

/**
 * Result of {@link AggregateKit.handle}.
 */
export type HandleResult =
  | { readonly _tag: "Rejected"; readonly rejection: Json }
  | {
      readonly _tag: "Accepted";
      readonly state: Json;
      readonly version: number;
      readonly events: ReadonlyArray<StoredEvent>;
      readonly reply: Json;
      readonly deliveries: ReadonlyArray<Delivery>;
    };

/**
 * The receipt of an accepted command, in JSON form.
 */
export interface ReceiptJson {
  readonly stream: string;
  readonly version: number;
  readonly events: ReadonlyArray<Json>;
  readonly reply: Json;
}

/**
 * An accepted command's receipt as an instance stores it: the number of
 * events it committed, read back from the log when the command is sent
 * again. A history rewritten since gives the events as they are now.
 */
export interface StoredReceipt {
  readonly version: number;
  readonly count: number;
  readonly reply: Json;
}

/** What an instance stores under a command id: its rejection, or its receipt. */
export type StoredResult =
  | { readonly _tag: "Rejected"; readonly rejection: Json }
  | { readonly _tag: "Accepted"; readonly stored: StoredReceipt }
  /** Stored before receipts were counts: it holds a copy of its events. */
  | { readonly _tag: "Accepted"; readonly receipt: ReceiptJson };

/** The stored form of an accepted command's result. */
export const storedResult = (version: number, count: number, reply: Json): StoredResult => ({
  _tag: "Accepted",
  stored: { version, count, reply },
});

/**
 * A stored result as `send` answers it: its events are the rows of `events`
 * (the instance's log, or the part of it that holds them) in its range.
 */
export const sendResultOf = (
  stream: string,
  result: StoredResult,
  events: ReadonlyArray<StoredEvent>,
): SendResult => {
  if (result._tag === "Rejected") return result;
  if ("receipt" in result) return result;
  const { version, count, reply } = result.stored;
  return {
    _tag: "Accepted",
    receipt: {
      stream,
      version,
      events: events
        .filter((row) => row.envelope.seq > version - count && row.envelope.seq <= version)
        .map((row) => row.event),
      reply,
    },
  };
};

/** What a rewrite is given on an instance. */
export interface RewriteInput {
  /** Names the run on the instance: a seen id answers its first result. */
  readonly rewriteId: string;
  /** The rewrite's name, as the model lists it. */
  readonly name: string;
  /** The rewrite's encoded input. */
  readonly input: Json;
}

/** Result of {@link AggregateStore.rewrite}. */
export type RewriteResult =
  | { readonly _tag: "Rewritten"; readonly changed: number }
  | { readonly _tag: "InvariantBroken"; readonly invariant: string };

/** How far a rewrite has got on its instance. */
export interface RewriteStatus {
  /** The instance's own events and state are rewritten, and every revision is on its way. */
  readonly done: boolean;
  /** The view and projection keys it sent revisions to. */
  readonly sent: ReadonlyArray<Revised>;
}

/** Result of {@link AggregateStore.compact}. */
export type CompactResult =
  | { readonly _tag: "Compacted"; readonly version: number; readonly compacted: number }
  | { readonly _tag: "Lossy" };

/** Input to {@link AggregateKit.rewrite}. */
export interface RewriteRun {
  readonly id: string;
  readonly name: string;
  readonly input: Json;
  /** The state folded from the rewritten events before this run: `null` at the start. */
  readonly state: Json;
  /** A run of the instance's stored events, in order. */
  readonly events: ReadonlyArray<StoredEvent>;
}

/** Input to {@link AggregateKit.rollup}. */
export interface RollupInput {
  readonly id: string;
  readonly name: string;
  readonly state: Json;
  readonly version: number;
  readonly now: number;
}

/** Result of {@link AggregateKit.rollup}: the roll-up's commit, or `undefined` when it would lose state. */
export type RollupResult = SeedResult | undefined;

/**
 * Result of {@link AggregateStore.send}.
 */
export type SendResult =
  | { readonly _tag: "Rejected"; readonly rejection: Json }
  | { readonly _tag: "Accepted"; readonly receipt: ReceiptJson };

/**
 * Result of {@link AggregateStore.import}: the receipt, or the version the
 * instance was at when it was not the one expected.
 */
export type ImportResult =
  | { readonly _tag: "Imported"; readonly receipt: ReceiptJson }
  | { readonly _tag: "UnexpectedVersion"; readonly version: number }
  | {
      readonly _tag: "OutOfOrder";
      /** The position of the first event out of order. */
      readonly index: number;
      /** Its commit time, in epoch milliseconds. */
      readonly at: number;
      /** The commit time it may not precede (or the clock it may not pass), in epoch milliseconds. */
      readonly after: number;
    };

/**
 * What {@link AggregateStore.import} receives with the events.
 */
export interface ImportMeta {
  readonly commandId: string;
  readonly expectedVersion: number;
  /**
   * Each event's original commit time, in epoch milliseconds, by position;
   * `null` (or no list) for the platform's current time.
   */
  readonly at?: ReadonlyArray<number | null>;
}

/**
 * The kernel for one aggregate type, handed to a platform.
 */
export interface AggregateKit {
  readonly name: string;
  /**
   * Decide, evolve, reply and route, purely. Throws only on a bug (an evolve
   * guard, an undecodable value); a platform turns that into a defect.
   */
  readonly handle: (input: HandleInput) => Effect.Effect<HandleResult>;
  /**
   * Fold already-decided events into state and route them, without running
   * `decide`. Used to seed history (story `given`) and to import it.
   */
  readonly seed: (input: SeedInput) => Effect.Effect<SeedResult>;
  /**
   * Fold the events a decision recorded on an instance into its state and
   * route them, without running `decide`: they reach policies like any other.
   */
  readonly record: (input: RecordInput) => Effect.Effect<SeedResult>;
  /** Route a delivery produced by `handle` to its target's host. */
  readonly deliver: (delivery: Delivery) => Effect.Effect<void>;
  /** The views and projections that consume this aggregate, by `CatchUp.targetId`. */
  readonly targets: ReadonlyArray<string>;
  /** Whether each key of a consumer it feeds hears only from the instance with its own id. */
  readonly consumerSingleSource: (target: string) => boolean;
  /** Route stored events to the consumers lagging behind them (see `CatchUp`). */
  readonly replay: (input: ReplayInput<StoredEvent>) => Effect.Effect<ReplayResult>;
  /**
   * Rewrite a run of an instance's stored events, purely: what changed, and
   * the state folded from the run as it now stands. An instance's whole log
   * goes through in order, each run starting from the state of the last.
   */
  readonly rewrite: (run: RewriteRun) => Effect.Effect<{
    readonly state: Json;
    readonly changes: ReadonlyArray<Change<StoredEvent>>;
  }>;
  /** Whether the rewrite removes the instance: its receipts and scheduled commands go too. */
  readonly deletes: (name: string) => boolean;
  /** The first of the aggregate's invariants an encoded state breaks, if any. */
  readonly broken: (state: Json) => string | undefined;
  /**
   * What a rewrite's changes are to each view and projection key the events
   * reached or now reach: one revision per key and event, in order, without
   * its `n` (the instance counts them).
   */
  readonly revise: (
    id: string,
    root: string,
    changes: ReadonlyArray<Change<StoredEvent>>,
  ) => Effect.Effect<ReadonlyArray<Delivery>>;
  /** The view keys a run of an instance's stored events reaches, each once. */
  readonly reached: (
    id: string,
    events: ReadonlyArray<StoredEvent>,
  ) => Effect.Effect<ReadonlyArray<Reached>>;
  /**
   * A rewrite as a revision for each view key that kept events a compaction
   * removed from the instance, without its `n`. None when the rewrite could
   * change none of them.
   */
  readonly recall: (
    id: string,
    root: string,
    recall: Recall,
    reached: ReadonlyArray<Reached>,
  ) => ReadonlyArray<Delivery>;
  /**
   * A compaction's roll-up of an instance, committed as history (policies
   * never react to it); `undefined` when folding it from `initial` does not
   * give the state back.
   */
  readonly rollup: (input: RollupInput) => Effect.Effect<RollupResult>;
  /** The model's compactions of this aggregate, with what their Layers say. */
  readonly compactions: ReadonlyArray<{
    readonly name: string;
    /** Compact once the instance holds more than this many events since it last did. */
    readonly afterEvents: number | undefined;
    /** Hand a run of events to the compaction's handler before they are removed. */
    readonly archive: (id: string, events: ReadonlyArray<StoredEvent>) => Effect.Effect<void>;
  }>;
}

/**
 * Input to {@link AggregateKit.seed}.
 */
export interface SeedInput {
  readonly id: string;
  readonly state: Json;
  readonly version: number;
  readonly events: ReadonlyArray<Json>;
  readonly commandId: string;
  readonly now: number;
  /** Each event's commit time by position, overriding `now` where it isn't `null`. */
  readonly at?: ReadonlyArray<number | null>;
}

/**
 * Result of {@link AggregateKit.seed}.
 */
export interface SeedResult {
  readonly state: Json;
  readonly version: number;
  readonly events: ReadonlyArray<StoredEvent>;
  readonly deliveries: ReadonlyArray<Delivery>;
}

/** Input to {@link AggregateKit.record}. */
export interface RecordInput {
  readonly id: string;
  readonly state: Json;
  readonly version: number;
  /** The events a decision recorded on this instance, encoded. */
  readonly events: ReadonlyArray<Json>;
  readonly commandId: string;
  /** Epoch milliseconds the decision was made at. */
  readonly now: number;
  readonly correlationId: string;
  readonly trace?: TraceJson;
}

/** One aggregate instance a decision reads, by the name `reads` gives it. */
export interface DecisionRead {
  /** The names `reads` gives the instance: more than one when it is named twice. */
  readonly keys: ReadonlyArray<string>;
  readonly aggregate: string;
  readonly id: string;
  /** The instance's stream, e.g. `Account/a-1`. */
  readonly stream: string;
}

/** A read instance with the state and version it was read at. */
export interface DecisionState extends DecisionRead {
  /** The stored state, or `null` for an instance that has never committed. */
  readonly state: Json;
  readonly version: number;
}

/** What a decision writes to one instance it read: nothing, when `events` is empty. */
export interface DecisionWrite extends DecisionRead {
  /** The version the instance was read at: it must still have it. */
  readonly version: number;
  readonly events: ReadonlyArray<Json>;
}

/** The receipt of an accepted decision, in JSON form. */
export interface DecisionReceiptJson {
  readonly commits: ReadonlyArray<{ readonly stream: string; readonly version: number }>;
  readonly events: ReadonlyArray<Json>;
  readonly reply: Json;
  /** Where each of `events` was committed, by position. Absent on receipts from before it was kept. */
  readonly at?: ReadonlyArray<{ readonly stream: string; readonly seq: number }>;
}

/**
 * A decision's receipt as it is stored: where its events are, without a
 * copy of them. A history rewritten since gives the events as they are now.
 */
export const storedDecisionReceipt = (receipt: DecisionReceiptJson): DecisionReceiptJson =>
  receipt.at === undefined ? receipt : { ...receipt, events: [] };

/**
 * A stored decision receipt as `send` answers it: its events read back from
 * the instances that hold them, in the order they were recorded. `read`
 * gives the stored events of one stream at the given `seq`s.
 */
export const decisionReceiptOf = (
  stored: DecisionReceiptJson,
  read: (stream: string, seqs: ReadonlyArray<number>) => Effect.Effect<ReadonlyArray<StoredEvent>>,
): Effect.Effect<DecisionReceiptJson> => {
  const at = stored.at;
  if (at === undefined || at.length === 0 || stored.events.length > 0) {
    return Effect.succeed(stored);
  }
  const streams = [...new Set(at.map((pointer) => pointer.stream))];
  return Effect.map(
    Effect.forEach(
      streams,
      (stream) =>
        Effect.map(
          read(
            stream,
            at.filter((pointer) => pointer.stream === stream).map((pointer) => pointer.seq),
          ),
          (rows) => [stream, new Map(rows.map((row) => [row.envelope.seq, row.event]))] as const,
        ),
      { concurrency: "unbounded" },
    ),
    (found) => {
      const byStream = new Map(found);
      return {
        ...stored,
        events: at.flatMap(({ stream, seq }) => {
          const event = byStream.get(stream)?.get(seq);
          return event === undefined ? [] : [event];
        }),
      };
    },
  );
};

/** Input to {@link DecisionKit.decide}. */
export interface DecideInput {
  readonly command: Json;
  readonly commandId: string;
  readonly context: Readonly<Record<string, Json>>;
  /** Epoch milliseconds. */
  readonly now: number;
  readonly correlationId?: string;
  readonly trace?: TraceJson;
  readonly link?: boolean;
  /** Every instance {@link DecisionKit.reads} named, as it was read. */
  readonly states: ReadonlyArray<DecisionState>;
}

/** Result of {@link DecisionKit.decide}. */
export type DecideResult =
  | { readonly _tag: "Rejected"; readonly rejection: Json }
  | {
      readonly _tag: "Accepted";
      /** One per instance read, in stream order: its events, or none. */
      readonly writes: ReadonlyArray<DecisionWrite>;
      readonly receipt: DecisionReceiptJson;
      readonly correlationId: string;
      /** The span that decided, so the events' reactions continue it. */
      readonly trace?: TraceJson;
    };

/** Result of {@link DecisionStore.send}. */
export type DecisionResult =
  | { readonly _tag: "Rejected"; readonly rejection: Json }
  | { readonly _tag: "Accepted"; readonly receipt: DecisionReceiptJson };

/**
 * The kernel for one decision, handed to a platform.
 */
export interface DecisionKit {
  readonly name: string;
  /** The instances a command involves, each once, ordered by stream. */
  readonly reads: (command: Json) => Effect.Effect<ReadonlyArray<DecisionRead>>;
  /** Decide purely against the states read: a rejection, or what to write to each instance. */
  readonly decide: (input: DecideInput) => Effect.Effect<DecideResult>;
}

/**
 * What a platform provides for a decision.
 */
export interface DecisionStore {
  /**
   * Handle a command across the instances it reads: decide against their
   * states, and commit every write or none. Nothing commits unless each
   * instance still has the version it was read at; a command id already
   * committed returns its first receipt.
   */
  readonly send: (command: Json, meta: Aggregate.SendMeta) => Effect.Effect<DecisionResult>;
}

/**
 * What a platform provides for an aggregate type.
 */
export interface AggregateStore {
  /**
   * Handle a command on one instance: single writer per id; dedupe by
   * `commandId`; persist events, state, receipt and deliveries atomically;
   * then deliver at least once, in order.
   */
  readonly send: (id: string, command: Json, meta: Aggregate.SendMeta) => Effect.Effect<SendResult>;
  /**
   * Send a command to one instance when it is due, durably (it survives
   * restarts) and at least once. `name` is the scheduled command's id on the
   * instance; `meta.commandId` is this arming's, the one the command commits
   * with. Scheduling under a `name` replaces its command, pending or already
   * run, unless that command has the same `meta.commandId`: then it is the
   * same arming again (a policy or step that ran again) and nothing changes,
   * not even when it is due. Rejections are impossible: only non-rejecting
   * commands are scheduled. Returns when it is due, in epoch milliseconds on
   * the platform's clock.
   */
  readonly schedule: (
    id: string,
    name: string,
    command: Json,
    meta: Aggregate.SendMeta,
    due: Aggregate.Due,
  ) => Effect.Effect<number>;
  /**
   * Cancel the pending scheduled command named `commandId` on one instance,
   * durably, and remember the cancel. Once this succeeds, the command never
   * runs, even one already due. Fails with `AlreadyExecuted` when the
   * command under that name already ran, `AlreadyCancelled` when it was
   * cancelled before (and not scheduled again since), and `NotScheduled`
   * when nothing was scheduled under it.
   */
  readonly unschedule: (
    id: string,
    commandId: string,
  ) => Effect.Effect<
    void,
    Aggregate.AlreadyExecuted | Aggregate.AlreadyCancelled | Aggregate.NotScheduled
  >;
  /** Read the stored state of an instance. */
  readonly state: (id: string) => Effect.Effect<{ readonly state: Json; readonly version: number }>;
  /** Read the committed events of an instance (tests and diagnostics; optional). */
  readonly events?: (id: string) => Effect.Effect<ReadonlyArray<StoredEvent>>;
  /** The stored state and version of an instance, then every new one. */
  readonly changes: (
    id: string,
  ) => Stream.Stream<{ readonly state: Json; readonly version: number }>;
  /** Committed events with `seq > after`, then live ones. */
  readonly tail: (id: string, after: number) => Stream.Stream<StoredEvent>;
  /**
   * Append events without deciding. They reach views as history, and never
   * trigger policies (tests; optional).
   */
  readonly seed?: (id: string, events: ReadonlyArray<Json>) => Effect.Effect<void>;
  /**
   * Append events without deciding, once per `meta.commandId`: single writer
   * per id; a seen `commandId` answers its stored receipt; otherwise, unless
   * the instance is at `meta.expectedVersion`, commit nothing and answer
   * `UnexpectedVersion`. Persist events, state, receipt and deliveries
   * atomically, as `send` does. The events reach views and projections as
   * history, and never trigger policies. Optional: a client fails with a
   * defect on a platform without it.
   */
  readonly import?: (
    id: string,
    events: ReadonlyArray<Json>,
    meta: ImportMeta,
  ) => Effect.Effect<ImportResult>;
  /**
   * Rewrite an instance's stored events and state, once per
   * `input.rewriteId`: single writer per id, with no command committing
   * while it runs. Persist the events, the state and the revisions for its
   * consumers together, then deliver those in order after every delivery
   * already staged. Nothing changes when the rewritten state breaks an
   * invariant. Optional: a client fails with a defect on a platform without it.
   */
  readonly rewrite?: (id: string, input: RewriteInput) => Effect.Effect<RewriteResult>;
  /** How far the rewrite named `rewriteId` has got; `undefined` when the instance has none. */
  readonly rewriteStatus?: (
    id: string,
    rewriteId: string,
  ) => Effect.Effect<RewriteStatus | undefined>;
  /**
   * Commit a compaction's roll-up to an instance, then hand the events
   * before it to the compaction's handler and remove them, in runs, each
   * removed only once the handler succeeded. Commands keep committing while
   * it runs. Nothing changes when the roll-up would lose state.
   */
  readonly compact?: (id: string, name: string) => Effect.Effect<CompactResult>;
}

/** How much history has reached a consumer: see `View.History`. */
export interface HistoryJson {
  readonly complete: boolean;
}

/**
 * The stored state of one view key.
 */
export interface ViewSnapshot {
  /** The encoded state, or `null` when the key does not exist. */
  readonly state: Json;
  /** Number of applied deliveries. */
  readonly version: number;
  /**
   * Last applied `seq` per source.
   *
   * A command that waits for its views (`consistency: "strong"`) and a read's
   * `atLeast` both answer once a `seq` is reported here, and promise that any
   * read after that includes it. So a platform that serves a key's reads from
   * more than one copy (read replicas) reports a `seq` only once every copy
   * that serves reads has applied it.
   */
  readonly checkpoints: Readonly<Record<string, number>>;
  /** Number of events the key has emitted. */
  readonly seq: number;
  /** The view's generation the key was built by: an earlier one is stale and starts over. */
  readonly generation?: number;
  /**
   * Per source, what the last command to reach the key from it became: see
   * {@link EmittedRange}. A reader finds a command's emissions with it instead
   * of scanning entries. Absent from snapshots written before it existed, and
   * for a source until the key next applies a delivery from it.
   */
  readonly emitted?: Readonly<Record<string, EmittedRange>>;
  /**
   * Per source, the roll-up the key last folded, by its `rollup`: every event
   * of one roll-up is treated alike. Absent for a source whose roll-ups the
   * key has only kept.
   */
  readonly folded?: Readonly<Record<string, number>>;
}

/**
 * The entries a view key emitted for one command's deliveries from one source.
 */
export interface EmittedRange {
  /** The command the deliveries came from. */
  readonly commandId: string;
  /** The last of its deliveries' `seq` (on the source) the key applied. */
  readonly sourceSeq: number;
  /** The key's `seq` before the first of them: its entries are those after it… */
  readonly after: number;
  /** …through this one (`after` itself when they emitted nothing). */
  readonly through: number;
}

/** A delivery without its revision: the event as an ordinary input. */
export const withoutRevision = (delivery: Delivery): Delivery => {
  const { revision: _revision, ...rest } = delivery;
  return rest;
};

/** The delivery that tells a key its source has sent every revision of `root`. */
export const doneDelivery = (
  from: { readonly origin: string; readonly id: string },
  root: string,
  n: number,
  target: Delivery["target"],
  key: string,
  at: number,
): Delivery => {
  const stream = `${from.origin}/${from.id}`;
  return {
    target,
    key,
    source: stream,
    seq: 0,
    origin: from.origin,
    tag: "",
    event: null,
    envelope: { id: from.id, stream, seq: 0, at, commandId: root, correlationId: root },
    history: true,
    revision: { root, n, done: true },
  };
};

/** The keys a run of revisions was sent to, each once. */
export const revisedBy = (deliveries: ReadonlyArray<Delivery>): ReadonlyArray<Revised> => {
  const out = new Map<string, Revised>();
  for (const { target, key } of deliveries) {
    if (target.kind === "policy") continue;
    const id = `${target.kind}:${target.name}${target.generation ? `${target.inPlace ? "@" : "#"}${target.generation}` : ""}`;
    out.set(`${id}|${key}`, { target: id, kind: target.kind, name: target.name, key });
  }
  return [...out.values()];
};

/** Two lists of revised keys as one, each key once. */
export const mergeRevised = (
  a: ReadonlyArray<Revised>,
  b: ReadonlyArray<Revised>,
): ReadonlyArray<Revised> => {
  const out = new Map<string, Revised>();
  for (const revised of [...a, ...b]) out.set(`${revised.target}|${revised.key}`, revised);
  return [...out.values()];
};

/**
 * A rewrite's revisions as an instance sends them: each numbered after the
 * last (`from`), then one `done` per key they reach.
 */
export const stampRevisions = (
  from: { readonly origin: string; readonly id: string },
  root: string,
  last: number,
  revisions: ReadonlyArray<Delivery>,
  at: number,
): {
  readonly deliveries: ReadonlyArray<Delivery>;
  readonly sent: ReadonlyArray<Revised>;
  readonly last: number;
} => {
  let n = last;
  const stamped = revisions.map((delivery) => ({
    ...delivery,
    revision: { ...delivery.revision!, n: ++n },
  }));
  const targets = new Map<string, Delivery>();
  for (const delivery of stamped) {
    targets.set(`${delivery.target.kind}:${delivery.target.name}|${delivery.key}`, delivery);
  }
  const done = [...targets.values()].map((delivery) =>
    doneDelivery(from, root, ++n, delivery.target, delivery.key, at),
  );
  return { deliveries: [...stamped, ...done], sent: revisedBy(stamped), last: n };
};

/**
 * Whether a key still holds a revision of the rewrite `root` from `source`
 * for an event that has yet to arrive: until it does, the key has not taken
 * all of that rewrite.
 */
export const awaitsRevision = (
  pending: Iterable<Delivery>,
  root: string,
  source: string,
): boolean => {
  for (const delivery of pending) {
    // One the key is no longer given may never arrive: its source has removed
    // it. Held, it is dropped if it does arrive, so the key has taken it already.
    if (delivery.revision?.gone) continue;
    // A rewrite for the key's own copies waits for no event: see `keptRecalls`.
    if (delivery.revision?.recall) continue;
    if (delivery.source === source && delivery.revision?.root === root) return true;
  }
  return false;
};

/**
 * The recalls a key still holds once it has applied through `checkpoints`. A
 * key takes a recall when its source says it has sent it, which can be before
 * the events it is for arrive (the key is still reading its history). So it
 * holds each until it has read its source past the events the recall covers,
 * and runs it over what arrives meanwhile.
 */
export const keptRecalls = (
  recalls: ReadonlyArray<Delivery>,
  checkpoints: Readonly<Record<string, number>>,
): ReadonlyArray<Delivery> =>
  recalls.filter((held) => (checkpoints[held.source] ?? 0) < (held.revision?.recall?.through ?? 0));

/** Where a pending revision is kept, per source event. */
export const revisionKey = (source: string, seq: number) => `${source}|${seq}`;

/** Whether two stored JSON values are the same. */
export const sameJson = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * A view key's inputs once the revisions it holds are taken: a revised input
 * is swapped or removed, and one the key is newly given goes in before the
 * first later input of its source (at the end when there is none). Revisions
 * for events the key has not been given yet (`left`) stay, to be taken when
 * the event arrives. `changed` is false when no input was touched.
 */
export const reviseInputs = (
  rows: ReadonlyArray<StoredViewInput>,
  pending: ReadonlyMap<string, Delivery>,
  checkpoints: Readonly<Record<string, number>>,
): {
  readonly rows: ReadonlyArray<StoredViewInput>;
  readonly left: ReadonlyMap<string, Delivery>;
  readonly changed: boolean;
} => {
  const used = new Set<string>();
  const out: Array<StoredViewInput> = [];
  let changed = false;
  for (const row of rows) {
    const { delivery, seqs, covered } = viewInputOf(row);
    const id = revisionKey(delivery.source, delivery.seq);
    const revised = pending.get(id);
    if (revised === undefined) {
      out.push(row);
      continue;
    }
    used.add(id);
    changed = true;
    if (revised.revision?.gone) continue;
    out.push({
      delivery: withoutRevision(revised),
      seqs: seqs ?? [],
      ...(covered ? { covered } : {}),
    });
  }
  const left = new Map<string, Delivery>();
  for (const [id, revised] of pending) {
    if (used.has(id)) continue;
    // Given to the key, and yet to arrive: taken when it does. An event the
    // key was never given (no `before`) is not on its way: it goes in now.
    if (
      revised.revision?.before !== undefined &&
      revised.seq > (checkpoints[revised.source] ?? 0)
    ) {
      left.set(id, revised);
      continue;
    }
    if (revised.revision?.gone) continue;
    changed = true;
    const at = out.findIndex((row) => {
      const { delivery } = viewInputOf(row);
      return delivery.source === revised.source && delivery.seq > revised.seq;
    });
    const input: ViewInput = { delivery: withoutRevision(revised), seqs: [] };
    if (at < 0) out.push(input);
    else out.splice(at, 0, input);
  }
  return { rows: out, left, changed };
};

/** What a refold changed among a key's entries, by `seq`. */
export const entryChanges = (
  before: ReadonlyArray<ViewEntry>,
  after: ReadonlyArray<ViewEntry>,
): ReadonlyArray<Change<ViewEntry>> => {
  const was = new Map(before.map((entry) => [entry.seq, entry]));
  const is = new Map(after.map((entry) => [entry.seq, entry]));
  const changes: Array<Change<ViewEntry>> = [];
  for (const seq of [...new Set([...was.keys(), ...is.keys()])].sort((a, b) => a - b)) {
    const old = was.get(seq);
    const now = is.get(seq);
    if (old !== undefined && now !== undefined && sameJson(old, now)) continue;
    changes.push({ seq, ...(old ? { before: old } : {}), ...(now ? { after: now } : {}) });
  }
  return changes;
};

/** A key's snapshot after a refold: it never reports less than it did before. */
export const refolded = (before: ViewSnapshot, after: ViewSnapshot, top: number): ViewSnapshot => {
  const checkpoints: Record<string, number> = { ...after.checkpoints };
  for (const [source, seq] of Object.entries(before.checkpoints)) {
    checkpoints[source] = Math.max(checkpoints[source] ?? 0, seq);
  }
  return {
    ...after,
    checkpoints,
    // A watcher is sent a state only with a version past the one it has.
    version: sameJson(before.state, after.state) ? before.version : before.version + 1,
    seq: Math.max(before.seq, top),
    // A key left with no inputs is still this generation's.
    ...(before.generation === undefined ? {} : { generation: before.generation }),
  };
};

/** The snapshot of a key that has never received a delivery. */
export const emptySnapshot: ViewSnapshot = { state: null, version: 0, checkpoints: {}, seq: 0 };

/**
 * One event a view key emitted, with the key's state after it.
 */
export interface ViewEntry {
  readonly seq: number;
  readonly event: Json;
  readonly envelope: EnvelopeJson;
  readonly state: Json;
  /** The aggregate event the entry derives from; absent on entries written before roots were. */
  readonly root?: Root;
}

/**
 * The kernel for one view, handed to a platform.
 */
export interface ViewKit {
  readonly name: string;
  /**
   * Apply deliveries to a key's snapshot: evolve its state and emit events.
   * Drops duplicates. Persist the snapshot and entries together, then send
   * the downstream deliveries.
   */
  readonly apply: (
    key: string,
    snapshot: ViewSnapshot,
    deliveries: ReadonlyArray<Delivery>,
  ) => Effect.Effect<{
    readonly snapshot: ViewSnapshot;
    /** `false` when every delivery was a duplicate. */
    readonly changed: boolean;
    readonly entries: ReadonlyArray<ViewEntry>;
    readonly downstream: ReadonlyArray<Delivery>;
    /** The deliveries it applied (not the duplicates), each with the entries it emitted. */
    readonly inputs: ReadonlyArray<ViewInput>;
  }>;
  /**
   * Fold a run of a key's inputs again, after a rewrite changed some of
   * them: the whole log goes through in order, from the empty snapshot, each
   * run starting from the last one's `snapshot` and `top`. An input's
   * entries keep the `seq`s they had; one that now emits more takes new
   * ones after `top`, the key's highest `seq`.
   */
  readonly refold: (
    key: string,
    cursor: { readonly snapshot: ViewSnapshot; readonly top: number },
    rows: ReadonlyArray<StoredViewInput>,
  ) => Effect.Effect<{
    readonly snapshot: ViewSnapshot;
    readonly top: number;
    readonly inputs: ReadonlyArray<ViewInput>;
    readonly entries: ReadonlyArray<ViewEntry>;
  }>;
  /**
   * Run a rewrite over the inputs a key kept of events its source no longer
   * holds (`revised` carries the rewrite, see {@link Revision.recall}): each
   * is kept, replaced or removed as the rewrite's handlers say, and one the
   * key is no longer given is removed.
   */
  readonly recall: (
    key: string,
    revised: Delivery,
    rows: ReadonlyArray<StoredViewInput>,
  ) => Effect.Effect<{
    readonly rows: ReadonlyArray<StoredViewInput>;
    readonly changed: boolean;
  }>;
  /**
   * What a refold's changes to the key's entries are to each view and
   * projection key they reached or now reach, as {@link AggregateKit.revise}.
   */
  readonly revise: (
    key: string,
    root: string,
    changes: ReadonlyArray<Change<ViewEntry>>,
  ) => Effect.Effect<ReadonlyArray<Delivery>>;
  /** Route a downstream delivery to its target's host. */
  readonly deliver: (delivery: Delivery) => Effect.Effect<void>;
  /** The views and projections that consume this view, by `CatchUp.targetId`. */
  readonly targets: ReadonlyArray<string>;
  /** Whether each key of a consumer it feeds hears only from the instance with its own id. */
  readonly consumerSingleSource: (target: string) => boolean;
  /**
   * This view's generation. A stored key built by an earlier one is reset
   * (state, entries, input log and cursors) before it is read or applied to.
   */
  readonly generation: number;
  /** The generation of the view's storage: its generation, unless it is rebuilt in place. */
  readonly classGeneration: number;
  /** The view's id, by `CatchUp.targetId`, in this code. */
  readonly target: string;
  /**
   * Set for a view keyed by the one aggregate it reads (`source`): before a key
   * answers a read, it reads its history from the instance with its own id, so
   * every answer covers the whole history even when no backfill filled it.
   */
  readonly catchUp?: { readonly source: string };
  /** Whether each key hears only from the source instance with its own id (see `Kernel.singleSource`). */
  readonly singleSource: boolean;
  /**
   * Route a source instance's stored rows (as its backfill `log` returns them)
   * to one consumer (by `CatchUp.targetId`), as history: each row's seq and its
   * deliveries. What a key keyed by its source runs on the rows it reads.
   */
  readonly history: (
    target: string,
    source: string,
    id: string,
    rows: ReadonlyArray<unknown>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>
  >;
  /** Route emitted entries to the consumers lagging behind them (see `CatchUp`). */
  readonly replay: (input: ReplayInput<ViewEntry>) => Effect.Effect<ReplayResult>;
  /** Trace an `apply` of these deliveries to `key` (wrap the work that applies and persists them). */
  readonly observe: (
    key: string,
    deliveries: ReadonlyArray<Delivery>,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * What a subscriber of `key` receives, given its snapshot and the entries
   * emitted since (at least those after the subscription's cursor).
   */
  readonly push: (
    key: string,
    subscription: Subscription,
    snapshot: ViewSnapshot,
    entries: ReadonlyArray<ViewEntry>,
  ) => Effect.Effect<Push>;
}

/**
 * Which entries of a key a `list` reads, by `seq`. Without a range, every
 * entry, oldest first.
 */
export interface ListRange {
  /** Oldest first (`"asc"`, the default) or newest first. */
  readonly order?: "asc" | "desc";
  /** Only entries after this `seq` in `order`: greater for `"asc"`, smaller for `"desc"`. */
  readonly after?: number;
  /** At most this many entries. */
  readonly limit?: number;
}

/**
 * The first imported event whose commit time comes before the event ahead of
 * it (`latest` for the first: the instance's last commit time, `0` if it has
 * none) or after `now`, or `undefined` when they are in order. An event
 * without a time (`null`) commits at `now`. Views are rebuilt in commit-time
 * order, so a history out of order would replay out of order.
 */
export const outOfOrder = (
  at: ReadonlyArray<number | null> | undefined,
  count: number,
  latest: number,
  now: number,
): Extract<ImportResult, { readonly _tag: "OutOfOrder" }> | undefined => {
  let after = latest;
  for (let index = 0; index < count; index++) {
    const time = at?.[index] ?? now;
    if (time < after) return { _tag: "OutOfOrder", index, at: time, after };
    if (time > now) return { _tag: "OutOfOrder", index, at: time, after: now };
    after = time;
  }
  return undefined;
};

/** The entries of `entries` (sorted by `seq`) in `range`, for platforms that hold them in memory. */
export const inRange = <A extends { readonly seq: number }>(
  entries: ReadonlyArray<A>,
  range: ListRange | undefined,
): ReadonlyArray<A> => {
  const desc = range?.order === "desc";
  const after = range?.after;
  const ordered = (desc ? [...entries].reverse() : entries).filter(
    (entry) => after === undefined || (desc ? entry.seq < after : entry.seq > after),
  );
  return range?.limit === undefined ? ordered : ordered.slice(0, Math.max(0, range.limit));
};

/**
 * What a platform provides for a view.
 */
export interface ViewStore {
  /** Apply deliveries to one key (single writer per key), then forward downstream deliveries. */
  readonly receive: (key: string, deliveries: ReadonlyArray<Delivery>) => Effect.Effect<void>;
  readonly read: (key: string) => Effect.Effect<ViewSnapshot>;
  /** The current snapshot, then every new one. */
  readonly changes: (key: string) => Stream.Stream<ViewSnapshot>;
  /** A key's entries in `range`: only these are read from storage. */
  readonly list: (key: string, range?: ListRange) => Effect.Effect<ReadonlyArray<ViewEntry>>;
  /** Entries with `seq > after`, then live entries. */
  readonly tail: (key: string, after: number) => Stream.Stream<ViewEntry>;
  /**
   * The keys a view key sent revisions to once it had taken every revision
   * of the rewrite `root` from `source` (a stream); `undefined` until then.
   */
  readonly revised?: (
    key: string,
    root: string,
    source: string,
  ) => Effect.Effect<ReadonlyArray<Revised> | undefined>;
  /**
   * Accept a WebSocket upgrade (the current request) for a live read of
   * `key`, then push to it on every commit. Optional: without it, live reads
   * are streamed responses over `changes` and `tail`.
   */
  readonly connect?: (key: string, subscription: Subscription) => HttpEffect;
}

/**
 * The kernel for one policy, handed to a platform.
 */
export interface PolicyKit {
  readonly name: string;
  /** Run the policy's handler for one delivery. */
  readonly run: (delivery: Delivery) => Effect.Effect<void>;
}

/**
 * What a platform provides for a policy.
 */
export interface PolicyStore {
  /** Run deliveries at least once, in order per key. */
  readonly receive: (delivery: Delivery) => Effect.Effect<void>;
}

/**
 * One delivery a consumer's key accepted, in the key's immutable input log.
 */
export interface Accepted {
  /** The delivery's place in the key's input log, from 1. */
  readonly position: number;
  readonly delivery: Delivery;
  /** Epoch milliseconds it was accepted. */
  readonly at: number;
}

/**
 * How a projection's Layer tunes it (variants, not part of its meaning).
 */
export interface ProjectionOptions {
  /** Hand the handler up to `size` accepted deliveries at once, waiting up to `wait` ms to fill. */
  readonly batch?: { readonly size: number; readonly waitMillis: number };
}

/**
 * The kernel for one projection, handed to a platform.
 */
export interface ProjectionKit {
  readonly name: string;
  readonly options: ProjectionOptions;
  /**
   * This projection's generation. A key's log from an earlier one is reset;
   * deliveries for an earlier one are dropped.
   */
  readonly generation: number;
  /** Whether each key hears only from the source instance with its own id (see `Kernel.singleSource`). */
  readonly singleSource: boolean;
  /**
   * Route a source instance's stored rows (as its backfill `log` returns them)
   * to one consumer (by `CatchUp.targetId`), as history: each row's seq and its
   * deliveries. What a key keyed by its source runs on the rows it reads.
   */
  readonly history: (
    target: string,
    source: string,
    id: string,
    rows: ReadonlyArray<unknown>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly seq: number; readonly deliveries: ReadonlyArray<Delivery> }>
  >;
  /**
   * Run the handler for a run of one key's input log, in order. Succeeds only
   * when every write the handler made succeeded; the platform then records
   * the run as processed.
   */
  readonly run: (key: string, batch: ReadonlyArray<Accepted>) => Effect.Effect<void>;
}

/**
 * What a platform provides for a projection.
 */
export interface ProjectionStore {
  /**
   * Accept a delivery into its key's input log (dropping one already
   * accepted, by source and `seq`), then process the log in order, in batches.
   */
  readonly receive: (delivery: Delivery) => Effect.Effect<void>;
  /**
   * The last processed `seq` per source stream, for one key. Given `sources`,
   * a host may read only theirs: a key can hear from millions of sources.
   */
  readonly checkpoints: (
    key: string,
    sources?: ReadonlyArray<string>,
  ) => Effect.Effect<Readonly<Record<string, number>>>;
  /** Whether a key has handled every revision of the rewrite `root` from `source` (a stream). */
  readonly revised?: (key: string, root: string, source: string) => Effect.Effect<boolean>;
}

/**
 * One entry appended to a stream key.
 */
export interface StreamEntry {
  readonly seq: number;
  readonly event: Json;
  readonly envelope: EnvelopeJson;
  /** The source event its writer was handling when it appended it; absent on entries from before it was kept. */
  readonly from?: { readonly source: string; readonly seq: number };
}

/**
 * What a writer's `rewrite` makes of the entries it appended for one source
 * event: `events` take their place, in order.
 */
export interface StreamRevision {
  /** The source event whose entries are replaced. */
  readonly source: string;
  readonly sourceSeq: number;
  readonly at: number;
  readonly commandId: string;
  readonly events: ReadonlyArray<Json>;
}

/**
 * A key's entries once a revision is taken: each entry appended for the
 * source event takes the next of `events` and keeps its `seq`; an entry with
 * no event left is removed; an event with no entry left is appended.
 */
export const reviseEntries = (
  name: string,
  key: string,
  top: number,
  matching: ReadonlyArray<StreamEntry>,
  revision: StreamRevision,
): {
  readonly put: ReadonlyArray<StreamEntry>;
  readonly removed: ReadonlyArray<number>;
  readonly top: number;
} => {
  const put: Array<StreamEntry> = [];
  const removed: Array<number> = [];
  matching.forEach((entry, index) => {
    const event = revision.events[index];
    if (event === undefined) removed.push(entry.seq);
    else if (!sameJson(event, entry.event)) put.push({ ...entry, event });
  });
  let seq = top;
  for (const event of revision.events.slice(matching.length)) {
    seq += 1;
    put.push({
      seq,
      event,
      envelope: {
        id: key,
        stream: `${name}/${key}`,
        seq,
        at: revision.at,
        commandId: revision.commandId,
      },
      from: { source: revision.source, seq: revision.sourceSeq },
    });
  }
  return { put, removed, top: seq };
};

/**
 * The stored progress of one stream key.
 */
export interface StreamMeta {
  /** Number of entries. */
  readonly seq: number;
  /** The last source `seq` the writer has handled, per source stream. */
  readonly checkpoints: Readonly<Record<string, number>>;
  /** The last write applied: the writer's input-log position and its append index there. */
  readonly origin: readonly [number, number];
  /** The writer generation `origin` belongs to (see `Kernel.generationOf`); 0 when absent. */
  readonly generation?: number;
  /** The last root seq the writer has handled, per aggregate stream, over every generation. */
  readonly roots?: Readonly<Record<string, number>>;
  /**
   * `roots` as of when this generation started writing: a rebuilt writer's
   * replay of these appends nothing again.
   */
  readonly inherited?: Readonly<Record<string, number>>;
}

/** The meta of a stream key nothing has written. */
export const emptyStreamMeta: StreamMeta = { seq: 0, checkpoints: {}, origin: [0, 0] };

/**
 * One append to a stream key, made by its writer while handling an input.
 */
export interface StreamWrite {
  /** The writer's generation: its input log starts over at each one. */
  readonly generation: number;
  /** Where the write comes from: the writer's input-log position and the append's index there. */
  readonly origin: readonly [number, number];
  /** The aggregate event the input being handled derives from. */
  readonly root: Root;
  /** The source event being handled. */
  readonly source: string;
  readonly sourceSeq: number;
  readonly at: number;
  readonly commandId: string;
  readonly events: ReadonlyArray<Json>;
}

/**
 * What a writer's run handled, appends or not.
 */
export interface StreamHandled {
  readonly generation: number;
  /** The last source `seq` handled, per source stream. */
  readonly checkpoints: Readonly<Record<string, number>>;
  /** The last root seq handled, per aggregate stream. */
  readonly roots: Readonly<Record<string, number>>;
}

/**
 * The kernel for one stream, handed to a platform.
 */
export interface StreamKit {
  readonly name: string;
  /**
   * What a subscriber of `key` receives, given its meta and the entries
   * appended since (at least those after the subscription's cursor).
   */
  readonly push: (
    key: string,
    subscription: Subscription,
    meta: StreamMeta,
    entries: ReadonlyArray<StreamEntry>,
    latest: StreamEntry | undefined,
  ) => Effect.Effect<Push>;
}

/**
 * What a platform provides for a stream.
 */
export interface StreamStore {
  /**
   * Append a write to one key (single writer per key), as the platform's
   * stream rules decide: a repeat, a write from an older generation, or a rebuilt
   * writer's replay of a root an earlier generation handled is dropped.
   */
  readonly append: (key: string, write: StreamWrite) => Effect.Effect<void>;
  /** Record that the writer handled source events without appending. */
  readonly advance: (key: string, handled: StreamHandled) => Effect.Effect<void>;
  /**
   * Replace the entries the writer appended for one source event (see
   * {@link reviseEntries}). Running it again changes nothing more.
   */
  readonly revise?: (key: string, revision: StreamRevision) => Effect.Effect<void>;
  readonly read: (key: string) => Effect.Effect<StreamMeta>;
  /** The current meta, then every new one. */
  readonly changes: (key: string) => Stream.Stream<StreamMeta>;
  /** A key's entries in `range`: only these are read from storage. */
  readonly list: (key: string, range?: ListRange) => Effect.Effect<ReadonlyArray<StreamEntry>>;
  /** Entries with `seq > after`, then live entries. */
  readonly tail: (key: string, after: number) => Stream.Stream<StreamEntry>;
  /** Accept a WebSocket upgrade for a live read of `key` (optional, like views). */
  readonly connect?: (key: string, subscription: Subscription) => HttpEffect;
}

/**
 * Where one model is hosted. One factory per concept, each called once per
 * entity while the model's Layer is built. A factory may declare any
 * infrastructure (Durable Objects, buckets, queues) and returns the store the
 * kernel talks to.
 */
export interface ModelHost {
  readonly aggregate: (
    aggregate: Aggregate.Any,
    kit: AggregateKit,
  ) => Effect.Effect<AggregateStore>;
  /**
   * Called after every aggregate's factory. A platform without it can't host
   * a model that has decisions.
   */
  readonly decision?: (decision: Decision.Any, kit: DecisionKit) => Effect.Effect<DecisionStore>;
  readonly view: (view: View.Any, kit: ViewKit) => Effect.Effect<ViewStore>;
  readonly policy: (policy: Policy.Any, kit: PolicyKit) => Effect.Effect<PolicyStore>;
  readonly projection: (
    projection: Projection.Any,
    kit: ProjectionKit,
  ) => Effect.Effect<ProjectionStore>;
  readonly stream: (stream: DomainStream.Any, kit: StreamKit) => Effect.Effect<StreamStore>;
  /**
   * Called once every store is built. A platform that keeps events across
   * deploys starts catching up the views and projections in `targets` (every
   * consumer in the model, by `CatchUp.targetId`) that are new to it.
   */
  readonly start?: (
    targets: ReadonlyArray<string>,
    /** What a backfill needs to know of each consumer: the sources it reads, and its keys' shape. */
    planOf: (target: string) => Plan | undefined,
    /**
     * The consumers among `targets` the deploy backfills. The others fill each
     * key themselves, from its own instance (see `ViewKit.catchUp`).
     */
    backfill: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  /**
   * How much of the history recorded before a consumer (by
   * `CatchUp.targetId`) has reached it. A platform without it keeps nothing
   * across deploys, so there is no history to wait for.
   */
  readonly history?: (target: string) => Effect.Effect<HistoryJson>;
}

/** What a platform is told about a model it hosts. */
export interface HostedModel {
  readonly modelName: string;
  /** The same for every Layer of one model, and different for another model with the same name. */
  readonly id: object;
  /** The names of the model's sagas, which run on the workflow engine. */
  readonly sagas: ReadonlyArray<string>;
  /** Whether this model takes over data it shared with other models before Domain version 0: `legacyData` on its `layer`. */
  readonly legacyData: boolean;
}

/**
 * How a Domain is hosted. `model` is called once per model while its Layer is
 * built, and gives that model storage of its own: two models that use the
 * same aggregate, view or stream definition never share its data. Hosting
 * two models with the same name on one platform fails.
 *
 * Swap the platform Layer to move a Domain between infrastructures: in-memory
 * for tests and single processes, Durable Objects on Cloudflare, and so on.
 */
export class Platform extends Context.Service<
  Platform,
  {
    readonly model: (model: HostedModel) => Effect.Effect<ModelHost, never, Scope>;
  }
>()("alchemy/Domain/Platform") {}

/**
 * Track the models a platform hosts: `claim` fails while a different model
 * with the same name is hosted, since both would address the same storage.
 * The same model may be built again while an earlier build is open.
 *
 * @internal
 */
export const hostedModels = ({
  release,
}: {
  /**
   * Free a model's name when its build closes, so it can be built again as
   * a redeploy. A platform whose builds outlive their scope, like a Worker's
   * init, keeps every name for as long as it runs.
   */
  readonly release: boolean;
}) => {
  const hosted = new Map<string, { readonly id: object; builds: number }>();
  return (modelName: string, id: object): Effect.Effect<void, never, Scope> =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        const held = hosted.get(modelName);
        if (held !== undefined && held.id !== id) {
          return Effect.die(
            new DefinitionError({ reason: new ModelHostedTwice({ model: modelName }) }),
          );
        }
        if (held === undefined) hosted.set(modelName, { id, builds: 1 });
        else held.builds++;
        return Effect.void;
      }),
      // Built again after this build closes (a redeploy), the name is free.
      () =>
        Effect.sync(() => {
          if (!release) return;
          const held = hosted.get(modelName);
          if (held !== undefined && --held.builds === 0) hosted.delete(modelName);
        }),
    );
};

/**
 * How a platform counts a run that waits for another run's work: a read
 * `atLeast` a write that polls until its view or projection has it. The
 * manual in-memory platform (a story) runs one queued item at a time, until
 * every run it started is finished or waiting; it provides this so a poll is
 * waiting and the run it waits for can start. Other platforms run their work
 * concurrently and leave it as is.
 *
 * @internal
 */
export const RunWait = Context.Reference<
  <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
>("alchemy/Domain/Platform/RunWait", { defaultValue: () => runDirectly });

/** {@link RunWait} on a platform that does not manage its runs' waits. @internal */
export const runDirectly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect;
