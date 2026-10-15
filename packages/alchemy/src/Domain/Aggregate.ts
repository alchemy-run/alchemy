import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CurrentActivity } from "../WorkflowEncoding.ts";
import type * as Command from "./Command.ts";
import type * as Event from "./Event.ts";
import type * as Middleware from "./Middleware.ts";
import type * as Read from "./Read.ts";
import type * as Rejection from "./Rejection.ts";
import * as RequestContext from "./RequestContext.ts";

/**
 * Instance type produced by a class.
 */
export type Inst<C> = C extends abstract new (...args: any[]) => infer I ? I : never;

/**
 * Context passed to every `decide` handler.
 */
export interface DecideContext<Id> {
  /** The id of the aggregate instance handling the command. */
  readonly id: Id;
  /** The time the command is being handled. Controlled by stories via `clock`. */
  readonly now: DateTime.Utc;
}

/**
 * Metadata recorded with every committed event.
 */
export interface Envelope<Id = string> {
  /** The id of the aggregate instance that committed the event. */
  readonly id: Id;
  /** The stream the event belongs to, e.g. `Account/a-1`. */
  readonly stream: string;
  /** The event's sequence number within its stream, starting at 1. */
  readonly seq: number;
  /** The commit time. */
  readonly at: DateTime.Utc;
  /** The id of the command that produced the event. */
  readonly commandId: string;
}

/**
 * The outcome of a successfully handled command.
 */
export interface Receipt<Ev = unknown, Reply = unknown> {
  /** The stream the command was applied to, e.g. `Account/a-1`. */
  readonly stream: string;
  /** The stream's version (last sequence number) after the command. */
  readonly version: number;
  /** The events committed by the command (empty for an accepted no-op). */
  readonly events: ReadonlyArray<Ev>;
  /** The command's reply, if it declares one. */
  readonly reply: Reply;
}

type ByTag<U, T> = Extract<U, { readonly tag: T }>;
type ReplyTags<C extends Command.Any> = C extends {
  readonly reply: Schema.Top;
  readonly tag: infer T extends string;
}
  ? T
  : never;

type IdSchema = Schema.Top & { readonly Type: string; readonly Encoded: string };

/** What `decide` returns for a command: events, a rejection, or an Effect of either. */
export type Decision<C extends Command.Any> =
  | ReadonlyArray<Inst<C["events"][number]>>
  | Inst<C["rejects"][number]>
  | Effect.Effect<
      ReadonlyArray<Inst<C["events"][number]>>,
      Inst<C["rejects"][number]>,
      Command.ContextOf<C>
    >;

/** The event classes a set of commands may record. */
export type EventsOf<C extends ReadonlyArray<Command.Any>> = C[number]["events"][number];

/**
 * The pure definition of an aggregate: identity, state, the commands it
 * decides and the events it folds. Its events are those its commands declare.
 */
export interface Definition<
  Id extends IdSchema,
  S extends Schema.Top,
  C extends ReadonlyArray<Command.Any>,
  Ms extends Middleware.List = readonly [],
  Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
  E extends Event.Any = EventsOf<C>,
> {
  /** Schema of the aggregate id (a string or branded string). */
  readonly id: Id;
  /** Schema of the aggregate's state. Used to persist snapshots. */
  readonly state: S;
  /** The state of an instance that has never committed an event. */
  readonly initial: S["Type"];
  /** Every command this aggregate handles, each declaring the events it records. */
  readonly commands: C;
  /**
   * One handler per command: returns the events to commit (from the command's
   * declared events), an empty array for an accepted no-op, or one of the
   * command's declared rejections. A handler may be an Effect that reads the
   * context its command's middleware provides (e.g. `yield* CurrentActor`)
   * and fails with a rejection; it may require nothing else.
   */
  readonly decide: {
    readonly [T in C[number]["tag"]]: (
      state: S["Type"],
      command: Inst<ByTag<C[number], T>>,
      ctx: DecideContext<Id["Type"]>,
    ) => Decision<ByTag<C[number], T>>;
  };
  /**
   * One handler per event: folds a committed event into state. Throw when an
   * event cannot apply to the current state; that is a bug, not a rejection.
   */
  readonly evolve: {
    readonly [T in E["tag"]]: (
      state: S["Type"],
      event: Inst<ByTag<E, T>>,
      envelope: Envelope<Id["Type"]>,
    ) => S["Type"];
  };
  /**
   * One handler per command that declares a reply: computes it from the
   * updated state and the committed events.
   */
  readonly reply?: {
    readonly [T in ReplyTags<C[number]>]: (
      state: S["Type"],
      events: ReadonlyArray<Inst<E>>,
    ) => NonNullable<ByTag<C[number], T>["reply"]>["Type"];
  };
  /**
   * Let an Api expose this aggregate's state and committed events to clients
   * (`get`, `watch`, `events`): its middleware, rejections, and `validate`,
   * which judges each read against the instance's current state.
   */
  readonly read?: Read.Contract<{ readonly id: Id["Type"] }, S["Type"], Ms, Rejects>;
}

