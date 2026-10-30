import { CurrentActivity } from "alchemy/WorkflowEncoding";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Command from "./Command.ts";
import type * as Event from "./Event.ts";
import { DefinitionError, judge, settle, targetId as internalTargetId } from "./internal.ts";
import type * as Middleware from "./Middleware.ts";
import type * as Read from "./Read.ts";
import * as Rejection from "./Rejection.ts";
import * as RequestContext from "./RequestContext.ts";
import type * as Telemetry from "./Telemetry.ts";

/**
 * The instance type of a class: `InstanceOf<typeof NotOwner>` is `NotOwner`.
 * Distributes over a union of classes.
 */
export type InstanceOf<C> = C extends abstract new (...args: any[]) => infer I ? I : never;

/**
 * Context passed to every `decide` handler.
 */
export interface DecideContext<Id> {
  /** The id of the aggregate instance handling the command. */
  readonly id: Id;
  /** The id the command was sent with; its events' envelopes carry it too. */
  readonly commandId: string;
  /** The stream the command's events commit to, e.g. `Account/a-1`. */
  readonly stream: string;
  /** The stream's version before this decision: `0` for a new instance. */
  readonly version: number;
  /** The time the command is being handled. Controlled by stories via `clock`. */
  readonly now: DateTime.Utc;
}

/**
 * Metadata recorded with every committed event. Its schema is what Api clients
 * decode, so the wire carries every field.
 */
export const Envelope = Schema.Struct({
  /** The id of the aggregate instance that committed the event. */
  id: Schema.String,
  /** The stream the event belongs to, e.g. `Account/a-1`. */
  stream: Schema.String,
  /** The event's sequence number within its stream, starting at 1. */
  seq: Schema.Number,
  /** The commit time. */
  at: Schema.DateTimeUtc,
  /** The id of the command that produced the event. */
  commandId: Schema.String,
  /**
   * The id of the first command in the chain that led here: the same for a
   * command, the events it records, and every reaction and command they cause.
   */
  correlationId: Schema.String,
});

/** An {@link Envelope} whose `id` is the aggregate's (branded) id. */
export type Envelope<Id = string> = typeof Envelope.Type & { readonly id: Id };

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

/**
 * What {@link Client.schedule} returns: the pending command's id, to
 * `unschedule` it by, and when it is due.
 */
export interface ScheduleReceipt {
  /** The command id: the one passed in `options`, or the one derived for it. */
  readonly commandId: string;
  /** When the command is due, on the platform's clock. */
  readonly at: DateTime.Utc;
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
 * What `decide` returns for a command: events, a rejection, or an Effect of
 * either. The Effect may read what the command's middleware provides.
 */
export type Decision<C extends Command.Any> =
  | ReadonlyArray<InstanceOf<C["events"][number]>>
  | InstanceOf<C["rejects"][number]>
  | Effect.Effect<
      ReadonlyArray<InstanceOf<C["events"][number]>>,
      InstanceOf<C["rejects"][number]>,
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
  P extends string = never,
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
      command: InstanceOf<ByTag<C[number], T>>,
      ctx: DecideContext<Id["Type"]>,
    ) => Decision<ByTag<C[number], T>>;
  };
  /**
   * One handler per event: folds a committed event into state. It covers
   * every state and never fails: `decide` refuses a command with a rejection
   * before it records an event, so a handler keeps a state its event can't
   * follow.
   */
  readonly evolve: {
    readonly [T in E["tag"]]: (
      state: S["Type"],
      event: InstanceOf<ByTag<E, T>>,
      envelope: Envelope<Id["Type"]>,
    ) => S["Type"];
  };
  /**
   * One handler per command that declares a reply: computes it from the
   * updated state and the committed events. Like `evolve`, it covers every
   * state and never fails.
   */
  readonly reply?: {
    readonly [T in ReplyTags<C[number]>]: (
      state: S["Type"],
      events: ReadonlyArray<InstanceOf<E>>,
    ) => NonNullable<ByTag<C[number], T>["reply"]>["Type"];
  };
  /**
   * Let an Api expose this aggregate's state and committed events to clients
   * (`get`, `watch`, `events`): its middleware, rejections, and `validate`,
   * which judges each read against the instance's current state.
   */
  readonly read?: Read.Contract<{ readonly id: Id["Type"] }, S["Type"], Ms, Rejects>;
  /**
   * Every phase this aggregate can be in, each with the moves its events make.
   * Declare it with `phaseOf` and `when`. See {@link Phase}.
   */
  readonly phases?: {
    readonly [K in P]: Phase<
      NoInfer<P>,
      E["tag"],
      S["Type"],
      Extract<C[number], { readonly rejects: readonly [] }>
    >;
  };
  /** The phase a state is in. The state stays the only thing that is stored. */
  readonly phaseOf?: (state: S["Type"]) => NoInfer<P>;
  /**
   * The phases in which each command may run, or `"*"` for all of them. See
   * {@link WrongPhase} for what happens to a command outside its phases.
   */
  readonly when?: { readonly [T in C[number]["tag"]]: ReadonlyArray<NoInfer<P>> | "*" };
}

