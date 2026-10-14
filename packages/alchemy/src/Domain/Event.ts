import * as Schema from "effect/Schema";

/**
 * Field map shared by every Domain message builder.
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
 * A fact your domain recorded, named in the past tense. Aggregates record
 * events; their state, every view and every policy follow from them.
 *
 * ### Declaring events
 * **Example:** An event with data
 * ```typescript
 * import * as Domain from "alchemy/Domain";
 * import * as Schema from "effect/Schema";
 *
 * export class MoneyDeposited extends Domain.Event("MoneyDeposited", {
 *   amount: Schema.Int,
 *   balanceAfter: Schema.Int,
 * }) {}
 * ```
 *
 * **Example:** An event with no data
 * ```typescript
 * import * as Domain from "alchemy/Domain";
 *
 * export class AccountClosed extends Domain.Event("AccountClosed") {}
 * ```
 *
 * @primitive
 */
export const make = <const Tag extends string, const F extends Fields = {}>(
  tag: Tag,
  fields: F = {} as F,
): EventClass<Tag, F> => {
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
