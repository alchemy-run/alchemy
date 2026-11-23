import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import type { Annotations } from "./Annotations.ts";

/** The pure definition of a compaction. */
export interface Definition<A extends Aggregate.Any> {
  /** The aggregate whose instances it compacts. */
  readonly of: A;
  /**
   * The events that stand in for an instance's whole history, from its
   * current state. Folding them from `initial` must give that state back:
   * a compaction that would lose anything is refused with
   * {@link CompactionLossy}. They are ordinary events of the aggregate, so
   * `evolve` has a handler for each, and so does every view that reads the
   * aggregate and should survive being rebuilt.
   */
  readonly rollup: (
    state: Aggregate.StateOf<A>,
    ctx: { readonly id: Aggregate.IdOf<A>; readonly version: number },
  ) => ReadonlyArray<Aggregate.EventOf<A>>;
}

/** One run of events a compaction is about to remove, oldest first. */
export interface Batch<A extends Aggregate.Any> {
  /** The instance being compacted. */
  readonly id: Aggregate.IdOf<A>;
  /** Its stream, e.g. `Account/a-1`. */
  readonly stream: string;
  readonly events: ReadonlyArray<{
    readonly event: Aggregate.EventOf<A>;
    readonly envelope: Aggregate.Envelope<Aggregate.IdOf<A>>;
  }>;
}

/**
 * A compaction's handler: given each run of events before they are removed,
 * to keep them wherever you like (a bucket, another database) or nowhere.
 * The events are removed only once it succeeds, and it runs at least once
 * per run, so make its writes idempotent (a key from the stream and the
 * first and last `seq` is). Resolve your store while building it, in
 * `toLayer`; the handler itself may only need the runtime it runs in.
 */
export type Handler<A extends Aggregate.Any> = (
  batch: Batch<A>,
) => Effect.Effect<void, never, RuntimeContext>;

/** How a compaction's Layer tunes it. These are variants: they never change what it means. */
export interface Options {
  /**
   * Compact an instance by itself once it holds more than this many events
   * since it last compacted. Each instance checks after its own commits, so
   * one that never commits again keeps its events. Without it, an instance
   * compacts only when `client.compact` is called.
   */
  readonly after?: { readonly events: number };
}

/** A compaction's implementation, as its Layer provides it. @internal */
export interface Implementation<A extends Aggregate.Any> {
  readonly handle: Handler<A>;
  readonly options: Options;
}

/** Structural constraint satisfied by every compaction class. */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Compaction";
  readonly annotations: Annotations;
  readonly compactionName: string;
  readonly definition: {
    readonly of: Aggregate.Any;
    readonly rollup: (state: never, ctx: never) => ReadonlyArray<{ readonly _tag: string }>;
  };
}

/** The requirement identifier of a compaction class. */
export type Identifier<C extends Any> = C extends Context.Key<infer I, unknown> ? I : never;

/** Type-level identity of a compaction in an Effect's requirements. */
export interface CompactionKey<Name extends string> {
  readonly "~alchemy/Domain/Compaction": Name;
}

/**
 * What accepting a compaction returns. The roll-up is committed by then; the
 * events behind it are handed to the handler and removed afterwards.
 */
export const Receipt = Schema.Struct({
  /** The stream that was compacted, e.g. `Account/a-1`. */
  stream: Schema.String,
  /** The stream's version after the roll-up. */
  version: Schema.Number,
  /** How many events the roll-up replaces. */
  compacted: Schema.Number,
});
export type Receipt = typeof Receipt.Type;

/**
 * Folding the roll-up from `initial` did not give the instance's state back,
 * so nothing was compacted.
 */
export class CompactionLossy extends Schema.TaggedError<CompactionLossy>()("CompactionLossy", {
  aggregate: Schema.String,
  id: Schema.String,
  compaction: Schema.String,
}) {
  override get message() {
    return `${this.compaction} would change the state of ${this.aggregate}/${this.id}: folding its roll-up from initial does not give the state back`;
  }
}

/**
 * Replaces an instance's history with a few events that carry its state, so
 * its log stops growing. The declaration says what the roll-up is; its Layer
 * says where the replaced events go and when an instance compacts.
 *
 * Views and projections keep what they already built: a compaction tells
 * them nothing but the roll-up events themselves, which they receive like
 * any other. Commands keep flowing while it runs.
 *
 * ### Declaring the roll-up
 * **Example:** One event carrying the account
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { Account, AccountBroughtForward } from "./Account.ts";
 *
 * export class BringForward extends Domain.Compaction("BringForward", {
 *   of: Account,
 *   rollup: (account) => [new AccountBroughtForward({ state: account })],
 * }) {}
 * ```
 *
 * ### Keeping what it removes
 * The handler gets each run of events before they are removed. Build it with
 * any binding.
 *
 * **Example:** Archive to a bucket, and compact every 1,000 events
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Effect from "effect/Effect";
 * import { Archive } from "./Archive.ts";
 * import { BringForward } from "./BringForward.ts";
 *
 * export const BringForwardLive = BringForward.toLayer(
 *   Effect.gen(function* () {
 *     const archive = yield* Cloudflare.R2.WriteBucket(Archive);
 *     return Effect.fn(function* ({ stream, events }) {
 *       const first = events[0].envelope.seq;
 *       const last = events[events.length - 1].envelope.seq;
 *       yield* archive.put(`${stream}/${first}-${last}.json`, JSON.stringify(events)).pipe(Effect.orDie);
 *     });
 *   }).pipe(Effect.provide(Cloudflare.R2.WriteBucketBinding)),
 *   { after: { events: 1_000 } },
 * );
 * ```
 *
 * ### Compacting at a moment of your choosing
 * **Example:** When an account closes
 * ```typescript
 * const accounts = yield* Account;
 * yield* accounts.compact(accountId, BringForward);
 * ```
 *
 * @primitive
 */
export const make = <const Name extends string, A extends Aggregate.Any>(
  name: Name,
  definition: Definition<A>,
  annotations: Annotations = {},
): CompactionClass<Name, A> => {
  const Tag = Context.Service<CompactionKey<Name>, Implementation<A>>()(
    `alchemy/Domain/Compaction/${name}`,
  );
  return class extends Tag {
    static readonly kind = "Compaction" as const;
    static readonly annotations: Annotations = annotations;
    static readonly compactionName: Name = name;
    static readonly definition = definition;
    static toLayer<E, R>(build: Effect.Effect<Handler<A>, E, R>, options: Options = {}) {
      return Layer.effect(
        Tag,
        Effect.map(build, (handle): Implementation<A> => ({ handle, options })),
      );
    }
  } as unknown as CompactionClass<Name, A>;
};

/** The class type returned by {@link make}. */
export interface CompactionClass<
  Name extends string,
  A extends Aggregate.Any,
> extends Context.ServiceClass<CompactionKey<Name>, string, Implementation<A>> {
  readonly kind: "Compaction";
  readonly annotations: Annotations;
  readonly compactionName: Name;
  readonly definition: Definition<A>;
  /**
   * Implement the compaction. The construction Effect runs once, resolving
   * wherever the replaced events go; the handler requires nothing. `options`
   * say when an instance compacts by itself.
   */
  toLayer<E, R>(
    build: Effect.Effect<Handler<A>, E, R>,
    options?: Options,
  ): Layer.Layer<CompactionKey<Name>, E, R>;
}
