import * as EffectContext from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import type * as Event from "./Event.ts";
import type { Data, Fields } from "./Event.ts";
import * as Middleware from "./Middleware.ts";
import type * as Rejection from "./Rejection.ts";

/**
 * Instance type of a Command class: its `_tag` plus its input.
 */
export type Instance<Tag extends string, F extends Fields> = { readonly _tag: Tag } & Data<F>;

/** The schema of the aggregate id a command addresses. */
export type TargetSchema = Schema.Top & { readonly Type: string; readonly Encoded: string };

/**
 * Structural constraint satisfied by every class produced by {@link make}.
 */
export interface Any extends Schema.Top {
  readonly kind: "Command";
  readonly tag: string;
  readonly target: TargetSchema;
  readonly events: ReadonlyArray<Event.Any>;
  readonly rejects: ReadonlyArray<Rejection.Any>;
  readonly reply: Schema.Top | undefined;
  readonly middleware: Middleware.List;
  readonly rpc: Rpc.Any;
  new (...args: any[]): { readonly _tag: string };
}

/**
 * The services a command's `decide` may use: whatever its middleware
 * provides. Senders without that middleware (policies, stories) provide them.
 */
export type ContextOf<C extends Any> = Middleware.Provides<C["middleware"]>;

/**
 * The reply schema declared by a command, as a `Schema.Struct`.
 */
export type ReplySchema<Reply extends Fields | undefined> = Reply extends Fields
  ? Schema.Struct<Reply>
  : undefined;

/** What a client sends: the target, an optional idempotency key, and the input. */
export type PayloadFields<Target extends TargetSchema, F extends Fields> = F & {
  readonly target: Target;
  readonly commandId: Schema.optional<typeof Schema.String>;
};

/** What a client receives: the reply and the position of the committed events. */
export type SuccessFields<Reply extends Schema.Top | undefined> = {
  readonly reply: Reply extends Schema.Top ? Reply : typeof Schema.Void;
  readonly stream: typeof Schema.String;
  readonly version: typeof Schema.Number;
};

/** The Effect RPC definition of a command. */
export type CommandRpc<
  Tag extends string,
  Target extends TargetSchema,
  F extends Fields,
  Rejects extends ReadonlyArray<Rejection.Any>,
  Reply extends Schema.Top | undefined,
> = Rpc.Rpc<
  Tag,
  Schema.Struct<PayloadFields<Target, F>>,
  Schema.Struct<SuccessFields<Reply>>,
  Rejects extends readonly [] ? typeof Schema.Never : Schema.Union<Rejects>
>;

/**
 * The class type returned by {@link make}.
 */
export interface CommandClass<
  Tag extends string,
  Target extends TargetSchema,
  F extends Fields,
  Events extends ReadonlyArray<Event.Any>,
  Rejects extends ReadonlyArray<Rejection.Any>,
  Reply extends Schema.Top | undefined,
  Ms extends Middleware.List,
  R extends Rpc.Any,
> extends Schema.Class<Instance<Tag, F>, Schema.TaggedStruct<Tag, F>, {}> {
  readonly kind: "Command";
  readonly tag: Tag;
  readonly target: Target;
  readonly events: Events;
  readonly rejects: Rejects;
  readonly reply: Reply;
  /** The middleware that guards the command when an Api exposes it, in order. */
  readonly middleware: Ms;
  /** The command as an Effect RPC, for exposing it in an Api. */
  readonly rpc: R;
}

interface Options {
  readonly target: TargetSchema;
  readonly input?: Fields;
  readonly middleware?: Middleware.List;
  readonly events?: ReadonlyArray<Event.Any>;
  readonly rejects?: ReadonlyArray<Rejection.Any>;
  readonly reply?: Fields;
}

const build = (tag: string, options: Options, rpc: Rpc.Any): unknown => {
  // The base type is conditional on `Self`, so it is not a constructor until `make` returns.
  const Base = Schema.TaggedClass<{ readonly _tag: string }>(tag)(
    tag,
    options.input ?? {},
  ) as unknown as new (input: object) => object;
  return class extends Base {
    static readonly kind = "Command" as const;
    static readonly tag = tag;
    static readonly target = options.target;
    static readonly events = options.events ?? [];
    static readonly rejects = options.rejects ?? [];
    static readonly reply = options.reply ? Schema.Struct(options.reply) : undefined;
    static readonly middleware = options.middleware ?? [];
    static readonly rpc = rpc;
  };
};

/**
 * Declare a Command: an intent addressed to one instance of an aggregate.
 *
 * A command names the aggregate id it targets, its input, the events it may
 * record, the Rejections its handler may return and, optionally, the reply
 * its caller receives. A command with its events and rejections is one
 * behaviour of an aggregate, so they usually live together in one file.
 *
 * `middleware` authenticates callers and provides context (such as the
 * current actor) that the aggregate's `decide` reads with `yield*`. An Api
 * exposes a command directly; senders without the middleware (policies,
 * stories) provide that context themselves.
 *
 * **Example:** Declaring a command with middleware
 * ```typescript
 * export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
 *   target: AccountId,
 *   input: { amount: Cents },
 *   middleware: [Session, MfaChallenge],
 *   events: [MoneyWithdrawn],
 *   rejects: [NotOpen, NotOwner, InsufficientFunds],
 *   reply: { balance: Cents },
 * }) {}
 * ```
 */
export const make = <
  const Tag extends string,
  Target extends TargetSchema,
  const F extends Fields = {},
  const Ms extends Middleware.List = readonly [],
  const Events extends ReadonlyArray<Event.Any> = readonly [],
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
  const Reply extends Fields | undefined = undefined,
>(
  tag: Tag,
  options: {
    /** The id schema of the aggregate this command addresses. */
    readonly target: Target;
    /** The command's fields. */
    readonly input?: F;
    /**
     * Middleware that guards the command when an Api exposes it, in order.
     * What it provides is what `decide` may read.
     */
    readonly middleware?: Ms;
    /** The events the command may record. */
    readonly events?: Events;
    /** The rejections the command's handler may return. */
    readonly rejects?: Rejects;
    /** The reply computed after the events are committed. */
    readonly reply?: Reply;
  },
): CommandClass<
  Tag,
  Target,
  F,
  Events,
  Rejects,
  ReplySchema<Reply>,
  Ms,
  Middleware.Apply<CommandRpc<Tag, Target, F, Rejects, ReplySchema<Reply>>, Ms>
> => {
  const rejects = options.rejects ?? [];
  const rpc = Rpc.make(tag, {
    payload: {
      ...options.input,
      target: options.target,
      commandId: Schema.optional(Schema.String),
    },
    success: Schema.Struct({
      reply: options.reply ? Schema.Struct(options.reply) : Schema.Void,
      stream: Schema.String,
      version: Schema.Number,
    }),
    error: rejects.length === 0 ? Schema.Never : Schema.Union(rejects),
  });
  return build(tag, options, Middleware.apply(rpc, options.middleware ?? [])) as CommandClass<
    Tag,
    Target,
    F,
    Events,
    Rejects,
    ReplySchema<Reply>,
    Ms,
    Middleware.Apply<CommandRpc<Tag, Target, F, Rejects, ReplySchema<Reply>>, Ms>
  >;
};
