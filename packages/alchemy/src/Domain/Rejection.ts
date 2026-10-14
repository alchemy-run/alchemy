import type * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { Data, Fields } from "./Event.ts";

/**
 * Instance type of a Rejection class: its `_tag` plus its evidence data.
 */
export type Instance<Tag extends string, F extends Fields> = { readonly _tag: Tag } & Data<F>;

/**
 * Structural constraint satisfied by every class produced by {@link make}.
 */
export interface Any extends Schema.Top {
  readonly kind: "Rejection";
  readonly tag: string;
  new (...args: any[]): { readonly _tag: string };
}

/**
 * A typed reason a command or read was refused. Nothing is recorded when a
 * command is rejected, and the caller receives the rejection exactly as
 * declared, through an Api too.
 *
 * ### Declaring rejections
 * **Example:** A rejection with and without data
 * ```typescript
 * import * as Domain from "alchemy/Domain";
 * import * as Schema from "effect/Schema";
 *
 * export class NotOpen extends Domain.Rejection("NotOpen") {}
 *
 * export class InsufficientFunds extends Domain.Rejection("InsufficientFunds", {
 *   balance: Schema.Int,
 *   requested: Schema.Int,
 * }) {}
 * ```
 *
 * @primitive
 */
export const make = <const Tag extends string, const F extends Fields = {}>(
  tag: Tag,
  fields: F = {} as F,
): RejectionClass<Tag, F> => {
  // The base type is conditional on `Self`, so it is not a constructor until `make` returns.
  const Base: new (...args: any[]) => object = Schema.TaggedError<Instance<Tag, F>>(tag)(
    tag,
    fields,
  ) as any;
  return class extends Base {
    static readonly kind = "Rejection" as const;
    static readonly tag: Tag = tag;
  } as unknown as RejectionClass<Tag, F>;
};

/**
 * The class type returned by {@link make}.
 */
export interface RejectionClass<Tag extends string, F extends Fields> extends Schema.Class<
  Instance<Tag, F>,
  Schema.TaggedStruct<Tag, F>,
  Cause.YieldableError
> {
  readonly kind: "Rejection";
  readonly tag: Tag;
}
