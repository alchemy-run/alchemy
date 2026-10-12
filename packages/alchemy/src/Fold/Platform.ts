import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { HttpEffect } from "../Http.ts";
import type * as Aggregate from "./Aggregate.ts";
import type * as Policy from "./Policy.ts";
import type * as View from "./View.ts";

/**
 * Everything a platform persists or sends is plain JSON. The kernel owns the
 * schemas; platforms only move and store these values.
 */
export type Json = unknown;

/**
 * An event envelope in JSON form. `at` is epoch milliseconds.
 */
export interface EnvelopeJson {
  readonly id: string;
  readonly stream: string;
  readonly seq: number;
  readonly at: number;
  readonly commandId: string;
}

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
  readonly target: { readonly kind: "view" | "policy"; readonly name: string };
  /** The target instance key (an aggregate id; the source stream for policies). */
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
  readonly state?: Json | null;
  /** Seeded history (story `given`): views apply it, policies ignore it. */
  readonly history?: boolean;
}

/**
 * A client's live read (`watch` or `events`) of one key, in JSON form. A
 * platform that pushes keeps it with the connection (on a WebSocket's
 * attachment, so a hibernated object can resume pushing) and asks the kit's
 * `push` what to send after each commit.
 */
export interface Subscription {
  /** The client's request id, echoed as is (the client matches it by identity). */
  readonly requestId: string | number;
  readonly mode: "watch" | "events";
  /** The client's filter: it narrows what a permitted read sends. */
  readonly where?: Json;
  /** The context the read's middleware provided (see `Command.Context`), for `validate`. */
  readonly context: Readonly<Record<string, Json>>;
  /** Progress: the last state version (`watch`) or event `seq` (`events`) sent. */
  readonly cursor: number;
  /** Set when the read was refused before reaching the key: the encoded `Exit` to send. */
  readonly refused?: Json;
}

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
  readonly state: Json | null;
  readonly version: number;
  readonly command: Json;
  readonly commandId: string;
  /** The context the command was sent with (see `Command.Context`). */
  readonly context: Readonly<Record<string, Json>>;
  /** Epoch milliseconds. */
  readonly now: number;
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
      readonly reply: Json | null;
      readonly deliveries: ReadonlyArray<Delivery>;
    };

/**
 * The receipt of an accepted command, in JSON form.
 */
export interface ReceiptJson {
  readonly stream: string;
  readonly version: number;
  readonly events: ReadonlyArray<Json>;
  readonly reply: Json | null;
}

/**
 * Result of {@link AggregateStore.send}.
 */
export type SendResult =
  | { readonly _tag: "Rejected"; readonly rejection: Json }
  | { readonly _tag: "Accepted"; readonly receipt: ReceiptJson };

/**
 * The kernel for one aggregate type, handed to a platform.
 */
export interface AggregateKit {
  readonly name: string;
  /**
   * Decide, evolve, reply and route, purely. Throws only on a bug (an evolve
   * guard, an undecodable value); a platform turns that into a defect.
   */
  readonly handle: (input: HandleInput) => HandleResult;
  /**
   * Fold already-decided events into state and route them, without running
   * `decide`. Used to seed history (story `given`).
   */
  readonly seed: (input: SeedInput) => SeedResult;
  /** Route a delivery produced by `handle` to its target's host. */
  readonly deliver: (delivery: Delivery) => Effect.Effect<void>;
  /**
   * What a subscriber of instance `id` receives, given its current state and
   * the events committed since (at least those after the subscription's cursor).
   */
  readonly push: (
    id: string,
    subscription: Subscription,
    current: { readonly state: Json | null; readonly version: number },
    events: ReadonlyArray<StoredEvent>,
  ) => Effect.Effect<Push>;
}

/**
 * Input to {@link AggregateKit.seed}.
 */
