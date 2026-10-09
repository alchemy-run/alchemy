import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type * as Aggregate from "./Aggregate.ts";
import type * as Event from "./Event.ts";
import type { Filter } from "./Filter.ts";

/**
 * Raised by `waitFor` when the predicate does not hold before the timeout.
 */
export class WaitTimeout extends Data.TaggedError("WaitTimeout")<{
  readonly view: string;
  readonly key: string;
}> {}

/**
 * Raised by `query(key, { atLeast })` when the view has not applied the
 * receipt's events before the timeout.
 */
export class ConsistencyTimeout extends Data.TaggedError("ConsistencyTimeout")<{
  readonly view: string;
  readonly key: string;
  readonly stream: string;
  readonly version: number;
}> {}

/** A handler, or one handler per named route. */
type Handlers = {
  readonly [key: string]:
    | ((...args: never[]) => unknown)
    | { readonly [route: string]: ((...args: never[]) => unknown) | undefined }
    | undefined;
};

/**
 * Structural constraint satisfied by every view class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "View";
  readonly viewName: string;
  readonly definition: {
    readonly from: ReadonlyArray<Aggregate.Any | Any>;
    readonly key: Aggregate.Any;
    readonly state?: Schema.Top;
    readonly initial?: unknown;
    readonly keyOf?: Handlers;
    readonly evolve?: Handlers;
    readonly events?: ReadonlyArray<Event.Any>;
    readonly emit?: Handlers;
    readonly computed?: { readonly [name: string]: ((state: never) => unknown) | undefined };
  };
  /** Type-level only: the view's state. */
  readonly "~state": unknown;
  /** Type-level only: the events the view emits. */
  readonly "~events": unknown;
}

/** Something a view or policy can consume: an aggregate or a view. */
export type Source = Aggregate.Any | Any;

/** The state type of a view class (`null` for a view without state). */
export type StateOf<V extends Any> = V["~state"];
/** The events a view class emits. */
export type EventOf<V extends Any> = V["~events"];
/** The key aggregate of a view class. */
export type KeyOf<V extends Any> = V["definition"]["key"];

/** The name of a source. */
export type NameOf<S> = S extends Aggregate.Any
  ? S["aggregateName"]
  : S extends Any
    ? S["viewName"]
    : never;
/** The events a source produces. */
export type SourceEvent<S> = S extends Aggregate.Any
  ? Aggregate.EventOf<S>
  : S extends Any
    ? EventOf<S>
    : never;
/** The aggregate whose refs identify a source's instances. */
export type SourceKey<S> = S extends Aggregate.Any ? S : S extends Any ? KeyOf<S> : never;
/** What a source attaches to each event: a view's state after it, nothing for an aggregate. */
export type SourceState<S> = S extends Any ? StateOf<S> | null : undefined;

/**
 * One input to a view or policy: an event, the source instance it came from,
 * and (for a view source) that view's state after the event.
 */
export type Input<S> = S extends unknown
  ? SourceEvent<S> extends infer E
    ? E extends unknown
      ? {
          readonly name: NameOf<S>;
          readonly event: E;
          readonly source: Aggregate.Ref<SourceKey<S>>;
          readonly state: SourceState<S>;
        }
      : never
    : never
  : never;

type Inputs<From extends ReadonlyArray<unknown>> = Input<From[number]>;
type EventTag<From extends ReadonlyArray<unknown>> = Inputs<From>["event"] extends infer E
  ? E extends { readonly _tag: infer T extends string }
    ? T
    : never
  : never;
/**
 * What a handler may be keyed by: an event tag, or a source's name to handle
 * every event from that source.
 */
type HandlerKey<From extends ReadonlyArray<unknown>> = EventTag<From> | Inputs<From>["name"];
type InputFor<From extends ReadonlyArray<unknown>, K> =
  | Extract<Inputs<From>, { readonly event: { readonly _tag: K } }>
  | Extract<Inputs<From>, { readonly name: K }>;

/** The state of a view with state schema `S` (`null` without one). */
export type StateType<S> = S extends Schema.Top ? S["Type"] : null;
/** What a view emits: its declared events, or every event it consumes. */
export type Output<
  From extends ReadonlyArray<unknown>,
  Events extends ReadonlyArray<Event.Any>,
> = Events extends readonly [] ? Inputs<From>["event"] : Aggregate.Inst<Events[number]>;

/**
 * Where an input is delivered and what handlers receive alongside it.
 */
export interface Routing<I> {
  readonly event: I extends { readonly event: infer E } ? E : never;
  /** The source instance the event came from. */
  readonly source: I extends { readonly source: infer R } ? R : never;
  /** For a view source: its state after the event. */
  readonly state: I extends { readonly state: infer S } ? S : never;
  readonly envelope: Aggregate.Envelope;
}

/**
 * The context passed to `evolve` and `emit` handlers.
 */
