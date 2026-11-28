import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { DefinitionError, UndeclaredDecision } from "./DefinitionError.ts";

export { DefinitionError } from "./DefinitionError.ts";

/** The defects {@link internalError} made: already logged, sent as they are. */
const internalErrors = new WeakSet<object>();

/**
 * The one defect a client receives in place of any other: a defect's text
 * can hold stacks, file paths and nested errors (an adapter's SQL error).
 *
 * @internal
 */
export const internalError = (): Error => {
  const error = new Error("Internal server error");
  internalErrors.add(error);
  return error;
};

/**
 * Keep what of a cause a client may see: interrupts, and the failures
 * `declared` keeps. Anything else (a defect, an undeclared failure) is
 * logged here with its whole cause, and becomes {@link internalError}.
 *
 * @internal
 */
export const redactCause =
  (declared: (error: unknown) => boolean, rpc: string) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<never, E> =>
    cause.reasons.every(
      (reason) =>
        Cause.isInterruptReason(reason) ||
        (Cause.isFailReason(reason) && declared(reason.error)) ||
        (Cause.isDieReason(reason) &&
          typeof reason.defect === "object" &&
          reason.defect !== null &&
          internalErrors.has(reason.defect)),
    )
      ? Effect.failCause(cause)
      : Effect.logError("Domain: a request failed with an undeclared error", cause).pipe(
          Effect.annotateLogs({ "domain.rpc": rpc }),
          Effect.andThen(Effect.die(internalError())),
        );

/**
 * The schema of a command's or a query's `input`. With no fields it is an
 * empty record, not `Schema.Struct({})`: an empty Struct accepts any value
 * but `null`, and its JSON Schema has no `type`, so an agent calling the tool
 * may send the string `"{}"`. The empty record is a JSON object with no
 * properties. The declared type stays `Schema.Struct<F>`.
 *
 * @internal
 */
export const inputSchema = <F extends Schema.Struct.Fields>(fields: F | undefined) =>
  (fields === undefined || Object.keys(fields).length === 0
    ? Schema.Record(Schema.String, Schema.Never)
    : Schema.Struct(fields)) as unknown as Schema.Struct<F>;

const tags = new WeakMap<object, string>();

/**
 * The `_tag` a rejection class declares: the literal its schema gives
 * `_tag`, so any tagged error class can be a rejection.
 *
 * @internal
 */
export const rejectionTag = (rejection: Schema.Top): string => {
  const cached = tags.get(rejection);
  if (cached !== undefined) return cached;
  const encoded = SchemaAST.toEncoded(rejection.ast);
  const tag = SchemaAST.isObjects(encoded)
    ? encoded.propertySignatures.find((property) => property.name === "_tag")?.type
    : undefined;
  const value = tag && SchemaAST.isLiteral(tag) ? String(tag.literal) : "";
  tags.set(rejection, value);
  return value;
};