/**
 * One phase of an aggregate's life, such as `draft` or `approved`. Phases are
 * data, so `Domain.verify`, a client and a diagram read the same rule.
 */
export interface Phase<
  P extends string = string,
  Tag extends string = string,
  State = never,
  Timer extends Command.Any = Command.Any,
> {
  /**
   * The phases an event may move an instance to from this one. An event that
   * has no entry leaves the instance in this phase. An instance that moves in
   * any other way is a defect, and nothing commits.
   */
  readonly on?: { readonly [T in Tag]?: P | ReadonlyArray<P> };
  /**
   * Commands this phase sends after a delay, keyed by the delay (`"24 hours"`).
   * Each one is a command that never rejects: its class, when it takes no
   * input, or a function of the state. The host arms them when an instance
   * enters the phase, and cancels them when it leaves.
   */
  readonly after?: {
    readonly [delay: string]: Timer | ((state: State) => InstanceOf<Timer>);
  };
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
 * The instance already handled a command with this id, so it can no longer
 * be scheduled or cancelled: a deadline that fired before it was cancelled,
 * or a command id that was already sent.
 */
export class AlreadyExecuted extends Data.TaggedError("AlreadyExecuted")<{
  readonly aggregate: string;
  readonly id: string;
  readonly commandId: string;
}> {}

/** The scheduled command with this id was already cancelled. */
export class AlreadyCancelled extends Data.TaggedError("AlreadyCancelled")<{
  readonly aggregate: string;
  readonly id: string;
  readonly commandId: string;
}> {}

/** No command was ever scheduled with this id on the instance. */
export class NotScheduled extends Data.TaggedError("NotScheduled")<{
  readonly aggregate: string;
  readonly id: string;
  readonly commandId: string;
}> {}

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
  /** The flow the command belongs to (see {@link Envelope.correlationId}). */
  readonly correlationId?: string;
  /** The span that sent the command, so the aggregate's span continues its trace. */
  readonly trace?: Telemetry.TraceJson;
  /** Link to `trace` instead of continuing it: the command runs later (scheduled). */
  readonly link?: boolean;
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
  readonly phases?: { readonly [phase: string]: Phase<string, string, never, any> };
  readonly phaseOf?: (state: never) => string;
  readonly when?: { readonly [tag: string]: ReadonlyArray<string> | "*" };
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
  readonly send: <Cmd extends InstanceOf<Def["commands"][number]>>(
    target: Target<Def>,
    command: Cmd,
    options?: SendOptions,
  ) => Effect.Effect<
    Receipt<InstanceOf<Def["events"][number]>, ReplyOf<CommandClassOf<Def, Cmd>>>,
    InstanceOf<CommandClassOf<Def, Cmd>["rejects"][number]>,
    Command.ContextOf<CommandClassOf<Def, Cmd>>
  >;
  /**
   * Send a command later, durably: a deadline or a reminder. Only commands
   * that never reject can be scheduled, since nobody is waiting to handle a
   * rejection when it fires; such a command reports a fact ("the approval
   * window closed") and records nothing when it no longer applies.
   * Scheduling again with the same command id replaces the earlier one.
   * Returns the command id to `unschedule` it by, and when it is due. Fails with `AlreadyExecuted` when the instance already handled a command
   * with that id.
   */
  readonly schedule: <Cmd extends InstanceOf<Schedulable<Def>>>(
    target: Target<Def>,
    command: Cmd,
    options: ScheduleOptions,
  ) => Effect.Effect<ScheduleReceipt, AlreadyExecuted, Command.ContextOf<CommandClassOf<Def, Cmd>>>;
  /**
   * Cancel a pending scheduled command by the command id it was scheduled
   * with. Once it succeeds, the command never runs. Fails with
   * `AlreadyExecuted` when the command ran first, `AlreadyCancelled` when it
   * was cancelled before, and `NotScheduled` when nothing was scheduled with
   * that id.
   */
  readonly unschedule: (
    target: Target<Def>,
    commandId: string,
  ) => Effect.Effect<void, AlreadyExecuted | AlreadyCancelled | NotScheduled>;
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
  ) => Effect.Effect<ScheduleReceipt, AlreadyExecuted>;
  readonly unschedule: (
    target: unknown,
    commandId: string,
  ) => Effect.Effect<void, AlreadyExecuted | AlreadyCancelled | NotScheduled>;
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
export type EventOf<A extends Any> = InstanceOf<A["definition"]["events"][number]>;
/** The command instance types of an aggregate class. */
export type CommandOf<A extends Any> = InstanceOf<A["definition"]["commands"][number]>;
/** The requirement identifier of an aggregate class. */
export type Identifier<A extends Any> = A extends Context.Key<infer I, unknown> ? I : never;
/** The phases of an aggregate class; `never` when it declares none. */
export type PhaseOf<A extends Any> = Extract<keyof NonNullable<A["definition"]["phases"]>, string>;

