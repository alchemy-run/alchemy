import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Command from "./Command.ts";
import type * as Event from "./Event.ts";

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

/**
 * The pure definition of an aggregate: identity, state, the commands it
 * decides and the events it folds.
 */
export interface Definition<
  Id extends IdSchema,
  S extends Schema.Top,
  C extends ReadonlyArray<Command.Any>,
  E extends ReadonlyArray<Event.Any>,
> {
  /** Schema of the aggregate id (a string or branded string). */
  readonly id: Id;
  /** Schema of the aggregate's state. Used to persist snapshots. */
  readonly state: S;
  /** The state of an instance that has never committed an event. */
  readonly initial: S["Type"];
  /** Every command this aggregate handles. */
  readonly commands: C;
  /** Every event this aggregate emits. */
  readonly events: E;
  /**
   * One handler per command: returns the events to commit, an empty array for
   * an accepted no-op, or one of the command's declared rejections.
   */
  readonly decide: {
    readonly [T in C[number]["tag"]]: (
      state: S["Type"],
      command: Inst<ByTag<C[number], T>>,
      ctx: DecideContext<Id["Type"]>,
    ) => ReadonlyArray<Inst<E[number]>> | Inst<ByTag<C[number], T>["rejects"][number]>;
  };
  /**
   * One handler per event: folds a committed event into state. Throw when an
   * event cannot apply to the current state; that is a bug, not a rejection.
   */
  readonly evolve: {
    readonly [T in E[number]["tag"]]: (
      state: S["Type"],
      event: Inst<ByTag<E[number], T>>,
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
      events: ReadonlyArray<Inst<E[number]>>,
    ) => NonNullable<ByTag<C[number], T>["reply"]>["Type"];
  };
}

/**
 * Type-level identity of an aggregate in an Effect's requirements.
 */
export interface Key<Name extends string> {
  readonly "~alchemy/Fold/Aggregate": Name;
}

/**
 * Options for {@link Client.send}.
 */
export interface SendOptions {
  /** Idempotency key. A command with an already-seen id returns the original receipt. */
  readonly commandId?: string;
}

/**
 * Metadata a platform receives with every command.
 */
export interface SendMeta {
  readonly commandId: string;
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
 * const { reply } = yield* accounts.send(accountId, new Withdraw({ amount: 30, by }));
 * ```
 */
export interface Client<Def extends AnyDefinition> {
  /**
   * Send a command. Succeeds with a {@link Receipt} once the resulting events
   * are committed, or fails with one of the command's declared rejections.
   */
  readonly send: <Cmd extends Inst<Def["commands"][number]>>(
    target: Target<Def>,
    command: Cmd,
    options?: SendOptions,
  ) => Effect.Effect<
    Receipt<Inst<Def["events"][number]>, ReplyOf<CommandClassOf<Def, Cmd>>>,
    Inst<CommandClassOf<Def, Cmd>["rejects"][number]>
  >;
  /** Read the current state of an instance. */
  readonly state: (target: Target<Def>) => Effect.Effect<Def["state"]["Type"]>;
}

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

const RefClass = Symbol.for("alchemy/Fold/Ref.class");

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

/** @internal */
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
 * Deterministic command ids for sends made while a policy handles a trigger,
 * so a re-run of the same trigger is deduplicated by the target aggregate.
 *
 * @internal
 */
export class PolicyRun extends Context.Service<PolicyRun, { readonly next: () => string }>()(
  "alchemy/Fold/PolicyRun",
) {}

/**
 * The command id for a send: the caller's, the policy run's next
 * deterministic id, or a fresh one.
 *
 * @internal
 */
export const commandIdFor = (options: SendOptions | undefined): Effect.Effect<string> =>
  options?.commandId !== undefined
    ? Effect.succeed(options.commandId)
    : Effect.flatMap(Effect.serviceOption(PolicyRun), (run) =>
        Option.isSome(run) ? Effect.sync(run.value.next) : Effect.sync(() => crypto.randomUUID()),
      );

/**
 * Declare an aggregate: a consistency boundary keyed by id that decides
 * commands against its current state and records events.
 *
 * The class is also a service tag: `yield* Customer` gives its {@link Client}
 * (`send`, `state`), provided by the Domain's Layer.
 *
 * **Example:** Declaring an aggregate
 * ```typescript
 * export class Customer extends Aggregate.make("Customer", {
 *   id: CustomerId,
 *   state: CustomerState,
 *   initial: { _tag: "New" },
 *   commands: [Register],
 *   events: [CustomerRegistered],
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
  const E extends ReadonlyArray<Event.Any>,
>(
  name: Name,
  definition: Definition<Id, S, C, E>,
): AggregateClass<Name, Definition<Id, S, C, E>> => {
  const Tag = Context.Service<Key<Name>, Client<Definition<Id, S, C, E>>>()(
    `alchemy/Fold/Aggregate/${name}`,
  );
  const decodeId = Schema.decodeUnknownSync(
    definition.id as unknown as Schema.Codec<unknown, unknown>,
  );
  return class extends Tag {
    static readonly kind = "Aggregate" as const;
    static readonly aggregateName: Name = name;
    static readonly definition: Definition<Id, S, C, E> = definition;
    /** Address one instance of this aggregate. */
    static ref<Self extends Any>(this: Self, id: Self["definition"]["id"]["Encoded"]): Ref<Self> {
      return makeRef(this, decodeId(id) as IdOf<Self>);
    }
  } as unknown as AggregateClass<Name, Definition<Id, S, C, E>>;
};

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