/**
 * Type-level identity of an aggregate in an Effect's requirements.
 */
export interface Key<Name extends string> {
  readonly "~alchemy/Domain/Aggregate": Name;
}

/**
 * Options for {@link Client.send}.
 */
export interface SendOptions {
  /** Idempotency key. A command with an already-seen id returns the original receipt. */
  readonly commandId?: string;
}

/**
 * Options for {@link Client.schedule}: when to send, absolutely or after a delay.
 */
export type ScheduleOptions = SendOptions &
  (
    | { readonly at: DateTime.Utc; readonly after?: never }
    | { readonly after: Duration.Input; readonly at?: never }
  );

/**
 * When a scheduled command is due: an epoch-millisecond time, or a delay the
 * platform measures on its own clock (stories control it with `clock`).
 */
export type Due = { readonly at: number } | { readonly afterMillis: number };

/**
 * Metadata a platform receives with every command.
 */
export interface SendMeta {
  readonly commandId: string;
  /** The command context services the sender provided, encoded. */
  readonly context: RequestContext.Json;
}

type AnyHandlers = { readonly [tag: string]: (...args: never[]) => unknown };

/**
 * The widened shape of every {@link Definition}.
 */
export interface AnyDefinition {
  readonly id: IdSchema;
  readonly state: Schema.Top;
  readonly initial: unknown;
  readonly commands: ReadonlyArray<Command.Any>;
  readonly events: ReadonlyArray<Event.Any>;
  readonly decide: AnyHandlers;
  readonly evolve: AnyHandlers;
  readonly reply?: AnyHandlers;
  readonly read?: Read.AnyContract;
}

/** An aggregate instance to address: its id, or a ref carrying it. */
export type Target<Def extends AnyDefinition> =
  | Def["id"]["Type"]
  | { readonly id: Def["id"]["Type"] };

type CommandClassOf<Def extends AnyDefinition, Cmd> = ByTag<
  Def["commands"][number],
  Cmd extends { readonly _tag: infer T } ? T : never
>;

type ReplyOf<C> = C extends { readonly reply: infer R }
  ? R extends Schema.Top
    ? R["Type"]
    : void
  : void;

/**
 * The runtime API of an aggregate, obtained with `yield* MyAggregate`. Resolve
 * it once while building a policy or an operation, then call it per event or
 * request; its methods require nothing.
 *
 * **Example:** Sending a command
 * ```typescript
 * const accounts = yield* Account;
 * const { reply } = yield* accounts.send(accountId, new WithdrawMoney({ amount: 30 }));
 * ```
 */
export interface Client<Def extends AnyDefinition> {
  /**
   * Send a command. Succeeds with a {@link Receipt} once the resulting events
   * are committed, or fails with one of the command's declared rejections.
   * Requires the context the command's middleware provides (e.g. the current
   * actor): an Api's middleware provides it, other senders provide it.
   */
  readonly send: <Cmd extends Inst<Def["commands"][number]>>(
    target: Target<Def>,
    command: Cmd,
    options?: SendOptions,
  ) => Effect.Effect<
    Receipt<Inst<Def["events"][number]>, ReplyOf<CommandClassOf<Def, Cmd>>>,
    Inst<CommandClassOf<Def, Cmd>["rejects"][number]>,
    Command.ContextOf<CommandClassOf<Def, Cmd>>
  >;
  /**
   * Send a command later, durably: a deadline or a reminder. Only commands
   * that never reject can be scheduled, since nobody is waiting to handle a
   * rejection when it fires; such a command reports a fact ("the approval
   * window closed") and records nothing when it no longer applies.
   * Scheduling again with the same command id replaces the earlier one.
   */
  readonly schedule: <Cmd extends Inst<Schedulable<Def>>>(
    target: Target<Def>,
    command: Cmd,
    options: ScheduleOptions,
  ) => Effect.Effect<void, never, Command.ContextOf<CommandClassOf<Def, Cmd>>>;
  /** Read the current state of an instance. */
  readonly state: (target: Target<Def>) => Effect.Effect<Def["state"]["Type"]>;
}

/** The commands of a definition that never reject, so can be scheduled. */
export type Schedulable<Def extends AnyDefinition> = Extract<
  Def["commands"][number],
  { readonly rejects: readonly [] }
>;

/**
 * The untyped form of {@link Client} the framework implements.
 *
 * @internal
 */