/** The phase of a state, or `undefined` for an aggregate with no phases. */
export const phaseIn = (aggregate: Any, state: unknown): string | undefined =>
  (aggregate.definition.phaseOf as ((state: unknown) => string) | undefined)?.(state);

/**
 * The tags of the commands that may run in a state. Every command, for an
 * aggregate with no phases. `decide` still has the last word on each one.
 */
export const nextCommands = (aggregate: Any, state: unknown): ReadonlyArray<string> => {
  const def = aggregate.definition;
  const phase = phaseIn(aggregate, state);
  return def.commands
    .filter((command) => {
      const allowed = def.when?.[command.tag];
      return phase === undefined || allowed === "*" || allowed?.includes(phase);
    })
    .map((command) => command.tag);
};

/**
 * What a command gets without `decide`, when it runs outside its phases: a
 * {@link WrongPhase}, or no events for a command that declares no rejections.
 * `undefined` when `decide` should run.
 *
 * @internal
 */
export const refusal = (aggregate: Any, command: Command.Any, state: unknown): unknown => {
  const allowed = aggregate.definition.when?.[command.tag];
  const phase = phaseIn(aggregate, state);
  if (phase === undefined || allowed === undefined || allowed === "*") return undefined;
  if (allowed.includes(phase)) return undefined;
  return command.rejects.length === 0
    ? []
    : Rejection.WrongPhase.make({ command: command.tag, phase, allowed });
};

const targetsOf = (phase: Phase, tag: string): ReadonlyArray<string> =>
  [
    (phase.on as Readonly<Record<string, string | ReadonlyArray<string>>> | undefined)?.[tag] ?? [],
  ].flat();

