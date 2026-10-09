import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type * as Aggregate from "./Aggregate.ts";
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

/**
 * A change record delivered to views that consume another view.
 */
export interface Change<Key extends Aggregate.Any, S> {
  /** The key of the source view instance that changed. */
  readonly source: Aggregate.Ref<Key>;
  /** The source state before the change (`null` if it did not exist). */
  readonly before: S | null;
  /** The source state after the change (`null` if it was deleted). */
  readonly after: S | null;
}

/**
 * Structural constraint satisfied by every view class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "View";
  readonly viewName: string;
  readonly definition: {
    readonly from: ReadonlyArray<Aggregate.Any | Any>;
    readonly key: Aggregate.Any;
    readonly state: Schema.Top;
    readonly initial: unknown;
    readonly evolve: { readonly [tag: string]: ((...args: any[]) => unknown) | undefined };
    readonly keyOf?: { readonly [tag: string]: ((...args: any[]) => unknown) | undefined };
    readonly computed?: { readonly [name: string]: ((state: any) => unknown) | undefined };
  };
}

type Sources<From extends ReadonlyArray<unknown>> = From[number];
type AggregateSources<From extends ReadonlyArray<unknown>> = Extract<Sources<From>, Aggregate.Any>;
type ViewSources<From extends ReadonlyArray<unknown>> = Extract<Sources<From>, Any>;
type SourceEvent<From extends ReadonlyArray<unknown>> = Aggregate.EventOf<AggregateSources<From>>;
type EventTag<From extends ReadonlyArray<unknown>> =
  SourceEvent<From> extends { readonly _tag: infer T extends string } ? T : never;
type EventFor<From extends ReadonlyArray<unknown>, T> = Extract<
  SourceEvent<From>,
  { readonly _tag: T }
>;
type ViewFor<From extends ReadonlyArray<unknown>, Name> = Extract<
  ViewSources<From>,
  { readonly viewName: Name }
>;
type HandlerKey<From extends ReadonlyArray<unknown>> =
  | EventTag<From>
  | ViewSources<From>["viewName"];

/** The state type of a view class. */
export type StateOf<V extends Any> = V["definition"]["state"]["Type"];
/** The key aggregate of a view class. */
export type KeyOf<V extends Any> = V["definition"]["key"];

/**
 * Context for routing an event to view keys.
 */
export interface EventRouting<E> {
  readonly event: E;
  readonly source: Aggregate.Ref;
  readonly envelope: Aggregate.Envelope;
}

/**
 * The pure definition of a view.
 */
export interface Definition<
  From extends ReadonlyArray<Aggregate.Any | Any>,
  Key extends Aggregate.Any,
  S extends Schema.Top,
  Computed extends Record<string, unknown>,
> {
  /** The aggregates (events) and views (changes) this view consumes. */
  readonly from: From;
  /** The aggregate whose refs key this view's instances. */
  readonly key: Key;
  /**
   * Where each event or view change is delivered. May be omitted for events
   * whose source aggregate is the key aggregate (the source is the key), and
   * for views keyed by the same aggregate.
   */
  readonly keyOf?: {
    readonly [K in HandlerKey<From>]?: K extends EventTag<From>
      ? (
          routing: EventRouting<EventFor<From, K>>,
        ) => Aggregate.Ref<Key> | ReadonlyArray<Aggregate.Ref<Key>> | undefined
      : (state: StateOf<ViewFor<From, K>>) => Aggregate.Ref<Key> | undefined;
  };
  /** Schema of the view's state. */
  readonly state: S;
  /** The state every key starts from. */
  readonly initial: S["Type"];
  /**
   * One handler per consumed event or view: folds it into state. Return
   * `null` to delete the key.
   */
  readonly evolve: {
    readonly [K in HandlerKey<From>]?: K extends EventTag<From>
      ? (
          state: S["Type"],
          event: EventFor<From, K>,
          envelope: Aggregate.Envelope,
        ) => S["Type"] | null
      : (
          state: S["Type"],
          change: Change<KeyOf<ViewFor<From, K>>, StateOf<ViewFor<From, K>>>,
        ) => S["Type"] | null;
  };
  /** Values derived from state when read. */
  readonly computed?: ComputedFns<S["Type"], Computed>;
}

/** Derived-value functions of a view. */
export type ComputedFns<State, Computed> = {
  readonly [K in keyof Computed]: (state: State) => Computed[K];
};

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
export interface Host<S, Key extends Aggregate.Any> {
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
  readonly watchEach: <P, E, R>(
    parent: Stream.Stream<P, E, R>,
    keysOf: (parent: P) => ReadonlyArray<Aggregate.Ref<Key>>,
    options?: WatchOptions<S>,
  ) => Stream.Stream<readonly [P, ReadonlyArray<readonly [Aggregate.Ref<Key>, S]>], E, R>;
}

/**
 * Type-level identity of a view in an Effect's requirements.
 */
export interface ViewKey<Name extends string> {
  readonly "~alchemy/Fold/View": Name;
}

/**
 * Declare a View: a keyed read model built by folding events (and other
 * views' changes) into state. Views are pure, so every platform rebuilds them
 * identically.
 *
 * The class is also a service tag: `yield* AccountSummary` gives its read API
 * (`query`, `waitFor`, `watch`, `watchEach`).
 *
 * **Example:** A single-source view keyed by its source
 * ```typescript
 * export class AccountSummary extends View.make("AccountSummary", {
 *   from: [Account],
 *   key: Account,
 *   state: Schema.Struct({ balance: Cents, frozen: Schema.Boolean }),
 *   initial: { balance: 0, frozen: false },
 *   evolve: {
 *     MoneyDeposited: (v, e) => ({ ...v, balance: e.balanceAfter }),
 *     AccountFrozen: (v) => ({ ...v, frozen: true }),
 *     AccountClosed: () => null,
 *   },
 * }) {}
 * ```
 */
export const make = <
  const Name extends string,
  const From extends ReadonlyArray<Aggregate.Any | Any>,
  Key extends Aggregate.Any,
  S extends Schema.Top,
  Computed extends Record<string, unknown> = {},
>(
  name: Name,
  definition: Definition<From, Key, S, Computed>,
): ViewClass<
  Name,
  Definition<From, Key, S, Computed>,
  S,
  Key,
  ComputedFns<S["Type"], Computed>
> => {
  const Tag = Context.Service<ViewKey<Name>, Host<S["Type"], Key>>()(`alchemy/Fold/View/${name}`);
  return class extends Tag {
    static readonly kind = "View" as const;
    static readonly viewName: Name = name;
    static readonly definition: Definition<From, Key, S, Computed> = definition;
    /** The view's state schema. */
    static readonly State: S = definition.state;
    /** Derived values, computed from a state when read. */
    static readonly computed = definition.computed ?? {};
  } as unknown as ViewClass<
    Name,
    Definition<From, Key, S, Computed>,
    S,
    Key,
    ComputedFns<S["Type"], Computed>
  >;
};

/**
 * The class type returned by {@link make}.
 */
export interface ViewClass<
  Name extends string,
  Def,
  S extends Schema.Top,
  Key extends Aggregate.Any,
  Computed,
> extends Context.ServiceClass<ViewKey<Name>, string, Host<S["Type"], Key>> {
  readonly kind: "View";
  readonly viewName: Name;
  readonly definition: Def;
  /** The view's state schema. */
  readonly State: S;
  /** Derived values, computed from a state when read. */
  readonly computed: Computed;
}