export interface ClientImpl {
  readonly send: (
    target: unknown,
    command: { readonly _tag: string },
    options?: SendOptions,
  ) => Effect.Effect<Receipt, unknown>;
  readonly schedule: (
    target: unknown,
    command: { readonly _tag: string },
    options: ScheduleOptions,
  ) => Effect.Effect<void>;
  readonly state: (target: unknown) => Effect.Effect<unknown>;
}

/**
 * Structural constraint satisfied by every aggregate class.
 */
export interface Any extends Context.Key<unknown, unknown> {
  readonly kind: "Aggregate";
  readonly aggregateName: string;
  readonly definition: AnyDefinition;
}

/** The id type of an aggregate class. */
export type IdOf<A extends Any> = A["definition"]["id"]["Type"];
/** The state type of an aggregate class. */
export type StateOf<A extends Any> = A["definition"]["state"]["Type"];
/** The event instance types of an aggregate class. */
export type EventOf<A extends Any> = Inst<A["definition"]["events"][number]>;
/** The command instance types of an aggregate class. */
export type CommandOf<A extends Any> = Inst<A["definition"]["commands"][number]>;
/** The requirement identifier of an aggregate class. */
export type Identifier<A extends Any> = A extends Context.Key<infer I, unknown> ? I : never;

const RefClass = Symbol.for("alchemy/Domain/Ref.class");

/**
 * A typed address of one aggregate instance: aggregate type plus id.
 */
export interface Ref<A extends Any = Any> {
  readonly aggregate: A["aggregateName"];
  readonly id: IdOf<A>;
  readonly [RefClass]: A;
}

/** @internal */
export const refClass = <A extends Any>(ref: Ref<A>): A => ref[RefClass];

/**
 * One entity that decides, such as a bank account: a consistency boundary.
 * It takes a command, checks it against its current state, and records events
 * or returns a rejection. Each instance handles one command at a time, and
 * its events, new state and reply commit together.
 *
 * ### Deciding and evolving
 * **Example:** An account that refuses overdrafts
 * ```typescript
 * import * as Domain from "alchemy/Domain";
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
 *   target: AccountId,
 *   input: { amount: Schema.Int },
 *   events: [MoneyWithdrawn],
 *   rejects: [InsufficientFunds],
 *   reply: { balance: Schema.Int },
 * }) {}
 *
 * export class Account extends Domain.Aggregate("Account", {
 *   id: AccountId,
 *   state: Schema.Struct({ balance: Schema.Int }),
 *   initial: { balance: 0 },
 *   commands: [WithdrawMoney],
 *   decide: {
 *     WithdrawMoney: (s, cmd) =>
 *       cmd.amount > s.balance
 *         ? new InsufficientFunds({ balance: s.balance, requested: cmd.amount })
 *         : [new MoneyWithdrawn({ amount: cmd.amount, balanceAfter: s.balance - cmd.amount })],
 *   },
 *   evolve: {
 *     MoneyWithdrawn: (_, e) => ({ balance: e.balanceAfter }),
 *   },
 *   reply: {
 *     WithdrawMoney: (s) => ({ balance: s.balance }),
 *   },
 * }) {}
 * ```
 *
 * ### Authorizing in decide
 * A handler can be an `Effect.fn` that reads what the command's middleware
 * provides.
 *
 * **Example:** Only the owner may withdraw
 * ```typescript
 * decide: {
 *   WithdrawMoney: Effect.fn(function* (s, cmd) {
 *     const actor = yield* CurrentActor;
 *     if (actor.customerId !== s.owner) return yield* new NotOwner();
 *     return [new MoneyWithdrawn({ amount: cmd.amount, balanceAfter: s.balance - cmd.amount })];
 *   }),
 * },
 * ```
 *
 * ### Exposing reads
 * `read` lets an Api expose the aggregate itself, so a client can get it,
 * watch it, and follow its events. `validate` judges every read.
 *
 * **Example:** A read contract
 * ```typescript
 * read: {
 *   middleware: [Session],
 *   rejects: [NotOwner],
 *   validate: Effect.fn(function* (_request, s) {
 *     const actor = yield* CurrentActor;
 *     if (actor.customerId !== s.owner) return yield* new NotOwner();
 *   }),
 * },
 * ```
 *
 * ### Sending and scheduling
 * **Example:** From a policy or your own code
 * ```typescript
 * const accounts = yield* Account;
 * const { reply } = yield* accounts.send(accountId, new WithdrawMoney({ amount: 30 }));
 * yield* accounts.schedule(accountId, new SendStatement(), { after: "30 days" });
 * ```
 *
 * @primitive
 */
export const makeRef = <A extends Any>(aggregate: A, id: IdOf<A>): Ref<A> => {
  const ref = { aggregate: aggregate.aggregateName, id } as Ref<A>;
  Object.defineProperty(ref, RefClass, { value: aggregate, enumerable: false });
  return ref;
};