/** `name` as it reads in a path. */
const member = (path: string, name: PropertyKey) =>
  typeof name === "string" && /^[A-Za-z_$][\w$]*$/.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(String(name))}]`;

/**
 * Where a schema has no JSON form: the paths under `path` of each declaration
 * (such as `Schema.instanceOf`) with no `toCodecJson` annotation. Its values
 * can't be stored or sent: they fail when they are encoded, in production.
 * `Schema.Unknown` and `Schema.Any` pass, because a value decides those.
 *
 * @internal
 */
export const pathsWithoutJson = (
  ast: SchemaAST.AST,
  path: string,
  seen: Set<SchemaAST.AST> = new Set(),
): ReadonlyArray<string> => {
  const encoding = ast.encoding?.at(-1)?.to;
  if (encoding) return pathsWithoutJson(encoding, path, seen);
  const within = (child: SchemaAST.AST, at = path) => pathsWithoutJson(child, at, seen);
  switch (ast._tag) {
    case "Declaration": {
      const { toCodecJson, toCodec } = ast.annotations ?? {};
      return toCodecJson || toCodec ? ast.typeParameters.flatMap((tp) => within(tp)) : [path];
    }
    case "Objects":
      return [
        ...ast.propertySignatures.flatMap((p) => within(p.type, member(path, p.name))),
        ...ast.indexSignatures.flatMap((signature) => within(signature.type, `${path}[key]`)),
      ];
    case "Arrays":
      return [
        ...ast.elements.flatMap((element, index) => within(element, `${path}[${index}]`)),
        ...ast.rest.flatMap((element) => within(element, `${path}[]`)),
      ];
    case "Union":
      return ast.types.flatMap((type) => within(type));
    case "Suspend": {
      // A recursive schema: one pass over it finds what is there.
      if (seen.has(ast)) return [];
      seen.add(ast);
      return within(ast.thunk());
    }
    default:
      return [];
  }
};

/**
 * An effectful decision, run at the time its command is handled at. The clock
 * reads that time for as long as `decide` runs, so `Clock.currentTimeMillis`
 * and `DateTime.now` give what `decide` is given as `now`: a decision is the
 * same however late it runs, and the prover reads the clock as that input.
 *
 * @internal
 */
export const decidedAt = <A, E, R>(
  decision: Effect.Effect<A, E, R>,
  now: DateTime.Utc,
): Effect.Effect<A, E, R> =>
  Clock.clockWith((clock) => {
    const millis = DateTime.toEpochMillis(now);
    const nanos = BigInt(millis) * 1_000_000n;
    return Effect.provideService(decision, Clock.Clock, {
      currentTimeMillisUnsafe: () => millis,
      currentTimeMillis: Effect.succeed(millis),
      currentTimeNanosUnsafe: () => nanos,
      currentTimeNanos: Effect.succeed(nanos),
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: (duration) => clock.sleep(duration),
    });
  });

/** What `decide` returned, once its Effect (if any) ran. @internal */
export type Settled =
  | { readonly _tag: "Decided"; readonly decision: unknown }
  | { readonly _tag: "Failed"; readonly cause: Cause.Cause<unknown> };

/**
 * Settle an effectful decision. A rejection is a `YieldableError`, so it is
 * an Effect too: running it fails with the rejection itself, which is the
 * decision. Any other failure, such as a defect, stays a failure.
 *
 * @internal
 */
export const settle = (exit: Exit.Exit<unknown, unknown>): Settled => {
  if (Exit.isSuccess(exit)) return { _tag: "Decided", decision: exit.value };
  const rejection = Cause.findErrorOption(exit.cause);
  return Option.isSome(rejection)
    ? { _tag: "Decided", decision: rejection.value }
    : { _tag: "Failed", cause: exit.cause };
};

/** A decision, judged against the command's declaration. @internal */
export type Judged =
  | { readonly _tag: "Accepted"; readonly events: ReadonlyArray<{ readonly _tag: string }> }
  | { readonly _tag: "Rejected"; readonly rejection: { readonly _tag: string } }
  | { readonly _tag: "Undeclared"; readonly error: DefinitionError };

/**
 * Judge a settled decision: the events to commit, the rejection, or the
 * {@link DefinitionError} for an event or rejection the command does not
 * declare.
 *
 * @internal
 */
export const judge = (
  aggregateName: string,
  command: {
    readonly tag: string;
    readonly events: ReadonlyArray<{ readonly tag: string }>;
    readonly rejects: ReadonlyArray<Schema.Top>;
  },
  decision: unknown,
): Judged => {
  if (!Array.isArray(decision)) {
    const rejection = decision as { readonly _tag: string };
    if (!command.rejects.some((r) => rejectionTag(r) === rejection?._tag)) {
      return {
        _tag: "Undeclared",
        error: new DefinitionError({
          reason: new UndeclaredDecision({
            aggregate: aggregateName,
            command: command.tag,
            returned: String(rejection?._tag),
            list: "rejects",
          }),
        }),
      };
    }
    return { _tag: "Rejected", rejection };
  }
  for (const event of decision as ReadonlyArray<{ readonly _tag: string }>) {
    if (!command.events.some((e) => e.tag === event._tag)) {
      return {
        _tag: "Undeclared",
        error: new DefinitionError({
          reason: new UndeclaredDecision({
            aggregate: aggregateName,
            command: command.tag,
            returned: event._tag,
            list: "events",
          }),
        }),
      };
    }
  }
  return { _tag: "Accepted", events: decision };
};

type AnyHandler = (...args: ReadonlyArray<unknown>) => unknown;
type HandlerMap = { readonly [key: string]: AnyHandler | Record<string, AnyHandler | undefined> };

/** The id a ref or a Schema key value addresses. @internal */
export const targetId = (target: unknown): string =>
  typeof target === "object" && target !== null && "id" in target
    ? String((target as { readonly id: unknown }).id)
    : String(target);

/** One input for a view's evolve. @internal */
export interface LocalViewInput {
  readonly name: string;
  readonly event: { readonly _tag: string };
  /** A ref for an aggregate source, the key value for a Schema-keyed view. */
  readonly source: unknown;
  readonly state?: unknown;
  readonly envelope: { readonly at: unknown };
  readonly key?: unknown;
}

/**
 * Apply one input to one key of a view, with the view's own `keyOf` and
 * `evolve`, as the kernel applies a delivery: each route whose `keyOf`
 * reaches the key runs its handler. An input that reaches no route of the
 * key leaves the state as it is.
 *
 * @internal
 */
export const evolveView = (
  view: {
    readonly definition: {
      readonly state?: unknown;
      readonly initial?: unknown;
      readonly keyOf?: unknown;
      readonly evolve?: unknown;
    };
  },
  state: unknown,
  input: LocalViewInput,
): unknown => {
  const def = view.definition;
  if (def.state === undefined) return null;
  const tag = input.event._tag;
  const keyOf = def.keyOf as HandlerMap | undefined;
  const evolve = def.evolve as HandlerMap | undefined;
  const routing = {
    event: input.event,
    source: input.source,
    state: input.state,
    envelope: input.envelope,
  };
  const custom = keyOf?.[tag] ?? keyOf?.[input.name];
  let key: unknown;
  let routes: ReadonlyArray<string | undefined>;
  // A route returns a ref for an aggregate key, or the value of a Schema key.
  const reaches = (reached: unknown) =>
    reached !== undefined && key !== undefined && targetId(reached) === targetId(key);
  if (typeof custom === "function") {
    const reached = custom(routing);
    key = input.key ?? reached;
    routes = reaches(reached) ? [undefined] : [];
  } else if (custom) {
    key = input.key;
    routes = Object.entries(custom).flatMap(([route, fn]) =>
      reaches(fn?.(routing)) ? [route] : [],
    );
  } else {
    key = input.key ?? input.source;
    routes = reaches(input.source) ? [undefined] : [];
  }
  let current = state;
  for (const route of routes) {
    const handler = evolve?.[tag] ?? evolve?.[input.name];
    const fn =
      typeof handler === "function" ? handler : route !== undefined ? handler?.[route] : undefined;
    if (!fn) continue;
    current =
      fn(current ?? def.initial, input.event, {
        key,
        source: input.source,
        state: input.state,
        envelope: input.envelope,
        at: input.envelope.at,
      }) ?? null;
  }
  return current;
};

/**
 * Call a command's client with a decoded wire payload.
 *
 * @internal
 */
export const sendPayload = (
  send: unknown,
  payload: unknown,
  options: object,
): Effect.Effect<unknown, unknown> => {
  const { input, commandId, consistency } = payload as {
    readonly input: unknown;
    readonly commandId?: string;
    readonly consistency?: string;
  };
  const call = send as (input: unknown, options: object) => Effect.Effect<unknown, unknown>;
  return call(input, {
    ...options,
    ...(commandId === undefined ? {} : { commandId }),
    ...(consistency === undefined ? {} : { consistency }),
  });
};

/** A handler waits for something that never comes: a promise, a timer of its own, a fiber that never ends. */
export class NeverSettles extends Data.TaggedError("NeverSettles")<{}> {
  override get message() {
    return "the handler waits for something outside it, which a prediction does not run";
  }
}

/** How an {@link Instant} counts time: in milliseconds, or in what the prover holds for them. */
export interface Timekeeping<T> {
  readonly zero: T;
  readonly of: (millis: number) => T;
  readonly add: (time: T, span: T) => T;
  /** Which comes first: `-1` the first, `1` the second, `0` when they are the same moment. */
  readonly order: (a: T, b: T) => -1 | 0 | 1;
  /** Whether a span is longer than nothing: a sleep of none ends at once. */
  readonly positive: (span: T) => boolean;
}

const MILLIS: Timekeeping<number> = {
  zero: 0,
  of: (millis) => millis,
  add: (time, span) => time + span,
  order: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  positive: (span) => span > 0,
};

/**
 * Time that passes only when nothing can run. A handler run on it does what
 * the deployed one does, without waiting: a sleep, a delay, a schedule and a
 * time limit end in the order their durations give, and code between them
 * takes no time. `Aggregate.predict` runs a handler on it, and the prover
 * reads one on it.
 *
 * @internal
 */
export class Instant<T = number> {
  /** The time gone by since the run began. */
  elapsed: T;
  /** Work that is under way outside the run: time stands still while there is any. */
  busy = 0;
  /** Whether two waits ended at the same time: which the deployed handler ends first is not known. */
  tied = false;
  /** Called when nothing can run and nothing waits for a time. */
  onIdle: (() => void) | undefined;
  private order = 0;
  private readonly sleepers: Array<{
    readonly at: T;
    readonly order: number;
    readonly wake: () => void;
  }> = [];
  private tasks: Array<[priority: number, tasks: Array<() => void>]> = [];
  private urgent: Array<() => void> = [];
  private pumping = false;
  private scheduled = false;
  private readonly time: Timekeeping<T>;
  private readonly defer: ((pump: () => void) => void) | undefined;

  /** With `defer`, the run goes on by itself: work scheduled outside a pump is pumped later. */
  constructor(time: Timekeeping<T>, defer?: (pump: () => void) => void) {
    this.time = time;
    this.elapsed = time.zero;
    this.defer = defer;
  }

  static readonly millis = (): Instant<number> => new Instant(MILLIS);

  readonly scheduler: Scheduler.Scheduler = {
    executionMode: "sync",
    // Code takes no time, so no fiber is made to give way to another.
    shouldYield: () => false,
    makeDispatcher: () => ({
      scheduleTask: (task, priority) => this.schedule(task, priority),
      flush: () => this.pump(),
    }),
  };

  /** Wait for a span of time: it ends when no fiber can run and no other wait ends sooner. */
  readonly sleep = (span: T): Effect.Effect<void> =>
    Effect.callback<void>((resume) => {
      if (!this.time.positive(span)) return resume(Effect.void);
      const sleeper = {
        at: this.time.add(this.elapsed, span),
        order: this.order++,
        wake: () => resume(Effect.void),
      };
      this.sleepers.push(sleeper);
      this.kick();
      return Effect.sync(() => {
        const index = this.sleepers.indexOf(sleeper);
        if (index >= 0) this.sleepers.splice(index, 1);
      });
    });

  /** The clock of a run: what it reads is `clock`'s, and a sleep ends when time gets to it. */
  readonly clock = (clock: Clock.Clock): Clock.Clock => ({
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    currentTimeNanos: clock.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) => this.sleep(this.time.of(Duration.toMillis(duration))),
  });

  private schedule(task: () => void, priority: number): void {
    // While work is under way outside the run, only the fiber that waits for it is scheduled.
    if (this.busy > 0) this.urgent.push(task);
    else this.queue(priority, [task], false);
    this.kick();
  }

  /**
   * See that what can run is run. A fiber that goes on after work outside
   * the run does so on its own, not in a pump: what it then waits for is
   * found by the pump this asks for.
   */
  kick(): void {
    if (this.defer && !this.pumping && !this.scheduled) {
      this.scheduled = true;
      this.defer(() => {
        this.scheduled = false;
        this.pump();
      });
    }
  }

  private queue(priority: number, tasks: ReadonlyArray<() => void>, first: boolean): void {
    const bucket = this.tasks.find(([at]) => at === priority);
    if (bucket) bucket[1][first ? "unshift" : "push"](...tasks);
    else {
      this.tasks.push([priority, [...tasks]]);
      this.tasks.sort(([a], [b]) => a - b);
    }
  }

  /** Run what can run, and let time pass to the next wait that ends, until nothing is left. */
  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.urgent.length > 0) {
          const urgent = this.urgent;
          this.urgent = [];
          for (const task of urgent) task();
          continue;
        }
        if (this.busy > 0) return;
        if (this.tasks.length > 0) {
          const buckets = this.tasks;
          this.tasks = [];
          let held = false;
          for (const [priority, tasks] of buckets) {
            let ran = 0;
            // Work begun outside the run stops the rest, which is put back in its place.
            while (!held && ran < tasks.length) {
              tasks[ran++]!();
              held = this.busy > 0;
            }
            if (ran < tasks.length) this.queue(priority, tasks.slice(ran), true);
          }
          continue;
        }
        if (this.sleepers.length === 0) break;
        let next = this.sleepers[0]!;
        for (const sleeper of this.sleepers.slice(1)) {
          const order = this.time.order(sleeper.at, next.at);
          // Two waits that never end do not end at the same moment: they do not end.
          if (order === 0 && next.at !== Infinity) this.tied = true;
          if (order < 0) next = sleeper;
        }
        this.sleepers.splice(this.sleepers.indexOf(next), 1);
        this.elapsed = next.at;
        next.wake();
      }
    } finally {
      this.pumping = false;
    }
    this.onIdle?.();
  }
}

/**
 * Run an effect to its end at once, on time that passes only when nothing
 * can run. `undefined` when it waits for something that never comes.
 *
 * @internal
 */
export const runInstantly = <A, E>(effect: Effect.Effect<A, E>): Exit.Exit<A, E> | undefined => {
  const instant = Instant.millis();
  let exit: Exit.Exit<A, E> | undefined;
  const fiber = Effect.runFork(
    Clock.clockWith((clock) => Effect.provideService(effect, Clock.Clock, instant.clock(clock))),
    { scheduler: instant.scheduler },
  );
  fiber.addObserver((done) => {
    exit = done;
  });
  instant.pump();
  const settled = exit;
  if (settled === undefined) fiber.interruptUnsafe();
  return settled;
};
