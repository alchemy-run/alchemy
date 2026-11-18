import * as Context from "effect/Context";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import type { Annotations } from "./Annotations.ts";
import type * as Event from "./Event.ts";
import type { Data, Fields } from "./Event.ts";
import { inputSchema } from "./internal.ts";
import * as Middleware from "./Middleware.ts";
import type * as Rejection from "./Rejection.ts";
import * as View from "./View.ts";

/**
 * Instance type of a Command class: its `_tag` plus its input.
 */
export type Instance<Tag extends string, F extends Fields> = { readonly _tag: Tag } & Data<F>;

/**
 * Structural constraint satisfied by every class produced by {@link make}.
 */
export interface Any extends Schema.Top {
  readonly kind: "Command";
  readonly annotations: Annotations;
  readonly tag: string;
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

/**
 * When a command answers. `"eventual"`, the default, answers as soon as the
 * events are committed: the views apply them a moment later. `"strong"`
 * answers once every view its events reach has applied them, so any read of
 * a view after the answer includes the command.
 */
export const Consistency = Schema.Literals(["strong", "eventual"]);
export type Consistency = typeof Consistency.Type;

/**
 * The `consistency` of every command a client sends without one. A client
 * reads it once, when it is built, so provide it to the client or to its
 * Layer.
 *
 * **Example:** A client whose commands wait for their views
 * ```typescript
 * const bank = yield* CustomerApi.clientHttp("https://bank.example.com/api").pipe(
 *   Effect.provideService(Domain.DefaultConsistency, "strong"),
 * );
 * ```
 */
export const DefaultConsistency = Context.Reference<Consistency>(
  "alchemy/Domain/DefaultConsistency",
  { defaultValue: () => "eventual" },
);

/** What a client sends: an optional idempotency key, the input, and when to answer. */
export type PayloadFields<F extends Fields> = {
  readonly commandId: Schema.optional<typeof Schema.String>;
  readonly input: Schema.Struct<F>;
  readonly consistency: Schema.optional<typeof Consistency>;
};

/** Where a command's events were committed: one stream, and its version after them. */
export const Commit = Schema.Struct({ stream: Schema.String, version: Schema.Number });
export type Commit = typeof Commit.Type;

/**
 * What a client receives: the reply, and where the events were committed.
 * `stream` and `version` are the first stream it committed to: the one
 * instance an aggregate's command addresses. `commits` lists every stream,
 * for a command a `Decision` implements across several.
 */
export type SuccessFields<Reply extends Schema.Top | undefined> = {
  readonly reply: Reply extends Schema.Top ? Reply : typeof Schema.Void;
  readonly stream: typeof Schema.String;
  readonly version: typeof Schema.Number;
  readonly commits: Schema.$Array<typeof Commit>;
};

/** The Effect RPC definition of a command. */
export type CommandRpc<
  Tag extends string,
  F extends Fields,
  Rejects extends ReadonlyArray<Rejection.Any>,
  Reply extends Schema.Top | undefined,
> = Rpc.Rpc<
  Tag,
  Schema.Struct<PayloadFields<F>>,
  Schema.Struct<SuccessFields<Reply>>,
  Schema.Union<[...Rejects, typeof View.ConsistencyTimeout]>
>;

/**
 * The class type returned by {@link make}.
 */
export interface CommandClass<
  Tag extends string,
  F extends Fields,
  Events extends ReadonlyArray<Event.Any>,
  Rejects extends ReadonlyArray<Rejection.Any>,
  Reply extends Schema.Top | undefined,
  Ms extends Middleware.List,
  R extends Rpc.Any,
> extends Schema.Class<Instance<Tag, F>, Schema.TaggedStruct<Tag, F>, {}> {
  readonly kind: "Command";
  readonly annotations: Annotations;
  readonly tag: Tag;
  readonly events: Events;
  readonly rejects: Rejects;
  readonly reply: Reply;
  /** The middleware that guards the command when an Api exposes it, in order. */
  readonly middleware: Ms;
  /** The command as an Effect RPC, for exposing it in an Api. */
  readonly rpc: R;
}

interface Options {
  readonly input?: Fields;
  readonly middleware?: Middleware.List;
  readonly events?: ReadonlyArray<Event.Any>;
  readonly rejects?: ReadonlyArray<Rejection.Any>;
  readonly reply?: Fields;
}

const build = (tag: string, options: Options, rpc: Rpc.Any, annotations: Annotations): unknown => {
  // The base type is conditional on `Self`, so it is not a constructor until `make` returns.
  const Base = Schema.TaggedClass<{ readonly _tag: string }>(tag)(
    tag,
    options.input ?? {},
  ) as unknown as new (input: object) => object;
  return class extends Base {
    static readonly kind = "Command" as const;
    static readonly annotations: Annotations = annotations;
    static readonly tag = tag;
    static readonly events = options.events ?? [];
    static readonly rejects = options.rejects ?? [];
    static readonly reply = options.reply ? Schema.Struct(options.reply) : undefined;
    static readonly middleware = options.middleware ?? [];
    static readonly rpc = rpc;
  };
};

/**
 * A request to change the model. It names its input, which includes the id
 * of every aggregate instance it involves, the events it may record, the
 * rejections it may return, the middleware that guards it, and the reply its
 * caller receives. An aggregate implements it for one instance; a
 * `Domain.Decision` implements it across several.
 *
 * ### Declaring a command
 * **Example:** A command with its event and rejection
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 *
 * export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
 *
 * export class MoneyWithdrawn extends Domain.Event("MoneyWithdrawn", {
 *   amount: Schema.Int,
 *   balanceAfter: Schema.Int,
 * }) {}
 *
 * export class InsufficientFunds extends Domain.Rejection("InsufficientFunds", {
 *   balance: Schema.Int,
 *   requested: Schema.Int,
 * }) {}
 *
 * export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
 *   input: { accountId: AccountId, amount: Schema.Int },
 *   events: [MoneyWithdrawn],
 *   rejects: [InsufficientFunds],
 *   reply: { balance: Schema.Int },
 * }) {}
 * ```
 *
 * ### Guarding it with middleware
 * `middleware` runs in list order before the command reaches its aggregate:
 * the first entry runs first, and what it provides, such as the current
 * actor, reaches the entries after it and `decide`.
 *
 * **Example:** Requiring a session and a second factor
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 * import { AccountId, MoneyWithdrawn } from "./Account.ts";
 * import { MfaChallenge } from "./MfaChallenge.ts";
 * import { Session } from "./Session.ts";
 *
 * export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
 *   middleware: [Session, MfaChallenge],
 *   input: { accountId: AccountId, amount: Schema.Int },
 *   events: [MoneyWithdrawn],
 *   reply: { balance: Schema.Int },
 * }) {}
 * ```
 *
 * ### Involving several instances
 * A command that involves more than one aggregate instance names each of
 * them in its input, and a `Domain.Decision` implements it.
 *
 * **Example:** A transfer between two accounts
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 * import { AccountId, InsufficientFunds, TransferReceived, TransferSent } from "./Account.ts";
 *
 * export class TransferMoney extends Domain.Command("TransferMoney", {
 *   input: { from: AccountId, to: AccountId, amount: Schema.Int },
 *   events: [TransferSent, TransferReceived],
 *   rejects: [InsufficientFunds],
 * }) {}
 * ```
 *
 * ### Sending it once
 * Pass a `commandId`, and a resend with the same id returns the first
 * receipt instead of applying the command again.
 *
 * **Example:** An idempotent send through an Api
 * ```typescript
 * const receipt = yield* bank.WithdrawMoney({ accountId, amount: 2_000 }, { commandId: requestId });
 * ```
 *
 * ### Choosing when it answers
 * A command answers as soon as its events are committed; the views apply
 * them a moment later. Through an Api, pass `consistency: "strong"` to
 * answer once every view the events reach has applied them, so a read of a
 * view after the answer includes the command. A view that takes longer than
 * 10 seconds fails the call with `ConsistencyTimeout`; the command is
 * committed all the same. `Domain.DefaultConsistency` sets it for every
 * command of a client.
 *
 * **Example:** Reading right after a command
 * ```typescript
 * yield* bank.DepositMoney({ accountId, amount: 500 }, { consistency: "strong" });
 * const summary = yield* bank.AccountSummary.get(accountId); // includes the deposit
 *
 * const receipt = yield* bank.DepositMoney({ accountId, amount: 500 });
 * const later = yield* bank.AccountSummary.get(accountId, { atLeast: receipt });
 * ```
 *
 * ### Annotating commands
 * The last argument is its annotations: data for what is built on the
 * model, read back as `X.annotations`. Add your own keys by augmenting
 * `Domain.Annotations`.
 *
 * An Api's MCP tools, CLI help and OpenAPI document show its `description`,
 * in place of the sentence they would generate.
 *
 * **Example:** A description
 * ```typescript
 * export class WithdrawMoney extends Domain.Command(
 *   "WithdrawMoney",
 *   { input: { accountId: AccountId, amount: Schema.Int }, events: [MoneyWithdrawn] },
 *   { description: "Take money out of an account. The amount is in cents." },
 * ) {}
 * ```
 *
 * @primitive
 */
export const make = <
  const Tag extends string,
  const F extends Fields = {},
  const Ms extends Middleware.List = readonly [],
  const Events extends ReadonlyArray<Event.Any> = readonly [],
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
  const Reply extends Fields | undefined = undefined,
>(
  tag: Tag,
  options: {
    /**
     * The command's fields, including the id of every aggregate instance it
     * involves: what implements it reads them from here.
     */
    readonly input?: F;
    /**
     * Middleware that guards the command when an Api exposes it, run in list
     * order: the first entry runs first.
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
  annotations: Annotations = {},
): CommandClass<
  Tag,
  F,
  Events,
  Rejects,
  ReplySchema<Reply>,
  Ms,
  Middleware.Apply<CommandRpc<Tag, F, Rejects, ReplySchema<Reply>>, Ms>
> => {
  const rejects = options.rejects ?? [];
  const reply = options.reply ? Schema.Struct(options.reply) : Schema.Void;
  const rpc = Rpc.make(tag, {
    payload: {
      commandId: Schema.optional(Schema.String),
      input: inputSchema(options.input),
      consistency: Schema.optional(Consistency),
    },
    success: Schema.Struct({
      reply,
      stream: Schema.String,
      version: Schema.Number,
      commits: Schema.Array(Commit),
    }),
    // A command that committed can still time out waiting for a view (`consistency: "strong"`).
    error: Schema.Union([...rejects, View.ConsistencyTimeout]),
  });
  return build(
    tag,
    options,
    Middleware.apply(rpc, options.middleware ?? []),
    annotations,
  ) as CommandClass<
    Tag,
    F,
    Events,
    Rejects,
    ReplySchema<Reply>,
    Ms,
    Middleware.Apply<CommandRpc<Tag, F, Rejects, ReplySchema<Reply>>, Ms>
  >;
};
