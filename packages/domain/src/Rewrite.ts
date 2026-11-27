import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import type { Annotations } from "./Annotations.ts";
import type { Data, Fields } from "./Event.ts";

/** Instance type of a Rewrite class: its `_tag` plus its input. */
export type Instance<Name extends string, F extends Fields> = { readonly _tag: Name } & Data<F>;

/**
 * What a rewrite does with one stored event: the same event to keep it, another
 * of the aggregate's events to put in its place, or `null` to remove it.
 */
export type Handler<A extends Aggregate.Any, Ev, Input> = (
  event: Ev,
  input: Input,
  envelope: Aggregate.Envelope<Aggregate.IdOf<A>>,
) => Aggregate.EventOf<A> | null;

type ByTag<U, T> = Extract<U, { readonly tag: T }>;

/** The pure definition of a rewrite. */
export interface Definition<A extends Aggregate.Any, F extends Fields> {
  /** The aggregate whose instances it rewrites. */
  readonly of: A;
  /** What a run of it is given, such as whose data to remove. */
  readonly input?: F;
  /**
   * One handler per event it changes, given the stored event, the rewrite's
   * input and the event's envelope: returns the event to keep it, another of
   * the aggregate's events to replace it, or `null` to remove it. An event
   * without a handler is kept as it is. Handlers are pure: the same event and
   * input give the same answer, so a rewrite that runs twice changes nothing
   * the second time.
   */
  readonly events?: {
    readonly [T in A["definition"]["events"][number]["tag"]]?: Handler<
      A,
      Aggregate.InstanceOf<ByTag<A["definition"]["events"][number], T>>,
      Data<F>
    >;
  };
  /**
   * Remove the instance: every event, its state, and what it keeps of the
   * commands it handled and scheduled. Its id is never reused for another
   * history: a command sent to it afterwards starts from `initial`, at the
   * version it had.
   */
  readonly delete?: true;
}

/** Structural constraint satisfied by every Rewrite class. */
export interface Any extends Schema.Top {
  readonly kind: "Rewrite";
  readonly annotations: Annotations;
  readonly rewriteName: string;
  readonly definition: {
    readonly of: Aggregate.Any;
    readonly events?: { readonly [tag: string]: ((...args: never[]) => unknown) | undefined };
    readonly delete?: true;
  };
  new (...args: any[]): { readonly _tag: string };
}

/** The aggregate a rewrite class rewrites. */
export type Of<R extends Any> = R["definition"]["of"];

/**
 * What accepting a rewrite, a delete or a compaction returns. The instance's
 * own history is changed by then; `rewritten` waits for everything built
 * from it.
 */
export const Receipt = Schema.Struct({
  /** The stream that was rewritten, e.g. `Account/a-1`. */
  stream: Schema.String,
  /** Names this run on its instance: the one passed in `options`, or the one derived for it. */
  rewriteId: Schema.String,
  /** How many stored events it replaced or removed. */
  changed: Schema.Number,
});
export type Receipt = typeof Receipt.Type;

/** Options for `client.rewrite` and `client.delete`. */
export interface Options {
  /**
   * Names the run on its instance. A run retried with an id the instance has
   * already seen changes nothing and returns the original receipt.
   */
  readonly rewriteId?: string;
}

/**
 * The state a rewrite would leave breaks one of the aggregate's invariants,
 * so nothing was changed.
 */
export class InvariantBroken extends Schema.TaggedError<InvariantBroken>()("InvariantBroken", {
  aggregate: Schema.String,
  id: Schema.String,
  rewrite: Schema.String,
  invariant: Schema.String,
}) {
  override get message() {
    return `${this.rewrite} would leave ${this.aggregate}/${this.id} breaking its invariant '${this.invariant}'`;
  }
}

/**
 * A change to the events an aggregate instance has already recorded: for
 * removing personal data, or correcting what should never have been stored.
 * Each handler keeps, replaces or removes one kind of event. Running it
 * changes the instance's stored events and state, then every view and
 * projection built from them.
 *
 * Sequence numbers never change: a removed event leaves a gap. Policies and
 * sagas are not told, since what they did has already happened.
 *
 * ### Removing personal data
 * **Example:** Forget who opened an account
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { Account, AccountOpened } from "./Account.ts";
 * import { CustomerId } from "./Customer.ts";
 *
 * export class ForgetOwner extends Domain.Rewrite("ForgetOwner", {
 *   of: Account,
 *   input: { customerId: CustomerId },
 *   events: {
 *     AccountOpened: (event, { customerId }) =>
 *       event.customerId === customerId ? new AccountOpened({ ...event, owner: "" }) : event,
 *   },
 * }) {}
 * ```
 *
 * ### Running it
 * List it in the model's `rewrites`, then run it on one instance. The call
 * returns once the instance's own history is rewritten; `rewritten` waits
 * until every view and projection has caught up.
 *
 * **Example:** From a saga step or your own code
 * ```typescript
 * const accounts = yield* Account;
 * const receipt = yield* accounts.rewrite(accountId, new ForgetOwner({ customerId }));
 * yield* accounts.rewritten(receipt);
 * ```
 *
 * ### Removing an instance
 * **Example:** Delete a customer
 * ```typescript
 * export class DeleteCustomer extends Domain.Rewrite("DeleteCustomer", {
 *   of: Customer,
 *   delete: true,
 * }) {}
 *
 * yield* customers.rewrite(customerId, new DeleteCustomer());
 * ```
 *
 * ### Removing an event
 * **Example:** Drop every note a customer left
 * ```typescript
 * export class DropNotes extends Domain.Rewrite("DropNotes", {
 *   of: Account,
 *   events: { NoteAdded: () => null },
 * }) {}
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  A extends Aggregate.Any,
  const F extends Fields = {},
>(
  name: Name,
  definition: Definition<A, F>,
  annotations: Annotations = {},
): RewriteClass<Name, A, F> => {
  // The base type is conditional on `Self`, so it is not a constructor until `make` returns.
  const Base: new (...args: any[]) => object = Schema.TaggedClass<Instance<Name, F>>(name)(
    name,
    (definition.input ?? {}) as F,
  ) as any;
  return class extends Base {
    static readonly kind = "Rewrite" as const;
    static readonly annotations: Annotations = annotations;
    static readonly rewriteName: Name = name;
    static readonly definition = definition;
  } as unknown as RewriteClass<Name, A, F>;
};

/** The class type returned by {@link make}. */
export interface RewriteClass<
  Name extends string,
  A extends Aggregate.Any,
  F extends Fields,
> extends Schema.Class<Instance<Name, F>, Schema.TaggedStruct<Name, F>, {}> {
  readonly kind: "Rewrite";
  readonly annotations: Annotations;
  readonly rewriteName: Name;
  readonly definition: Definition<A, F>;
}
