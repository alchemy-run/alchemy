import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import type { InstanceOf, SendOptions } from "./Aggregate.ts";
import type { Annotations } from "./Annotations.ts";
import type * as Command from "./Command.ts";

const RecordedOn = Symbol.for("alchemy/Domain/Decision/RecordedOn");

/**
 * An event a decision records on one of the instances it read, made with
 * that instance's `record`.
 */
export interface Recorded<E = unknown> {
  readonly event: E;
  /** The stream of the instance the event is recorded on. */
  readonly [RecordedOn]: string;
}

/** Record `event` on the instance with this `stream`. @internal */
export const recorded = <E>(stream: string, event: E): Recorded<E> => ({
  event,
  [RecordedOn]: stream,
});

/** The stream a recorded event goes to; `undefined` for any other value. @internal */
export const recordedOn = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && RecordedOn in value
    ? (value as Recorded)[RecordedOn]
    : undefined;

/**
 * One aggregate instance a decision read: its state as of its latest commit,
 * and `record` to record an event on it.
 */
export interface Read<A extends Aggregate.Any> {
  /** The instance's id. */
  readonly id: Aggregate.IdOf<A>;
  /** Its stream, e.g. `Account/a-1`. */
  readonly stream: string;
  /** Its state: `initial` for an instance that has never committed. */
  readonly state: Aggregate.StateOf<A>;
  /** Its version: `0` for an instance that has never committed. */
  readonly version: number;
  /** Record an event on this instance. It folds it with its own `evolve`. */
  readonly record: <E extends Aggregate.EventOf<A>>(event: E) => Recorded<E>;
}

/** The aggregates a decision reads, each under a name `decide` reads it by. */
export type Reads = { readonly [name: string]: Aggregate.Any };

/**
 * The instances one command involves: for each name in `reads`, the id of
 * one instance of that aggregate, or an array of ids for several.
 */
export type KeysOf<R extends Reads> = {
  readonly [N in keyof R]: Aggregate.IdOf<R[N]> | ReadonlyArray<Aggregate.IdOf<R[N]>>;
};

/** One `T` for a name `keyOf` gives one id, an array for a name it gives several. */
type OneOrMany<Key, T> = Key extends ReadonlyArray<unknown> ? ReadonlyArray<T> : T;

/** What `decide` receives for the instances `keyOf` names. */
export type ReadsOf<R extends Reads, K extends KeysOf<R> = KeysOf<R>> = {
  readonly [N in keyof R]: OneOrMany<K[N], Read<R[N]>>;
};

/** The state of each instance `keyOf` names, after the decision's events. */
export type StatesOf<R extends Reads, K extends KeysOf<R> = KeysOf<R>> = {
  readonly [N in keyof R]: OneOrMany<K[N], Aggregate.StateOf<R[N]>>;
};

/**
 * One step a decision takes: every instance it read, before and after what it
 * recorded, with the command and the events.
 */
export interface Transition<States, Cmd, Ev> {
  /** Each instance's state as the decision read it, under its name in `reads`. */
  readonly before: States;
  /** Each instance's state after the events recorded on it. */
  readonly after: States;
  readonly command: Cmd;
  /** Every event, in the order `decide` recorded them. */
  readonly events: ReadonlyArray<Ev>;
}

/** Context passed to a decision's `decide`. */
export interface DecideContext {
  /** The id the command was sent with; its events' envelopes carry it too. */
  readonly commandId: string;
  /** The time the command is being handled. Controlled by stories via `clock`. */
  readonly now: DateTime.Utc;
}

/**
 * What a decision's `decide` returns: events recorded on the instances it
 * read, a rejection, or an Effect of either. The Effect may read what the
 * command's middleware provides.
 */
export type Outcome<C extends Command.Any> =
  | ReadonlyArray<Recorded<InstanceOf<C["events"][number]>>>
  | InstanceOf<C["rejects"][number]>
  | Effect.Effect<
      ReadonlyArray<Recorded<InstanceOf<C["events"][number]>>>,
      InstanceOf<C["rejects"][number]>,
      Command.ContextOf<C>
    >;

type ReplyOf<C extends Command.Any> = C["reply"] extends Schema.Top ? C["reply"]["Type"] : void;

/**
 * The definition of a decision: the aggregates it reads, the instances of
 * them its command involves, and what it records on them.
 */