export interface SeedInput {
  readonly id: string;
  readonly state: Json | null;
  readonly version: number;
  readonly events: ReadonlyArray<Json>;
  readonly commandId: string;
  readonly now: number;
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
   * restarts) and at least once. Replaces a pending one with the same
   * `commandId`. Rejections are impossible: only non-rejecting commands are
   * scheduled.
   */
  readonly schedule: (
    id: string,
    command: Json,
    meta: Aggregate.SendMeta,
    due: Aggregate.Due,
  ) => Effect.Effect<void>;
  /** Read the stored state of an instance. */
  readonly state: (
    id: string,
  ) => Effect.Effect<{ readonly state: Json | null; readonly version: number }>;
  /** Read the committed events of an instance (tests and diagnostics; optional). */
  readonly events?: (id: string) => Effect.Effect<ReadonlyArray<StoredEvent>>;
  /** The stored state and version of an instance, then every new one. */
  readonly changes: (
    id: string,
  ) => Stream.Stream<{ readonly state: Json | null; readonly version: number }>;
  /** Committed events with `seq > after`, then live ones. */
  readonly tail: (id: string, after: number) => Stream.Stream<StoredEvent>;
  /**
   * Append events without deciding. They reach views as history, and never
   * trigger policies (tests; optional).
   */
  readonly seed?: (id: string, events: ReadonlyArray<Json>) => Effect.Effect<void>;
  /**
   * Accept a WebSocket upgrade (the current request) for a live read of
   * `key`, then push to it on every commit. Optional: without it, live reads
   * are streamed responses over `changes` and `tail`.
   */
  readonly connect?: (key: string, subscription: Subscription) => HttpEffect;
}

/**
 * The stored state of one view key.
 */
export interface ViewSnapshot {
  /** The encoded state, or `null` when the key does not exist. */
  readonly state: Json | null;
  /** Number of applied deliveries. */
  readonly version: number;
  /** Last applied `seq` per source. */
  readonly checkpoints: Readonly<Record<string, number>>;
  /** Number of events the key has emitted. */
  readonly seq: number;
}

/** The snapshot of a key that has never received a delivery. */
export const emptySnapshot: ViewSnapshot = { state: null, version: 0, checkpoints: {}, seq: 0 };

/**
 * One event a view key emitted, with the key's state after it.
 */
export interface ViewEntry {
  readonly seq: number;
  readonly event: Json;
  readonly envelope: EnvelopeJson;
  readonly state: Json | null;
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
  ) => {
    readonly snapshot: ViewSnapshot;
    /** `false` when every delivery was a duplicate. */
    readonly changed: boolean;
    readonly entries: ReadonlyArray<ViewEntry>;
    readonly downstream: ReadonlyArray<Delivery>;
  };
  /** Route a downstream delivery to its target's host. */
  readonly deliver: (delivery: Delivery) => Effect.Effect<void>;
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
 * What a platform provides for a view.
 */
export interface ViewStore {
  /** Apply deliveries to one key (single writer per key), then forward downstream deliveries. */
  readonly receive: (key: string, deliveries: ReadonlyArray<Delivery>) => Effect.Effect<void>;
  readonly read: (key: string) => Effect.Effect<ViewSnapshot>;
  /** The current snapshot, then every new one. */
  readonly changes: (key: string) => Stream.Stream<ViewSnapshot>;
  /** Every entry of a key. */
  readonly list: (key: string) => Effect.Effect<ReadonlyArray<ViewEntry>>;
  /** Entries with `seq > after`, then live entries. */
  readonly tail: (key: string, after: number) => Stream.Stream<ViewEntry>;
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
  /** Run deliveries at least once, in order per key (source instance). */
  readonly receive: (delivery: Delivery) => Effect.Effect<void>;
}

/**
 * How a Domain is hosted. One factory per concept, each called once per entity
 * while the Domain's Layer is built. A factory may declare any infrastructure
 * (Durable Objects, buckets, queues) and returns the store the kernel talks to.
 *
 * Swap the platform Layer to move a Domain between infrastructures: in-memory
 * for tests and single processes, Durable Objects on Cloudflare, and so on.
 */
export class FoldPlatform extends Context.Service<
  FoldPlatform,
  {
    readonly aggregate: (
      aggregate: Aggregate.Any,
      kit: AggregateKit,
    ) => Effect.Effect<AggregateStore>;
    readonly view: (view: View.Any, kit: ViewKit) => Effect.Effect<ViewStore>;
    readonly policy: (policy: Policy.Any, kit: PolicyKit) => Effect.Effect<PolicyStore>;
  }
>()("alchemy/Fold/FoldPlatform") {}
