import * as Schema from "effect/Schema";
import type { Data, Fields } from "./Event.ts";
import type * as Rejection from "./Rejection.ts";

/**
 * Instance type of a Command class: its `_tag` plus its input.
 */
export type Instance<Tag extends string, F extends Fields> = { readonly _tag: Tag } & Data<F>;

/**
 * Structural constraint satisfied by every class produced by {@link make}.
 */
export interface Any extends Schema.Top {
  readonly kind: "Command";
  readonly tag: string;
  readonly rejects: ReadonlyArray<Rejection.Any>;
  readonly reply: Schema.Top | undefined;
  new (...args: any[]): { readonly _tag: string };
}

/**
 * The reply schema declared by a command, as a `Schema.Struct`.
 */
export type ReplySchema<Reply extends Fields | undefined> = Reply extends Fields
  ? Schema.Struct<Reply>
  : undefined;

/**
 * Declare a Command: an intent addressed to one aggregate instance.
 *
 * A command lists the Rejections its handler may return and, optionally, the
 * reply its caller receives after the resulting events are committed.
 *
 * **Example:** Declaring a command with rejections and a reply
 * ```typescript
 * export class Withdraw extends Command.make("Withdraw", {
 *   input: { amount: Cents },
 *   rejects: [NotOpen, InsufficientFunds],
 *   reply: { balance: Cents },
 * }) {}
 *
 * new Withdraw({ amount: 30 });
 * ```
 */
export const make = <
  const Tag extends string,
  const F extends Fields = {},
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
  const Reply extends Fields | undefined = undefined,
>(
  tag: Tag,
  options?: {
    readonly input?: F;
    readonly rejects?: Rejects;
    readonly reply?: Reply;
  },
): CommandClass<Tag, F, Rejects, ReplySchema<Reply>> => {
  const fields = (options?.input ?? {}) as F;
  const rejects = (options?.rejects ?? []) as unknown as Rejects;
  const reply = (options?.reply ? Schema.Struct(options.reply) : undefined) as ReplySchema<Reply>;
  // The base type is conditional on `Self`, so it is not a constructor until `make` returns.
  const Base: new (...args: any[]) => object = Schema.TaggedClass<Instance<Tag, F>>(tag)(
    tag,
    fields,
  ) as any;
  return class extends Base {
    static readonly kind = "Command" as const;
    static readonly tag: Tag = tag;
    static readonly rejects: Rejects = rejects;
    static readonly reply: ReplySchema<Reply> = reply;
  } as unknown as CommandClass<Tag, F, Rejects, ReplySchema<Reply>>;
};

/**
 * The class type returned by {@link make}.
 */
export interface CommandClass<
  Tag extends string,
  F extends Fields,
  Rejects extends ReadonlyArray<Rejection.Any>,
  Reply extends Schema.Top | undefined,
> extends Schema.Class<Instance<Tag, F>, Schema.TaggedStruct<Tag, F>, {}> {
  readonly kind: "Command";
  readonly tag: Tag;
  readonly rejects: Rejects;
  readonly reply: Reply;
}