/**
 * The {@link DefinitionError} for an event that moved an instance in a way
 * `phases` does not declare, if it did.
 *
 * @internal
 */
export const undeclaredMove = (
  aggregate: Any,
  event: string,
  before: unknown,
  after: unknown,
): DefinitionError | undefined => {
  const from = phaseIn(aggregate, before);
  const to = phaseIn(aggregate, after);
  if (from === undefined || to === undefined || from === to) return undefined;
  const phase = aggregate.definition.phases?.[from];
  return phase && targetsOf(phase, event).includes(to)
    ? undefined
    : new DefinitionError(
        `${aggregate.aggregateName}: '${event}' moved an instance from '${from}' to '${to}', which phases.${from}.on does not declare`,
      );
};

/** A phase's timer, as the kernel sees it. */
type AnyTimer = Command.Any | ((state: unknown) => { readonly _tag: string });

const timersOf = (phase: Phase | undefined): ReadonlyArray<readonly [string, AnyTimer]> =>
  Object.entries((phase?.after ?? {}) as Readonly<Record<string, AnyTimer>>);

const isCommandClass = (timer: AnyTimer): timer is Command.Any => "tag" in timer;

/** The command a timer sends: its class, or what its function builds from the state. */
const timerCommand = (timer: AnyTimer, state: unknown) =>
  // oxlint-disable-next-line effecttsgo/new-schema-class -- Command.Any has no `make`
  isCommandClass(timer) ? new timer() : timer(state);

/** The host derives a timer's id from its phase and delay, so a phase has one per delay. */
const timerId = (phase: string, delay: string) => `phase-timer:${phase}:${delay}`;

/**
 * What the phase moves of one commit do to timers, by timer id: the last move
 * wins, so an instance that leaves a phase and returns in one commit arms its
 * timers again. `from` is `undefined` when an instance first commits, which
 * enters the initial phase.
 *
 * @internal
 */
export const timerChanges = (
  aggregate: Any,
  moves: ReadonlyArray<{ readonly from: string | undefined; readonly to: string }>,
  state: unknown,
): { readonly arm: ReadonlyArray<PhaseTimer>; readonly cancel: ReadonlyArray<string> } => {
  const phases = aggregate.definition.phases;
  const changes = new Map<string, PhaseTimer | "cancel">();
  for (const { from, to } of moves) {
    if (from !== undefined) {
      for (const [delay] of timersOf(phases?.[from])) changes.set(timerId(from, delay), "cancel");
    }
    for (const [delay, timer] of timersOf(phases?.[to])) {
      changes.set(timerId(to, delay), {
        commandId: timerId(to, delay),
        command: timerCommand(timer, state),
        afterMillis: Duration.toMillis(Duration.fromInputUnsafe(delay as Duration.Input)),
      });
    }
  }
  const armed = [...changes.values()].filter((change) => change !== "cancel");
  const cancelled = [...changes].flatMap(([id, change]) => (change === "cancel" ? [id] : []));
  return { arm: armed, cancel: cancelled };
};

/** A command a phase sends after a delay, under an id the host derives. @internal */
export interface PhaseTimer {
  readonly commandId: string;
  readonly command: { readonly _tag: string };
  readonly afterMillis: number;
}

/** Every problem in a phase's `after`. */
const timerProblems = (
  aggregate: Any,
  from: string,
  phase: Phase,
  allowedIn: (command: Command.Any, phase: string) => boolean,
): ReadonlyArray<string> => {
  const name = aggregate.aggregateName;
  return timersOf(phase).flatMap(([delay, timer]) => {
    const where = `${name}.phases.${from}.after["${delay}"]`;
    const problems: Array<string> = [];
    if (Option.isNone(Duration.fromInput(delay as Duration.Input))) {
      problems.push(`${where} is not a duration: write it like "24 hours"`);
    }
    if (!isCommandClass(timer)) return problems;
    const command = aggregate.definition.commands.find((c) => c === timer);
    if (command === undefined) return [...problems, `${where} is not a command of ${name}`];
    if (command.rejects.length > 0) {
      problems.push(`${where}: ${command.tag} declares rejections, and nobody waits for a timer`);
    }
    if (command.middleware.length > 0) {
      problems.push(`${where}: ${command.tag} has middleware, and a timer has no caller`);
    }
    if (!allowedIn(command, from)) {
      problems.push(`${where}: when does not let ${command.tag} run in '${from}'`);
    }
    if (
      Object.keys((command as unknown as { readonly fields?: object }).fields ?? {}).some(
        (field) => field !== "_tag",
      )
    ) {
      problems.push(`${where}: ${command.tag} takes input: use a function of the state`);
    }
    return problems;
  });
};