export type Definition<C extends Command.Any, R extends Reads, K extends KeysOf<R>> = {
  /**
   * The aggregates the decision reads, each under a name. Known without a
   * command, so a model can check that it hosts every one of them.
   */
  readonly reads: R;
  /**
   * The instances a command involves: an id for each name in `reads`, or an
   * array of ids for a name that stands for several instances. They are read
   * together, and nothing commits unless every one of them is still as it
   * was read.
   */
  readonly keyOf: (command: InstanceOf<C>) => K;
  /**
   * Decide the command against every instance it read: the events to record
   * (each on one instance, with its `record`), an empty array for an accepted
   * no-op, or one of the command's rejections. It may be an `Effect.fn` that
   * reads what the command's middleware provides, and may require nothing
   * else.
   */
  readonly decide: (
    reads: ReadsOf<R, K>,
    command: InstanceOf<C>,
    context: DecideContext,
  ) => Outcome<C>;
  /**
   * Rules that hold for every step the decision takes, each named and given
   * the states it read, the command, the events it recorded and the states
   * after: `true` while the rule holds. They say what holds of the instances
   * together, which no one aggregate's rule can: that a transfer takes from
   * one account what it gives the other. `Prove.decision` proves that
   * `decide` can't break one.
   */
  readonly transitions?: {
    readonly [name: string]: (
      step: Transition<StatesOf<R, K>, InstanceOf<C>, InstanceOf<C["events"][number]>>,
    ) => boolean | Effect.Effect<boolean, never, Command.ContextOf<C>>;
  };
} & (C["reply"] extends Schema.Top
  ? {
      /** The command's reply, from each instance's state after the events. */
      readonly reply: (
        states: StatesOf<R, K>,
        events: ReadonlyArray<InstanceOf<C["events"][number]>>,
      ) => ReplyOf<C>;
    }
  : { readonly reply?: never });

/** The widened shape of every {@link Definition}. */
export interface AnyDefinition {
  readonly reads: Reads;
  readonly keyOf: (command: any) => { readonly [name: string]: string | ReadonlyArray<string> };
  readonly decide: (reads: any, command: any, context: DecideContext) => unknown;
  readonly transitions?: { readonly [name: string]: (step: any) => unknown } | undefined;
  readonly reply?: ((states: any, events: ReadonlyArray<any>) => unknown) | undefined;
}

/** One stream a decision committed to, and its version after the commit. */
export interface Commit {
  /** The stream, e.g. `Account/a-1`. */
  readonly stream: string;
  /** The stream's version (last sequence number) after the decision. */
  readonly version: number;
}

/** The outcome of a successfully handled command a decision implements. */
export interface Receipt<Ev = unknown, Reply = unknown> {
  /** Every stream the decision read, with its version after the decision. */
  readonly commits: ReadonlyArray<Commit>;
  /** The events committed, in the order `decide` recorded them. */
  readonly events: ReadonlyArray<Ev>;
  /** The command's reply, if it declares one. */
  readonly reply: Reply;
}

/**
 * The runtime API of a decision, obtained with `yield* MyDecision`.
 *
 * **Example:** Sending the command a decision implements
 * ```typescript
 * const registration = yield* Registration;
 * yield* registration.send(new RegisterCustomer({ customerId, name: "Sam", username }));
 * ```
 */
export interface Client<C extends Command.Any> {
  /**
   * Send the command. Succeeds with a {@link Receipt} once every event is
   * committed, or fails with one of the command's rejections, in which case
   * nothing was recorded.
   */
  readonly send: (
    command: InstanceOf<C>,
    options?: SendOptions,
  ) => Effect.Effect<
    Receipt<InstanceOf<C["events"][number]>, ReplyOf<C>>,
    InstanceOf<C["rejects"][number]>,
    Command.ContextOf<C>
  >;
}

/** The untyped form of {@link Client} the framework implements. @internal */
export interface ClientImpl {
  readonly send: (
    command: { readonly _tag: string },
    options?: SendOptions,
  ) => Effect.Effect<Receipt, unknown>;
}

/** Type-level identity of a decision in an Effect's requirements. */
export interface Key<Name extends string> {
  readonly "~alchemy/Domain/Decision": Name;
}

/** Structural constraint satisfied by every decision class. */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Decision";
  readonly annotations: Annotations;
  /** The tag of the command it implements. */
  readonly decisionName: string;
  readonly command: Command.Any;
  /** The aggregates it reads, each under the name `decide` reads it by. */
  readonly reads: Reads;
  readonly definition: AnyDefinition;
}

/** The class type returned by {@link make}. */
export interface DecisionClass<
  C extends Command.Any,
  R extends Reads = Reads,
> extends Context.ServiceClass<Key<C["tag"]>, string, Client<C>> {
  readonly kind: "Decision";
  readonly annotations: Annotations;
  readonly decisionName: C["tag"];
  readonly command: C;
  readonly reads: R;
  readonly definition: AnyDefinition;
}