/** The stream id of a ref, e.g. `Account/a-1`. */
export const streamOf = (ref: { readonly aggregate: string; readonly id: string }) =>
  `${ref.aggregate}/${ref.id}`;

/** The id addressed by a {@link Target}. @internal */
export const targetId = (target: unknown): string =>
  typeof target === "object" && target !== null && "id" in target
    ? String((target as { readonly id: unknown }).id)
    : String(target);

/**
 * The policy run in progress: which policy, for which key, and deterministic
 * command ids for its sends, so a re-run of the same trigger is deduplicated
 * by the target aggregate.
 *
 * @internal
 */
export class PolicyRun extends Context.Service<
  PolicyRun,
  { readonly policy: string; readonly key: Ref; readonly next: () => string }
>()("alchemy/Domain/PolicyRun") {}

/**
 * The command id for a send: the caller's; inside a saga step, the step's
 * next id, so a step that runs again sends the same commands; the policy
 * run's next deterministic id; or a fresh one.
 *
 * @internal
 */
export const commandIdFor = (options: SendOptions | undefined): Effect.Effect<string> =>
  options?.commandId !== undefined
    ? Effect.succeed(options.commandId)
    : Effect.gen(function* () {
        // A step is the narrower scope: a saga started by a policy runs inside it.
        const step = yield* Effect.serviceOption(CurrentActivity);
        if (Option.isSome(step)) return step.value.next();
        const policy = yield* Effect.serviceOption(PolicyRun);
        if (Option.isSome(policy)) return policy.value.next();
        return yield* Effect.sync(() => crypto.randomUUID());
      });

/**
 * Declare an aggregate: a consistency boundary keyed by id that decides
 * commands against its current state and records events.
 *
 * The class is also a service tag: `yield* Customer` gives its {@link Client}
 * (`send`, `state`), provided by the Domain's Layer.
 *
 * **Example:** Declaring an aggregate
 * ```typescript
 * export class Customer extends Domain.Aggregate("Customer", {
 *   id: CustomerId,
 *   state: CustomerState,
 *   initial: { _tag: "New" },
 *   commands: [Register], // declares events: [CustomerRegistered]
 *   decide: {
 *     Register: (s, cmd) =>
 *       s._tag === "Registered" ? new AlreadyRegistered() : [new CustomerRegistered({ name: cmd.name })],
 *   },
 *   evolve: {
 *     CustomerRegistered: (_, e) => ({ _tag: "Registered", name: e.name }),
 *   },
 * }) {}
 *
 * const customers = yield* Customer;
 * yield* customers.send("c-1", new Register({ name: "sam" }));
 * ```
 */
export const make = <
  const Name extends string,
  Id extends IdSchema,
  S extends Schema.Top,
  const C extends ReadonlyArray<Command.Any>,
  const Ms extends Middleware.List = readonly [],
  const Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
>(
  name: Name,
  definition: Definition<Id, S, C, Ms, Rejects>,
): AggregateClass<Name, Resolved<Id, S, C, Ms, Rejects>> => {
  const Tag = Context.Service<Key<Name>, Client<Resolved<Id, S, C, Ms, Rejects>>>()(
    `alchemy/Domain/Aggregate/${name}`,
  );
  const decodeId = Schema.decodeUnknownSync(
    definition.id as unknown as Schema.Codec<unknown, unknown>,
  );
  return class extends Tag {
    static readonly kind = "Aggregate" as const;
    static readonly aggregateName: Name = name;
    static readonly definition: Resolved<Id, S, C, Ms, Rejects> = {
      ...definition,
      events: [...new Set(definition.commands.flatMap((command) => command.events))],
    } as unknown as Resolved<Id, S, C, Ms, Rejects>;
    /** Address one instance of this aggregate. */
    static ref<Self extends Any>(this: Self, id: Self["definition"]["id"]["Encoded"]): Ref<Self> {
      return makeRef(this, decodeId(id) as IdOf<Self>);
    }
  } as unknown as AggregateClass<Name, Resolved<Id, S, C, Ms, Rejects>>;
};

/** A definition with its events collected from its commands. */
export type Resolved<
  Id extends IdSchema,
  S extends Schema.Top,
  C extends ReadonlyArray<Command.Any>,
  Ms extends Middleware.List = readonly [],
  Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
> = Definition<Id, S, C, Ms, Rejects> & { readonly events: ReadonlyArray<EventsOf<C>> };

/**
 * The class type returned by {@link make}.
 */
export interface AggregateClass<
  Name extends string,
  Def extends AnyDefinition,
> extends Context.ServiceClass<Key<Name>, string, Client<Def>> {
  readonly kind: "Aggregate";
  readonly aggregateName: Name;
  readonly definition: Def;
  /** Address one instance of this aggregate. */
  ref<Self extends Any>(this: Self, id: Self["definition"]["id"]["Encoded"]): Ref<Self>;
}