/**
 * Every problem in an aggregate's phases: a table that is not complete, a
 * phase nothing can reach, a command that can never run, and a move no event
 * can make. Empty for an aggregate with no phases.
 *
 * @internal
 */
export const phaseProblems = (aggregate: Any): ReadonlyArray<string> => {
  const { aggregateName: name, definition: def } = aggregate;
  const { phases, phaseOf, when } = def;
  if (phases === undefined && phaseOf === undefined && when === undefined) return [];
  if (phases === undefined || phaseOf === undefined || when === undefined) {
    return [`${name} must declare phases, phaseOf and when together`];
  }
  const problems: Array<string> = [];
  const known = (phase: string) => Object.hasOwn(phases, phase);
  const eventTags = new Set(def.events.map((event) => event.tag));
  const commandTags = new Set(def.commands.map((command) => command.tag));
  const allowedIn = (command: Command.Any, phase: string) => {
    const allowed = when[command.tag];
    return allowed === "*" || (allowed?.includes(phase) ?? false);
  };

  for (const tag of Object.keys(when)) {
    if (!commandTags.has(tag)) problems.push(`${name}.when.${tag} is not a command of ${name}`);
  }
  for (const command of def.commands) {
    const allowed = when[command.tag];
    if (allowed === undefined || allowed.length === 0) {
      problems.push(`${name}: ${command.tag} runs in no phase: add it to when`);
      continue;
    }
    if (allowed === "*") continue;
    for (const phase of allowed) {
      if (!known(phase)) {
        problems.push(`${name}.when.${command.tag} names unknown phase '${phase}'`);
      }
    }
    if (command.rejects.length > 0 && !command.rejects.includes(Rejection.WrongPhase)) {
      problems.push(
        `${name}: ${command.tag} can run outside its phases, so it must declare Domain.WrongPhase in rejects (or declare no rejections, and record nothing there)`,
      );
    }
  }

  const moves = new Map<string, ReadonlyArray<string>>();
  for (const [from, phase] of Object.entries(phases)) {
    const reached: Array<string> = [];
    for (const tag of Object.keys(phase.on ?? {})) {
      const targets = targetsOf(phase, tag);
      for (const to of targets) {
        if (!known(to))
          problems.push(`${name}.phases.${from}.on.${tag} names unknown phase '${to}'`);
      }
      if (!eventTags.has(tag)) {
        problems.push(`${name}.phases.${from}.on.${tag} is not an event of ${name}`);
        continue;
      }
      const made = def.commands.some(
        (command) => allowedIn(command, from) && command.events.some((e) => e.tag === tag),
      );
      if (made) reached.push(...targets);
      else
        problems.push(
          `${name}: no command that runs in '${from}' records '${tag}', so that move can never happen`,
        );
    }
    moves.set(from, reached);
    problems.push(...timerProblems(aggregate, from, phase, allowedIn));
  }

  const initial = (phaseOf as (state: unknown) => string)(def.initial);
  if (!known(initial)) {
    problems.push(`${name}.phaseOf(initial) is '${initial}', which is not in phases`);
    return problems;
  }
  const reachable = new Set([initial]);
  for (const from of reachable) for (const to of moves.get(from) ?? []) reachable.add(to);
  for (const phase of Object.keys(phases)) {
    if (!reachable.has(phase)) problems.push(`${name}: no move reaches phase '${phase}'`);
  }
  return problems;
};