/**
 * A command decided against several aggregate instances at once. It reads
 * the instances the command names, decides against all of their states
 * together, and records events on them. Every event commits, or none does:
 * a transfer never debits one account without crediting the other.
 *
 * A decision keeps no state of its own. Each instance folds what is recorded
 * on it with its own `evolve`, so views, projections and policies see those
 * events like any other.
 *
 * ### Deciding across aggregates
 * The command's input names every instance it involves.
 *
 * **Example:** A transfer between two accounts
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
 *
 * export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
 *
 * export class TransferSent extends Domain.Event("TransferSent", { amount: Schema.Int }) {}
 * export class TransferReceived extends Domain.Event("TransferReceived", { amount: Schema.Int }) {}
 * export class InsufficientFunds extends Domain.Rejection("InsufficientFunds") {}
 *
 * export class TransferMoney extends Domain.Command("TransferMoney", {
 *   input: { from: AccountId, to: AccountId, amount: Schema.Int },
 *   events: [TransferSent, TransferReceived],
 *   rejects: [InsufficientFunds],
 * }) {}
 *
 * export class Account extends Domain.Aggregate("Account", {
 *   id: AccountId,
 *   state: Schema.Struct({ balance: Schema.Int }),
 *   initial: { balance: 0 },
 *   events: [TransferSent, TransferReceived],
 *   evolve: {
 *     TransferSent: (account, e) => ({ balance: account.balance - e.amount }),
 *     TransferReceived: (account, e) => ({ balance: account.balance + e.amount }),
 *   },
 * }) {}
 *
 * export class Transfer extends Domain.Decision(TransferMoney, {
 *   reads: { from: Account, to: Account },
 *   keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
 *   decide: ({ from, to }, cmd) =>
 *     cmd.amount > from.state.balance
 *       ? new InsufficientFunds()
 *       : [
 *           from.record(new TransferSent({ amount: cmd.amount })),
 *           to.record(new TransferReceived({ amount: cmd.amount })),
 *         ],
 * }) {}
 * ```
 *
 * `reads` names the aggregates and `keyOf` the instance of each a command
 * is for. A model checks that it hosts every aggregate in `reads`.
 *
 * ### Reading several instances under one name
 * `keyOf` may return an array of ids for a name. `decide` then receives an
 * array for it.
 *
 * **Example:** Paying out to many accounts
 * ```typescript
 * export class PayOut extends Domain.Command("PayOut", {
 *   input: { from: AccountId, to: Schema.Array(AccountId), amount: Schema.Int },
 *   events: [TransferSent, TransferReceived],
 * }) {}
 *
 * export class Payout extends Domain.Decision(PayOut, {
 *   reads: { from: Account, to: Account },
 *   keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
 *   decide: ({ from, to }, cmd) =>
 *     to.flatMap((account) => [
 *       from.record(new TransferSent({ amount: cmd.amount })),
 *       account.record(new TransferReceived({ amount: cmd.amount })),
 *     ]),
 * }) {}
 * ```
 *
 * ### Stating what it must keep
 * `transitions` are rules about the step: the states the decision read,
 * before and after, with the command and the events. Nothing runs one when a
 * command arrives. `Verify.model` and `Prove.decision` prove that `decide`
 * can't break one, and that it keeps the rules of each aggregate it records
 * on.
 *
 * **Example:** A transfer creates no money
 * ```typescript
 * export class Transfer extends Domain.Decision(TransferMoney, {
 *   reads: { from: Account, to: Account },
 *   keyOf: (cmd) => ({ from: cmd.from, to: cmd.to }),
 *   decide: ({ from, to }, cmd) =>
 *     cmd.amount > from.state.balance
 *       ? new InsufficientFunds()
 *       : [
 *           from.record(new TransferSent({ amount: cmd.amount })),
 *           to.record(new TransferReceived({ amount: cmd.amount })),
 *         ],
 *   transitions: {
 *     MoneyIsConserved: ({ before, after }) =>
 *       after.from.balance + after.to.balance === before.from.balance + before.to.balance,
 *   },
 * }) {}
 * ```
 *
 * ### Hosting and sending
 * List the decision in its model. The class is a service tag: `yield*` it
 * for its client.
 *
 * **Example:** Sending the command
 * ```typescript
 * export class Bank extends Domain.Model("Bank", {
 *   aggregates: [Account],
 *   decisions: [Transfer],
 * }) {}
 *
 * const transfer = yield* Transfer;
 * yield* transfer.send(new TransferMoney({ from, to, amount: 30 }));
 * ```
 *
 * ### Authorizing in decide
 * `decide` can be an `Effect.fn` that reads what its command's middleware
 * provides.
 *
 * **Example:** Only the owner may send
 * ```typescript
 * decide: Effect.fn(function* ({ from, to }, cmd) {
 *   const actor = yield* CurrentActor;
 *   if (actor.customerId !== from.state.owner) return yield* new NotOwner();
 *   return [
 *     from.record(new TransferSent({ amount: cmd.amount })),
 *     to.record(new TransferReceived({ amount: cmd.amount })),
 *   ];
 * }),
 * ```
 *
 * @primitive
 */
export const make = <C extends Command.Any, const R extends Reads, K extends KeysOf<R>>(
  command: C,
  definition: Definition<C, R, K>,
  annotations: Annotations = {},
): DecisionClass<C, R> => {
  const Tag = Context.Service<Key<C["tag"]>, Client<C>>()(`alchemy/Domain/Decision/${command.tag}`);
  return class extends Tag {
    static readonly kind = "Decision" as const;
    static readonly annotations: Annotations = annotations;
    static readonly decisionName: C["tag"] = command.tag;
    static readonly command: C = command;
    static readonly reads: R = definition.reads;
    static readonly definition = definition as unknown as AnyDefinition;
  } as unknown as DecisionClass<C, R>;
};
