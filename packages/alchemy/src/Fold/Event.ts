import * as Schema from "effect/Schema";

/**
 * Field map shared by every Fold message builder.
 */
export type Fields = Schema.Struct.Fields;

/**
 * The decoded data carried by a message with fields `F`.
 */
export type Data<F extends Fields> = Schema.Struct<F>["Type"];

/**
 * Instance type of an Event class: its `_tag` plus its data.
 */
export type Instance<Tag extends string, F extends Fields> = { readonly _tag: Tag } & Data<F>;

/**
 * Structural constraint satisfied by every class produced by {@link make}.
 */
export interface Any extends Schema.Top {
  readonly kind: "Event";
  readonly tag: string;
  new (...args: any[]): { readonly _tag: string };
}

/**
 * Declare an Event: an immutable fact recorded on an aggregate's stream.
 *
 * Events are past-tense facts. They are produced by an aggregate's `decide`,
 * folded into state by `evolve`, and delivered to Views and Policies.
 *
 * **Example:** Declaring events
 * ```typescript
 * export class MoneyDeposited extends Event.make("MoneyDeposited", {
 *   data: { amount: Cents, balanceAfter: Cents },
 * }) {}
 *
 * export class AccountClosed extends Event.make("AccountClosed") {}
 *
 * new MoneyDeposited({ amount: 100, balanceAfter: 100 });
 * new AccountClosed();
 * ```
 */
export const make = <const Tag extends string, const F extends Fields = {}>(
  tag: Tag,
  options?: { readonly data?: F },
): EventClass<Tag, F> => {
  const fields = (options?.data ?? {}) as F;
  // The base type is conditional on `Self`, so it is not a constructor until `make` returns.
  const Base: new (...args: any[]) => object = Schema.TaggedClass<Instance<Tag, F>>(tag)(
    tag,
    fields,
  ) as any;
  return class extends Base {
    static readonly kind = "Event" as const;
    static readonly tag: Tag = tag;
  } as unknown as EventClass<Tag, F>;
};

/**
 * The class type returned by {@link make}.
 */
export interface EventClass<Tag extends string, F extends Fields> extends Schema.Class<
  Instance<Tag, F>,
  Schema.TaggedStruct<Tag, F>,
  {}
> {
  readonly kind: "Event";
  readonly tag: Tag;
}