/**
 * Options for {@link predict}: what the server would give `decide`. A command
 * with middleware needs `context`: what its middleware provides, from a
 * client-side Layer of the same services.
 */
export type PredictOptions<Id = string, R = never> = PredictBase<Id> &
  ([R] extends [never]
    ? { readonly context?: Context.Context<never> }
    : { readonly context: Context.Context<R> });

interface PredictBase<Id> {
  /** The id of the instance the command targets. */
  readonly id: Id;
  /** The time the command is decided at (the server stamps commands with its clock). */
  readonly now: DateTime.Utc;
  /** The state's version: `decide` sees it, and predicted envelopes continue from it. Defaults to `0`. */
  readonly version?: number;
  /** The id the command will be sent with, for `decide` and the predicted envelopes. Defaults to `""`. */
  readonly commandId?: string;
  /** Defaults to the command id. */
  readonly correlationId?: string;
}

/**
 * What the aggregate would do with a command, decided locally: the events it
 * would record and the state after them, the rejection it would return, or
 * `Unpredictable` when only the server can tell. `cause` says why: `decide`
 * waited on something asynchronous (the server awaits it; `predict` is
 * synchronous), died, or broke its command's declaration through a cast (a
 * `DefinitionError`, which the server dies on).
 */
export type Prediction<State, Ev, Rej, Id = string> =
  | {
      readonly _tag: "Accepted";
      readonly events: ReadonlyArray<Ev>;
      /** One envelope per event, as the server would stamp it (`seq` from `version`). */
      readonly envelopes: ReadonlyArray<Envelope<Id>>;
      readonly state: State;
    }
  | { readonly _tag: "Rejected"; readonly rejection: Rej }
  | { readonly _tag: "Unpredictable"; readonly cause: Cause.Cause<unknown> };

/**
 * Run an aggregate's own `decide` and `evolve` for one command, without a
 * platform: the same events and state, or the same rejection, as the server
 * for the same state, id and time. Use it to show a command's outcome before
 * the server answers.
 *
 * An effectful decision runs here synchronously, as the kernel runs it: a
 * rejection fails with itself, and a `decide` that suspends or dies gives
 * `Unpredictable`. `predict` never throws.
 */
