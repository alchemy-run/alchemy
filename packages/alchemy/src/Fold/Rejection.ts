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
 * Declare a Rejection: a deterministic "no" returned by an aggregate's
 * `decide` when a command is invalid against the current state.
 *
 * A Rejection is a typed, yieldable error. Nothing is recorded when a
 * command is rejected, and retrying the same command against the same state
 * rejects again. Infrastructure failures are never Rejections.
 *
 * **Example:** Declaring rejections
 * ```typescript
 * export class NotOpen extends Rejection.make("NotOpen") {}
 *
 * export class InsufficientFunds extends Rejection.make("InsufficientFunds", {
 *   data: { balance: Cents, requested: Cents },
 * }) {}
 * ```
 */
export const make = <const Tag extends string, const F extends Fields = {}>(
  tag: Tag,
  options?: { readonly data?: F },
): RejectionClass<Tag, F> => {
  const fields = (options?.data ?? {}) as F;
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
