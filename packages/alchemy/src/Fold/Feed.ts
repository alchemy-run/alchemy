import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type * as Aggregate from "./Aggregate.ts";
import type * as Event from "./Event.ts";
import type { Filter, OrderBy } from "./Filter.ts";

/**
 * Structural constraint satisfied by every feed class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Feed";
  readonly feedName: string;
  readonly definition: {
    readonly from: ReadonlyArray<Aggregate.Any>;
    readonly key: Aggregate.Any;
    readonly entry?: Schema.Top;
    readonly events?: ReadonlyArray<Event.Any>;
    readonly map?: { readonly [tag: string]: ((...args: any[]) => unknown) | undefined };
    readonly keyOf?: { readonly [tag: string]: ((...args: any[]) => unknown) | undefined };
  };
}

type SourceEvent<From extends ReadonlyArray<Aggregate.Any>> = Aggregate.EventOf<From[number]>;
type EventTag<From extends ReadonlyArray<Aggregate.Any>> =
  SourceEvent<From> extends {
    readonly _tag: infer T extends string;
  }
    ? T
    : never;
type EventFor<From extends ReadonlyArray<Aggregate.Any>, T> = Extract<
  SourceEvent<From>,
  { readonly _tag: T }
>;

/**
 * A raw-event feed entry: the event plus its envelope.
 */
export interface Recorded<E> {
  readonly event: E;
  readonly envelope: Aggregate.Envelope;
}

/**
 * Context passed to a feed's `map` handlers.
 */
export interface MapContext<Key extends Aggregate.Any> {
  /** The feed key the entry is being appended to. */
  readonly key: Aggregate.Ref<Key>;
  /** The commit time of the event. */
  readonly at: Aggregate.Envelope["at"];
  /** The full envelope of the event. */
  readonly envelope: Aggregate.Envelope;
}

type KeyOfDefinition<From extends ReadonlyArray<Aggregate.Any>, Key extends Aggregate.Any> = {
  readonly [T in EventTag<From>]?: (routing: {
    readonly event: EventFor<From, T>;
    readonly source: Aggregate.Ref;
    readonly envelope: Aggregate.Envelope;
  }) => Aggregate.Ref<Key> | ReadonlyArray<Aggregate.Ref<Key>> | undefined;
};

/**
 * A feed that maps events to entries of its own schema.
 */
export interface MappedDefinition<
  From extends ReadonlyArray<Aggregate.Any>,
  Key extends Aggregate.Any,
  Entry extends Schema.Top,
> {
  readonly from: From;
  readonly key: Key;
  readonly keyOf?: KeyOfDefinition<From, Key>;
  /** Schema of each entry. */
  readonly entry: Entry;
  /** One handler per consumed event: the entry to append, or `undefined` to skip. */
  readonly map: {
    readonly [T in EventTag<From>]?: (
      event: EventFor<From, T>,
      context: MapContext<Key>,
    ) => Entry["Type"] | undefined;
  };
}

/**
 * A feed that records events as-is.
 */
export interface RawDefinition<
  From extends ReadonlyArray<Aggregate.Any>,
  Key extends Aggregate.Any,
  Events extends ReadonlyArray<Event.Any>,
> {
  readonly from: From;
  readonly key: Key;
  readonly keyOf?: KeyOfDefinition<From, Key>;
  /** The events to record. */
  readonly events: Events;
}

/**
 * A page of feed entries.
 */
export interface Page<Entry> {
  readonly entries: ReadonlyArray<Entry>;
  /** Pass as `after` to continue; `null` when there are no more entries. */
  readonly cursor: string | null;
}

/**
 * Options for listing a feed.
 */
export interface ListOptions<Entry> {
  readonly where?: Filter<Entry>;
  readonly orderBy?: OrderBy<Entry>;
  readonly take?: number;
  readonly after?: string | undefined;
}

/**
 * The read API of a feed, obtained with `yield* MyFeed`.
 */
export interface Host<Entry, Key extends Aggregate.Any> {
  /** List entries for a key, oldest first unless `orderBy` says otherwise. */
  readonly list: (
    key: Aggregate.Ref<Key>,
    options?: ListOptions<Entry>,
  ) => Effect.Effect<Page<Entry>>;
  /** Every entry appended after `after` (or from the start), then live entries. */
  readonly tail: (
    key: Aggregate.Ref<Key>,
    options?: { readonly after?: string; readonly where?: Filter<Entry> },
  ) => Stream.Stream<Entry>;
}

/** The entry type of a feed class. */
export type EntryOf<F extends Any> = F["definition"] extends { readonly entry: Schema.Top }
  ? F["definition"]["entry"]["Type"]
  : F["definition"] extends { readonly events: ReadonlyArray<Event.Any> }
    ? Recorded<Aggregate.Inst<F["definition"]["events"][number]>>
    : never;

/**
 * Type-level identity of a feed in an Effect's requirements.
 */
export interface FeedKey<Name extends string> {
  readonly "~alchemy/Fold/Feed": Name;
}

/**
 * Declare a Feed: a keyed, append-only list of entries derived from events.
 *
 * **Example:** A mapped feed
 * ```typescript
 * export class Statement extends Feed.make("Statement", {
 *   from: [Account],
 *   key: Account,
 *   entry: Schema.Struct({ at: Schema.DateTimeUtc, amount: Cents }),
 *   map: {
 *     MoneyDeposited: (e, { at }) => ({ at, amount: e.amount }),
 *   },
 * }) {}
 * ```
 *
 * **Example:** A raw event feed
 * ```typescript
 * export class AccountActivity extends Feed.make("AccountActivity", {
 *   from: [Account],
 *   key: Account,
 *   events: [AccountFrozen, AccountClosed],
 * }) {}
 * ```
 */
export function make<
  const Name extends string,
  const From extends ReadonlyArray<Aggregate.Any>,
  Key extends Aggregate.Any,
  Entry extends Schema.Top,
>(
  name: Name,
  definition: MappedDefinition<From, Key, Entry>,
): FeedClass<Name, MappedDefinition<From, Key, Entry>, Entry["Type"], Key>;
export function make<
  const Name extends string,
  const From extends ReadonlyArray<Aggregate.Any>,
  Key extends Aggregate.Any,
  const Events extends ReadonlyArray<Event.Any>,
>(
  name: Name,
  definition: RawDefinition<From, Key, Events>,
): FeedClass<Name, RawDefinition<From, Key, Events>, Recorded<Aggregate.Inst<Events[number]>>, Key>;
export function make(name: string, definition: Any["definition"]): unknown {
  const Tag = Context.Service<FeedKey<string>, Host<unknown, Aggregate.Any>>()(
    `alchemy/Fold/Feed/${name}`,
  );
  return class extends Tag {
    static readonly kind = "Feed" as const;
    static readonly feedName = name;
    static readonly definition = definition;
  };
}

/**
 * The class type returned by {@link make}.
 */
export interface FeedClass<
  Name extends string,
  Def,
  Entry,
  Key extends Aggregate.Any,
> extends Context.ServiceClass<FeedKey<Name>, string, Host<Entry, Key>> {
  readonly kind: "Feed";
  readonly feedName: Name;
  readonly definition: Def;
}