export const predict = (
  aggregate: Any,
  state: unknown,
  command: { readonly _tag: string },
  options: PredictOptions,
): Prediction<unknown, { readonly _tag: string }, { readonly _tag: string }> => {
  const def = aggregate.definition;
  const cls = def.commands.find((c) => c.tag === command._tag);
  const decide = def.decide[command._tag] as
    | ((state: unknown, command: unknown, ctx: DecideContext<unknown>) => unknown)
    | undefined;
  if (!cls || !decide) {
    return {
      _tag: "Unpredictable",
      cause: Cause.die(
        new DefinitionError(`${aggregate.aggregateName} does not handle '${command._tag}'`),
      ),
    };
  }
  const version = options.version ?? 0;
  const commandId = options.commandId ?? "";
  const stream = `${aggregate.aggregateName}/${String(options.id)}`;
  let decision =
    refusal(aggregate, cls, state) ??
    decide(state, command, {
      id: options.id,
      now: options.now,
      commandId,
      stream,
      version,
    });
  if (Effect.isEffect(decision)) {
    const settled = decision.pipe(
      Effect.provideContext((options.context ?? Context.empty()) as Context.Context<unknown>),
      Effect.runSyncExit,
      settle,
    );
    if (settled._tag === "Failed") return { _tag: "Unpredictable", cause: settled.cause };
    decision = settled.decision;
  }
  const judged = judge(aggregate.aggregateName, cls, decision);
  if (judged._tag === "Undeclared")
    return { _tag: "Unpredictable", cause: Cause.die(judged.error) };
  if (judged._tag === "Rejected") return judged;
  const envelopes: Array<Envelope> = [];
  let next = state;
  let undeclared: DefinitionError | undefined;
  judged.events.forEach((event, index) => {
    const envelope: Envelope = {
      id: options.id,
      stream,
      seq: version + index + 1,
      at: options.now,
      commandId,
      correlationId: options.correlationId ?? commandId,
    };
    envelopes.push(envelope);
    const before = next;
    next = (def.evolve[event._tag] as (s: unknown, e: unknown, env: unknown) => unknown)(
      next,
      event,
      envelope,
    );
    undeclared ??= undeclaredMove(aggregate, event._tag, before, next);
  });
  if (undeclared) return { _tag: "Unpredictable", cause: Cause.die(undeclared) };
  return { _tag: "Accepted", events: judged.events, envelopes, state: next };
};

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
 * yield* accounts.schedule(accountId, new SendStatement(), { after: "30 days", commandId: "statement" });
 * yield* accounts.unschedule(accountId, "statement"); // cancel it while it is pending
 * ```
 *
 * ### Declaring phases
 * `phases`, `phaseOf` and `when` state the lifecycle as data. They are
 * optional. The host refuses a command outside its phases before `decide`
 * runs, `Domain.verify` checks the table, and `nextCommands` tells a client
 * what it may send.
 *
 * **Example:** An order that goes from draft to approved
 * ```typescript
 * export class Order extends Domain.Aggregate("Order", {
 *   id: OrderId,
 *   state: Schema.Struct({ status: Schema.Literals(["draft", "approved"]) }),
 *   initial: { status: "draft" },
 *   commands: [Approve],
 *   decide: { Approve: () => [new Approved()] },
 *   evolve: { Approved: () => ({ status: "approved" }) },
 *   phases: { draft: { on: { Approved: "approved" } }, approved: {} },
 *   phaseOf: (s) => s.status,
 *   when: { Approve: ["draft"] },
 * }) {}
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
export const targetId = internalTargetId;

/**
 * Deterministic command ids for sends made while a policy handles a trigger,
 * so a re-run of the same trigger is deduplicated by the target aggregate.
 *
 * @internal
 */
export class PolicyRun extends Context.Service<PolicyRun, { readonly next: () => string }>()(
  "alchemy/Domain/PolicyRun",
) {}

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
  const P extends string = never,
>(
  name: Name,
  definition: Definition<Id, S, C, Ms, Rejects, EventsOf<C>, P> & TargetsMatch<Id, C>,
): AggregateClass<Name, Resolved<Id, S, C, Ms, Rejects, P>> => {
  const Tag = Context.Service<Key<Name>, Client<Resolved<Id, S, C, Ms, Rejects, P>>>()(
    `alchemy/Domain/Aggregate/${name}`,
  );
  // oxlint-disable-next-line effecttsgo/schema-sync -- ids decode synchronously when building refs
  const decodeId = Schema.decodeUnknownSync(
    definition.id as unknown as Schema.Codec<unknown, unknown>,
  );
  return class extends Tag {
    static readonly kind = "Aggregate" as const;
    static readonly aggregateName: Name = name;
    static readonly definition: Resolved<Id, S, C, Ms, Rejects, P> = {
      ...definition,
      events: [...new Set(definition.commands.flatMap((command) => command.events))],
    } as unknown as Resolved<Id, S, C, Ms, Rejects, P>;
    /** Address one instance of this aggregate. */
    static ref<Self extends Any>(this: Self, id: Self["definition"]["id"]["Encoded"]): Ref<Self> {
      return makeRef(this, decodeId(id) as IdOf<Self>);
    }
    /** Decide a command locally. See {@link predict}. */
    static predict(
      this: Any,
      state: unknown,
      command: { readonly _tag: string },
      options: PredictOptions,
    ) {
      return predict(this, state, command, options);
    }
    /** The phase of a state. See {@link phaseIn}. */
    static phase(this: Any, state: unknown) {
      return phaseIn(this, state);
    }
    /** The commands that may run in a state. See {@link nextCommands}. */
    static nextCommands(this: Any, state: unknown) {
      return nextCommands(this, state);
    }
  } as unknown as AggregateClass<Name, Resolved<Id, S, C, Ms, Rejects, P>>;
};