export interface HandlerContext<Key extends Aggregate.Any, I> {
  /** The view instance being updated. */
  readonly key: Aggregate.Ref<Key>;
  /** The source instance the event came from. */
  readonly source: Routing<I>["source"];
  /** For a view source: its state after the event. */
  readonly state: Routing<I>["state"];
  readonly envelope: Aggregate.Envelope;
  /** The commit time of the originating event. */
  readonly at: DateTime.Utc;
}

/** The context passed to `emit` handlers. */
export interface EmitContext<Key extends Aggregate.Any, I, St> extends HandlerContext<Key, I> {
  /** This view's state before the event. */
  readonly before: St;
  /** This view's state after the event (`null` if it was deleted). */
  readonly after: St | null;
}

type KeyFn<Key extends Aggregate.Any, I> = (routing: Routing<I>) => Aggregate.Ref<Key> | undefined;
type EvolveFn<St, Key extends Aggregate.Any, I> = (
  state: St,
  event: Routing<I>["event"],
  context: HandlerContext<Key, I>,
) => St | null;
type EmitFn<St, Key extends Aggregate.Any, I, Out> = (
  event: Routing<I>["event"],
  context: EmitContext<Key, I, St>,
) => Out | ReadonlyArray<Out> | undefined;

/** A handler, or one handler per route named in `keyOf`. */
type Routed<F> = F | { readonly [route: string]: F };

/**
 * The pure definition of a view.
 */
export interface Definition<
  From extends ReadonlyArray<Source>,
  Key extends Aggregate.Any,
  S extends Schema.Top | undefined,
  Events extends ReadonlyArray<Event.Any>,
  Computed extends Record<string, unknown>,
> {
  /** The aggregates and views this view consumes. */
  readonly from: From;
  /** The aggregate whose refs key this view's instances. */
  readonly key: Key;
  /**
   * Which instance each input updates, keyed by event tag or source name. May
   * be omitted for a source keyed by the same aggregate (the source is the
   * key). Return an object of named routes to update several instances; each
   * route then gets its own `evolve` and `emit` handler.
   */
  readonly keyOf?: {
    readonly [K in HandlerKey<From>]?: Routed<KeyFn<Key, InputFor<From, K>>>;
  };
  /** Schema of the view's state. Omit it for a view that only emits events. */
  readonly state?: S;
  /** The state every instance starts from. */
  readonly initial?: StateType<S>;
  /**
   * Fold inputs into state, keyed by event tag or source name. Return `null`
   * to delete the instance.
   */
  readonly evolve?: {
    readonly [K in HandlerKey<From>]?: Routed<EvolveFn<StateType<S>, Key, InputFor<From, K>>>;
  };
  /**
   * The events this view emits. Without `events`, a view emits every event it
   * applies, unchanged.
   */
  readonly events?: Events;
  /**
   * Derive the events to emit for an input, keyed by event tag or source name.
   * Runs after `evolve`, with the state before and after. A declared event
   * with no `emit` handler passes through unchanged.
   */
  readonly emit?: {
    readonly [K in HandlerKey<From>]?: Routed<
      EmitFn<StateType<S>, Key, InputFor<From, K>, Aggregate.Inst<Events[number]>>
    >;
  };
  /** Values derived from state when read. */
  readonly computed?: ComputedFns<StateType<S>, Computed>;
}

/** Derived-value functions of a view. */
export type ComputedFns<State, Computed> = {
  readonly [K in keyof Computed]: (state: State) => Computed[K];
};

/**
 * An event a view emitted, with the view's state after it.
 */
export interface Entry<S, E, Id = string> {
  readonly event: E;
  /** The view's state after the event (`null` if deleted, or for a view without state). */
  readonly state: S | null;
  /** `id` is the view key, `stream` is `View/key`, `seq` counts the key's events. */
  readonly envelope: Aggregate.Envelope<Id>;
}

/**
 * A page of entries.
 */
export interface Page<Entry> {
  readonly entries: ReadonlyArray<Entry>;
  /** Pass as `after` to continue; `null` when there are no more entries. */
  readonly cursor: string | null;
}

/**
 * Options for watching a view key.
 */
export interface WatchOptions<S> {
  /** Only emit states matching this filter; emits `none` when filtered out. */
  readonly where?: Filter<S>;
}

/**
 * The read API of a view, obtained with `yield* MyView`.
 */
