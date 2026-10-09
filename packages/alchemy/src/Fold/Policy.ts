import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Aggregate from "./Aggregate.ts";
import type * as Event from "./Event.ts";
import type * as View from "./View.ts";

/**
 * What a policy receives for each event it subscribes to.
 */
export interface Trigger<From extends View.Source, E> {
  /** The aggregate or view instance the event came from. */
  readonly source: Aggregate.Ref<View.SourceKey<From>>;
  /** The event. */
  readonly event: E;
  /** The event's envelope. */
  readonly envelope: Aggregate.Envelope<Aggregate.IdOf<View.SourceKey<From>>>;
  /** For a view source: the view's state after the event. */
  readonly state: View.SourceState<From>;
}

/**
 * A policy's handler. It runs after the triggering event commits, at least
 * once, in order per source instance. Every failure must be handled: send a
 * command or ignore it. It requires nothing: resolve aggregate clients, Ports
 * and views while building it, in `toLayer`.
 */
export type Handler<T> = (trigger: T) => Effect.Effect<void>;

/**
 * Structural constraint satisfied by every policy class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Policy";
  readonly policyName: string;
  readonly definition: {
    readonly from: View.Source;
    readonly on: ReadonlyArray<Event.Any>;
  };
}

/** The trigger type of a policy class. */
export type TriggerOf<P extends Any> = Trigger<
  P["definition"]["from"],
  Aggregate.Inst<P["definition"]["on"][number]>
>;

/** The requirement identifier of a policy class. */
export type Identifier<P extends Any> = P extends Context.Key<infer I, unknown> ? I : never;

/**
 * Type-level identity of a policy in an Effect's requirements.
 */
export interface PolicyKey<Name extends string> {
  readonly "~alchemy/Fold/Policy": Name;
}

/**
 * Declare a Policy: "whenever these events happen, do this". A policy reacts
 * by sending commands and calling Ports. It listens to an aggregate, or to a
 * view's emitted events (receiving the view's state with each).
 *
 * The class is the contract; its implementation is a Layer built with
 * `toLayer`, so it can depend on Ports and other services.
 *
 * **Example:** A policy with a Port call
 * ```typescript
 * export class FraudReview extends Policy.make("FraudReview", {
 *   from: Account,
 *   on: [MoneyWithdrawn],
 * }) {}
 *
 * export const FraudReviewLive = FraudReview.toLayer(
 *   Effect.gen(function* () {
 *     const fraud = yield* FraudCheck;
 *     const accounts = yield* Account;
 *     return Effect.fn(function* ({ source, event }) {
 *       const { risk } = yield* fraud.score({ accountId: source.id, amount: event.amount });
 *       if (risk > 0.8) yield* accounts.send(source, new Freeze({ reason: "fraud" }));
 *     });
 *   }),
 * );
 * ```
 */
export const make = <
  const Name extends string,
  From extends View.Source,
  const On extends ReadonlyArray<Event.Any>,
>(
  name: Name,
  definition: { readonly from: From; readonly on: On },
): PolicyClass<Name, From, On> => {
  const Tag = Context.Service<
    PolicyKey<Name>,
    Handler<Trigger<From, Aggregate.Inst<On[number]>>>
  >()(`alchemy/Fold/Policy/${name}`);
  return class extends Tag {
    static readonly kind = "Policy" as const;
    static readonly policyName: Name = name;
    static readonly definition = definition;
    static toLayer<Self extends Any, E, R>(
      this: Self,
      build: Effect.Effect<Handler<TriggerOf<Self>>, E, R>,
    ): Layer.Layer<Identifier<Self>, E, R> {
      return Layer.effect(
        this as unknown as Context.Key<Identifier<Self>, Handler<TriggerOf<Self>>>,
        build,
      );
    }
  } as unknown as PolicyClass<Name, From, On>;
};

/**
 * The class type returned by {@link make}.
 */
export interface PolicyClass<
  Name extends string,
  From extends View.Source,
  On extends ReadonlyArray<Event.Any>,
> extends Context.ServiceClass<
  PolicyKey<Name>,
  string,
  Handler<Trigger<From, Aggregate.Inst<On[number]>>>
> {
  readonly kind: "Policy";
  readonly policyName: Name;
  readonly definition: { readonly from: From; readonly on: On };
  /**
   * Implement the policy. The construction Effect runs once, resolving every
   * service the handler uses (aggregate clients, views, Ports); the handler
   * itself requires nothing.
   */
  toLayer<Self extends Any, E, R>(
    this: Self,
    build: Effect.Effect<Handler<TriggerOf<Self>>, E, R>,
  ): Layer.Layer<Identifier<Self>, E, R>;
}
