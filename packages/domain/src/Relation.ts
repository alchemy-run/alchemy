import type * as Aggregate from "./Aggregate.ts";

/** One instance a relation is about: its id and its state. */
export interface Instance<A extends Aggregate.Any> {
  readonly id: Aggregate.IdOf<A>;
  readonly state: Aggregate.StateOf<A>;
}

/** The instances a relation is given, one for each name in `over`. */
export type Instances<Over extends Readonly<Record<string, Aggregate.Any>>> = {
  readonly [K in keyof Over]: Instance<Over[K]>;
};

/** What {@link make} is given. */
export interface Definition<Over extends Readonly<Record<string, Aggregate.Any>>> {
  /** The aggregates it relates, each under a name. One aggregate can have two names. */
  readonly over: Over;
  /**
   * `true` while the relation holds of one instance for each name. It is
   * claimed of every choice of instances, two names of one aggregate always
   * standing for two instances, so it starts with what makes a choice matter:
   * `claim.state.holder !== customer.id || ...`.
   */
  readonly holds: (on: Instances<Over>) => boolean;
}

/** A relation between instances of a model's aggregates. */
export interface Relation<
  Over extends Readonly<Record<string, Aggregate.Any>> = Readonly<Record<string, Aggregate.Any>>,
> extends Definition<Over> {
  readonly kind: "Relation";
}

/** Any relation. */
export interface Any {
  readonly kind: "Relation";
  readonly over: Readonly<Record<string, Aggregate.Any>>;
  readonly holds: (on: never) => boolean;
}

/**
 * A rule that relates instances of different aggregates, or two instances of
 * one: a claimed name belongs to a registered customer. It goes in a model's
 * `relations`.
 *
 * Where a model's `invariants` are given every instance and can only be
 * searched, a relation is about a fixed few, so `Verify.model` can prove it:
 * every command and every decision that records on one of its aggregates is
 * shown to keep it, from any states the model's rules allow.
 *
 * ### Relating two aggregates
 * **Example:** A claimed name belongs to a registered customer
 * ```typescript
 * export class Bank extends Domain.Model("Bank", {
 *   aggregates: [Customer, UsernameClaim],
 *   decisions: [Registration],
 *   relations: {
 *     AClaimedNameHasACustomer: Domain.Relation({
 *       over: { customer: Customer, claim: UsernameClaim },
 *       holds: ({ customer, claim }) =>
 *         claim.state._tag !== "Claimed" ||
 *         claim.state.customerId !== customer.id ||
 *         customer.state._tag !== "Unregistered",
 *     }),
 *   },
 * }) {}
 * ```
 *
 * ### What can be proved
 * A proof is about every single command, so a relation is proved where one
 * step changes both sides: a decision. One a policy keeps in step is broken
 * between the event and the policy's command. It is not proved, and is
 * checked like the model's `invariants`, once nothing is left to react.
 *
 * @primitive
 */
export const make = <const Over extends Readonly<Record<string, Aggregate.Any>>>(
  definition: Definition<Over>,
): Relation<Over> => ({ kind: "Relation", ...definition });