export interface Host<S, Key extends Aggregate.Any, E> {
  /** Read the current state of a key. `none` if it does not exist. */
  readonly query: (
    key: Aggregate.Ref<Key>,
    options?: { readonly atLeast?: Aggregate.Receipt; readonly timeout?: Duration.Input },
  ) => Effect.Effect<Option.Option<S>, ConsistencyTimeout>;
  /** Wait until a key's state matches a filter. */
  readonly waitFor: (
    key: Aggregate.Ref<Key>,
    where: Filter<S>,
    options: { readonly timeout: Duration.Input },
  ) => Effect.Effect<S, WaitTimeout>;
  /** The current state, then every change. */
  readonly watch: (
    key: Aggregate.Ref<Key>,
    options?: WatchOptions<S>,
  ) => Stream.Stream<Option.Option<S>>;
  /**
   * Follow a changing set of keys derived from a parent stream, emitting the
   * parent together with the current state of every key that exists and
   * matches `where`.
   */
  readonly watchEach: <P, Err, R>(
    parent: Stream.Stream<P, Err, R>,
    keysOf: (parent: P) => ReadonlyArray<Aggregate.Ref<Key>>,
    options?: WatchOptions<S>,
  ) => Stream.Stream<readonly [P, ReadonlyArray<readonly [Aggregate.Ref<Key>, S]>], Err, R>;
  /**
   * Every event the key emitted, with the state after it: history (from
   * `after`, a cursor or entry `seq`), then live.
   */
  readonly events: (
    key: Aggregate.Ref<Key>,
    options?: { readonly after?: string; readonly where?: Filter<E> },
  ) => Stream.Stream<Entry<S, E, Aggregate.IdOf<Key>>>;
  /** A page of the key's emitted events, oldest first unless `order` is `"desc"`. */
  readonly list: (
    key: Aggregate.Ref<Key>,
    options?: {
      readonly where?: Filter<E>;
      readonly order?: "asc" | "desc";
      readonly take?: number;
      readonly after?: string;
    },
  ) => Effect.Effect<Page<Entry<S, E, Aggregate.IdOf<Key>>>>;
}

/**
 * Type-level identity of a view in an Effect's requirements.
 */
export interface ViewKey<Name extends string> {
  readonly "~alchemy/Fold/View": Name;
}

/**
 * Declare a View: a keyed fold over the events of aggregates and other views.
 * A view keeps state per key (`evolve`) and emits events (`emit`), each with
 * its state after it. Downstream views and policies consume those events.
 * Views are pure, so every platform rebuilds them identically.
 *
 * The class is also a service tag: `yield* AccountSummary` gives its read API
 * (`query`, `waitFor`, `watch`, `watchEach`, `events`, `list`).
 *
 * **Example:** A read model keyed by its source
 * ```typescript
 * export class AccountSummary extends View.make("AccountSummary", {
 *   from: [Account],
 *   key: Account,
 *   state: Schema.Struct({ balance: Cents, frozen: Schema.Boolean }),
 *   initial: { balance: 0, frozen: false },
 *   evolve: {
 *     MoneyDeposited: (v, e) => ({ ...v, balance: e.balanceAfter }),
 *     AccountFrozen: (v) => ({ ...v, frozen: true }),
 *   },
 * }) {}
 * ```
 *
 * **Example:** A view that maps events, routed to two keys
 * ```typescript
 * export class AccountTransfers extends View.make("AccountTransfers", {
 *   from: [Transfer],
 *   key: Account,
 *   keyOf: {
 *     TransferRequested: {
 *       out: ({ event }) => Account.ref(event.from),
 *       in: ({ event }) => Account.ref(event.to),
 *     },
 *   },
 *   events: [TransferMoved],
 *   emit: {
 *     TransferRequested: {
 *       out: (e) => new TransferMoved({ transferId: e.transferId, amount: e.amount, direction: "out" }),
 *       in: (e) => new TransferMoved({ transferId: e.transferId, amount: e.amount, direction: "in" }),
 *     },
 *   },
 * }) {}
 * ```
 */
export const make = <
  const Name extends string,
  const From extends ReadonlyArray<Source>,
  Key extends Aggregate.Any,
  S extends Schema.Top | undefined = undefined,
  const Events extends ReadonlyArray<Event.Any> = readonly [],
  Computed extends Record<string, unknown> = {},
>(
  name: Name,
  definition: Definition<From, Key, S, Events, Computed>,
): ViewClass<
  Name,
  Definition<From, Key, S, Events, Computed>,
  S,
  StateType<S>,
  Key,
  ComputedFns<StateType<S>, Computed>,
  Output<From, Events>
> => {
  const Tag = Context.Service<ViewKey<Name>, Host<StateType<S>, Key, Output<From, Events>>>()(
    `alchemy/Fold/View/${name}`,
  );
  return class extends Tag {
    static readonly kind = "View" as const;
    static readonly viewName: Name = name;
    static readonly definition: Definition<From, Key, S, Events, Computed> = definition;
    /** The view's state schema. */
    static readonly State = definition.state;
    /** Derived values, computed from a state when read. */
    static readonly computed = definition.computed ?? {};
  } as unknown as ViewClass<
    Name,
    Definition<From, Key, S, Events, Computed>,
    S,
    StateType<S>,
    Key,
    ComputedFns<StateType<S>, Computed>,
    Output<From, Events>
  >;
};

/**
 * The class type returned by {@link make}.
 */
export interface ViewClass<
  Name extends string,
  Def,
  S extends Schema.Top | undefined,
  St,
  Key extends Aggregate.Any,
  Computed,
  Out,
> extends Context.ServiceClass<ViewKey<Name>, string, Host<St, Key, Out>> {
  readonly kind: "View";
  readonly viewName: Name;
  readonly definition: Def;
  /** The view's state schema. */
  readonly State: S;
  /** Derived values, computed from a state when read. */
  readonly computed: Computed;
  readonly "~state": St;
  readonly "~events": Out;
}
