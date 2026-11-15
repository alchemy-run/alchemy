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
  /** The key, in `reads`, of the instance the event is recorded on. */
  readonly [RecordedOn]: string;
}

/** Record `event` on the instance read under `key`. @internal */
export const recorded = <E>(key: string, event: E): Recorded<E> => ({ event, [RecordedOn]: key });

/** The key, in `reads`, a recorded event goes to; `undefined` for any other value. @internal */
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

/** The instances a decision involves, each under a name `decide` reads it by. */
export type Reads = { readonly [key: string]: Aggregate.Ref<any> };

/** What `decide` receives for the instances named in `reads`. */
export type ReadsOf<R extends Reads> = {
  readonly [K in keyof R]: R[K] extends Aggregate.Ref<infer A> ? Read<A> : never;
};

/** The state of each instance named in `reads`, after the decision's events. */
export type StatesOf<R extends Reads> = {
  readonly [K in keyof R]: R[K] extends Aggregate.Ref<infer A> ? Aggregate.StateOf<A> : never;
};

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
 * The definition of a decision: the instances its command involves, and what
 * it records on them.
 */
export type Definition<C extends Command.Any, R extends Reads> = {
  /**
   * The aggregate instances the command involves, each under a name. They
   * are read together, and nothing commits unless every one of them is still
   * as it was read.
   */
  readonly reads: (command: InstanceOf<C>) => R;
  /**
   * Decide the command against every instance it read: the events to record
   * (each on one instance, with its `record`), an empty array for an accepted
   * no-op, or one of the command's rejections. It may be an `Effect.fn` that
   * reads what the command's middleware provides, and may require nothing
   * else.
   */
  readonly decide: (
    reads: ReadsOf<R>,
    command: InstanceOf<C>,
    context: DecideContext,
  ) => Outcome<C>;
} & (C["reply"] extends Schema.Top
  ? {
      /** The command's reply, from each instance's state after the events. */
      readonly reply: (
        states: StatesOf<R>,
        events: ReadonlyArray<InstanceOf<C["events"][number]>>,
      ) => ReplyOf<C>;
    }
  : { readonly reply?: never });

/** The widened shape of every {@link Definition}. */
export interface AnyDefinition {
  readonly reads: (command: any) => Reads;
  readonly decide: (reads: any, command: any, context: DecideContext) => unknown;
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
  readonly definition: AnyDefinition;
}

/** The class type returned by {@link make}. */
export interface DecisionClass<C extends Command.Any> extends Context.ServiceClass<
  Key<C["tag"]>,
  string,
  Client<C>
> {
  readonly kind: "Decision";
  readonly annotations: Annotations;
  readonly decisionName: C["tag"];
  readonly command: C;
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
 *   reads: (cmd) => ({ from: Account.ref(cmd.from), to: Account.ref(cmd.to) }),
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
export const make = <C extends Command.Any, const R extends Reads>(
  command: C,
  definition: Definition<C, R>,
  annotations: Annotations = {},
): DecisionClass<C> => {
  const Tag = Context.Service<Key<C["tag"]>, Client<C>>()(`alchemy/Domain/Decision/${command.tag}`);
  return class extends Tag {
    static readonly kind = "Decision" as const;
    static readonly annotations: Annotations = annotations;
    static readonly decisionName: C["tag"] = command.tag;
    static readonly command: C = command;
    static readonly definition = definition as unknown as AnyDefinition;
  } as unknown as DecisionClass<C>;
};
