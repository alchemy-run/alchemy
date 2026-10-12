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
  readonly "~alchemy/Domain/Policy": Name;
}

/**
 * "Whenever this happens, do that": a reaction to events from an aggregate or
 * a view that sends commands and calls ports. Policies run shortly after the
 * event, never in the same step, so use them only for eventually consistent
 * work. Delivery is at least once; the commands a policy sends get ids
 * derived from the event, so a second run sends the same commands.
 *
 * ### Reacting to an aggregate
 * **Example:** Open an account for every new customer
 * ```typescript
 * import * as Domain from "alchemy/Domain";
 * import * as Effect from "effect/Effect";
 * import { Account, AccountId, OpenAccount } from "./Account.ts";
 * import { Customer, CustomerRegistered } from "./Customer.ts";
 *
 * export class MainAccountProvisioning extends Domain.Policy("MainAccountProvisioning", {
 *   from: Customer,
 *   on: [CustomerRegistered],
 * }) {}
 *
 * export const MainAccountProvisioningLive = MainAccountProvisioning.toLayer(
 *   Effect.gen(function* () {
 *     const accounts = yield* Account;
 *     return Effect.fn(function* ({ source }) {
 *       yield* accounts
 *         .send(AccountId.make(`${source.id}-main`), new OpenAccount({ owner: source.id }))
 *         .pipe(Effect.catchTag("AlreadyOpen", () => Effect.void));
 *     });
 *   }),
 * );
 * ```
 *
 * ### Calling a port
 * **Example:** Score risky withdrawals
 * ```typescript
 * import * as Domain from "alchemy/Domain";
 * import * as Effect from "effect/Effect";
 * import { Account, MoneyWithdrawn } from "./Account.ts";
 * import { FraudCheck } from "./FraudCheck.ts";
 *
 * export class FraudReview extends Domain.Policy("FraudReview", {
 *   from: Account,
 *   on: [MoneyWithdrawn],
 * }) {}
 *
 * export const FraudReviewLive = FraudReview.toLayer(
 *   Effect.gen(function* () {
 *     const fraud = yield* FraudCheck;
 *     return Effect.fn(function* ({ source, event }) {
 *       const { risk } = yield* fraud.score({ accountId: source.id, amount: event.amount });
 *       yield* Effect.log(`risk ${risk} for ${source.id}`);
 *     });
 *   }),
 * );
 * ```
 *
 * @primitive
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
  >()(`alchemy/Domain/Policy/${name}`);
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
