import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type * as Aggregate from "./Aggregate.ts";
import type * as Feed from "./Feed.ts";
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
 * The payload of a delivery: an event, or another view's change.
 */
export type DeliveryBody =
  | {
      readonly type: "event";
      readonly tag: string;
      readonly event: Json;
      readonly envelope: EnvelopeJson;
    }
  | {
      readonly type: "change";
      readonly view: string;
      readonly key: string;
      readonly before: Json | null;
      readonly after: Json | null;
    };

/**
 * A unit of work routed from one host to another: an event to a view, feed or
 * policy, or a view change to a downstream view. Deliveries are at least once;
 * targets drop duplicates by `(source, seq)`. Platforms must deliver in order
 * per `(source, target)`.
 */
export interface Delivery {
  readonly target: { readonly kind: "view" | "feed" | "policy"; readonly name: string };
  /** The target instance key (an aggregate id; the source stream for policies). */
  readonly key: string;
  /** The source stream, e.g. `Account/a-1` or `AccountSummary/a-1`. */
  readonly source: string;
  /** The source's sequence number (event seq, or view version). */
  readonly seq: number;
  readonly body: DeliveryBody;
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
  /** Read the stored state of an instance. */
  readonly state: (
    id: string,
  ) => Effect.Effect<{ readonly state: Json | null; readonly version: number }>;
  /** Read the committed events of an instance (tests and diagnostics; optional). */
  readonly events?: (id: string) => Effect.Effect<ReadonlyArray<StoredEvent>>;
  /**
   * Append events without deciding, routing them to views and feeds but not
   * policies (tests; optional).
   */
  readonly seed?: (id: string, events: ReadonlyArray<Json>) => Effect.Effect<void>;
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
}

/** The snapshot of a key that has never received a delivery. */
export const emptySnapshot: ViewSnapshot = { state: null, version: 0, checkpoints: {} };

/**
 * The kernel for one view, handed to a platform.
 */
export interface ViewKit {
  readonly name: string;
  /** Apply deliveries to a key's snapshot. Drops duplicates. */
  readonly apply: (
    key: string,
    snapshot: ViewSnapshot,
    deliveries: ReadonlyArray<Delivery>,
  ) => {
    readonly snapshot: ViewSnapshot;
    readonly changed: boolean;
    readonly downstream: ReadonlyArray<Delivery>;
  };
  /** Route a downstream delivery to its target's host. */
  readonly deliver: (delivery: Delivery) => Effect.Effect<void>;
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
}

/**
 * The stored cursor state of one feed key.
 */
export interface FeedState {
  readonly seq: number;
  readonly checkpoints: Readonly<Record<string, number>>;
}

/** The state of a feed key that has never received a delivery. */
export const emptyFeedState: FeedState = { seq: 0, checkpoints: {} };

/**
 * One stored feed entry.
 */
export interface FeedEntry {
  readonly seq: number;
  readonly entry: Json;
}

/**
 * The kernel for one feed, handed to a platform.
 */
export interface FeedKit {
  readonly name: string;
  /** Map deliveries to new entries for a key. Drops duplicates. */
  readonly append: (
    key: string,
    state: FeedState,
    deliveries: ReadonlyArray<Delivery>,
  ) => { readonly state: FeedState; readonly entries: ReadonlyArray<FeedEntry> };
}

/**
 * What a platform provides for a feed.
 */
export interface FeedStore {
  readonly receive: (key: string, deliveries: ReadonlyArray<Delivery>) => Effect.Effect<void>;
  readonly list: (key: string) => Effect.Effect<ReadonlyArray<FeedEntry>>;
  /** Entries with `seq > after`, then live entries. */
  readonly tail: (key: string, after: number) => Stream.Stream<FeedEntry>;
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
    readonly feed: (feed: Feed.Any, kit: FeedKit) => Effect.Effect<FeedStore>;
    readonly policy: (policy: Policy.Any, kit: PolicyKit) => Effect.Effect<PolicyStore>;
  }
>()("alchemy/Fold/FoldPlatform") {}