/**
 * A command whose `target` is the aggregate's `id`, both ways; any other
 * command becomes a message naming it.
 */
type CheckTarget<Id extends IdSchema, Cmd> = Cmd extends Command.Any
  ? [Id["Type"]] extends [Cmd["target"]["Type"]]
    ? [Cmd["target"]["Type"]] extends [Id["Type"]]
      ? Cmd
      : `${Cmd["tag"]}'s target must be this aggregate's id schema`
    : `${Cmd["tag"]}'s target must be this aggregate's id schema`
  : Cmd;

/**
 * Every command's `target` must be the aggregate's `id`: an Api decodes the
 * target with the command's schema and the aggregate decodes it with its own.
 * A mismatched command is a type error on its entry in `commands`.
 */
export type TargetsMatch<Id extends IdSchema, C extends ReadonlyArray<Command.Any>> = {
  readonly commands: { readonly [K in keyof C]: CheckTarget<Id, C[K]> };
};

/** A definition with its events collected from its commands. */
export type Resolved<
  Id extends IdSchema,
  S extends Schema.Top,
  C extends ReadonlyArray<Command.Any>,
  Ms extends Middleware.List = readonly [],
  Rejects extends ReadonlyArray<Rejection.Any> = readonly [],
  P extends string = never,
> = Definition<Id, S, C, Ms, Rejects, EventsOf<C>, P> & {
  readonly events: ReadonlyArray<EventsOf<C>>;
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
  /**
   * Decide a command locally, with this aggregate's own `decide` and
   * `evolve`: the events and state, or the rejection, the server would give
   * for the same state, id and time. A command with middleware needs
   * `context`: what its middleware provides, from a client-side Layer. See
   * {@link predict}.
   *
   * **Example:** Show a withdrawal before the bank answers
   * ```typescript
   * const context = yield* Layer.build(Layer.succeed(CurrentActor, actor));
   * const outcome = Account.predict(state, new WithdrawMoney({ amount: 30 }), { id, now, context });
   * if (outcome._tag === "Rejected") showError(outcome.rejection); // InsufficientFunds
   * if (outcome._tag === "Accepted") showPending(outcome.state);
   * ```
   */
  predict<Self extends Any, Cmd extends CommandOf<Self>>(
    this: Self,
    state: StateOf<Self>,
    command: Cmd,
    options: PredictOptions<IdOf<Self>, Command.ContextOf<CommandClassOf<Self["definition"], Cmd>>>,
  ): Prediction<
    StateOf<Self>,
    InstanceOf<CommandClassOf<Self["definition"], Cmd>["events"][number]>,
    InstanceOf<CommandClassOf<Self["definition"], Cmd>["rejects"][number]>,
    IdOf<Self>
  >;
  /** The phase of a state; `undefined` for an aggregate with no phases. */
  phase<Self extends Any>(
    this: Self,
    state: StateOf<Self>,
  ): [PhaseOf<Self>] extends [never] ? undefined : PhaseOf<Self>;
  /**
   * The tags of the commands that may run in a state, from `when`: every
   * command for an aggregate with no phases. A client reads it to enable its
   * buttons, with no second copy of the rule. `decide` still has the last word.
   *
   * **Example:** Enable a button
   * ```typescript
   * const canApprove = Order.nextCommands(state).includes("Approve");
   * ```
   */
  nextCommands<Self extends Any>(
    this: Self,
    state: StateOf<Self>,
  ): ReadonlyArray<Self["definition"]["commands"][number]["tag"]>;
}
