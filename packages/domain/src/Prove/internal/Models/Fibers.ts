import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Chunk from "effect/Chunk";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import * as Pool from "effect/Pool";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as RcMap from "effect/RcMap";
import * as RcRef from "effect/RcRef";
import * as Request from "effect/Request";
import * as RequestResolver from "effect/RequestResolver";
import * as Resource from "effect/Resource";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as ScopedCache from "effect/ScopedCache";
import * as ScopedRef from "effect/ScopedRef";
import * as Semaphore from "effect/Semaphore";
import * as TxChunk from "effect/TxChunk";
import * as TxDeferred from "effect/TxDeferred";
import * as TxPubSub from "effect/TxPubSub";
import * as TxQueue from "effect/TxQueue";
import * as TxReentrantLock from "effect/TxReentrantLock";
import * as TxRef from "effect/TxRef";
import * as TxSemaphore from "effect/TxSemaphore";
import * as TxSubscriptionRef from "effect/TxSubscriptionRef";
import * as Brands from "../Brands.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import {
  arr,
  callable,
  dual,
  dualBy,
  lazy,
  native,
  onEffect as onEffectPlain,
  tagOf,
  wrongArguments,
} from "../Kit.ts";
import * as Timeline from "../Timeline.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";
import { CHANGES } from "./Cells.ts";

const REF: Value.Brand = { kind: "Ref", cls: undefined };
/** The field that says which of these a value is, and the one that holds the library's own. */
const IS = "~is";
const HELD = "~held";

type Kind =
  | "Deferred"
  | "Queue"
  | "Latch"
  | "Semaphore"
  | "Fiber"
  | "Schedule"
  | "PubSub"
  | "Subscription"
  | "FiberSet"
  | "FiberHandle"
  | "TxRef"
  | "TxQueue"
  | "Pool"
  | "FiberMap"
  | "Cache"
  | "ScopedCache"
  | "TxDeferred"
  | "TxSemaphore"
  | "TxPubSub"
  | "TxSubscriptionRef"
  | "TxReentrantLock"
  | "PartitionedSemaphore"
  | "TxChunk"
  | "Request"
  | "Entry"
  | "Resolver"
  | "TxHashMap"
  | "TxHashSet"
  | "TxPriorityQueue"
  | "Channel"
  | "Scope"
  | "ScopedRef"
  | "RcRef"
  | "RcMap"
  | "Resource";

/** How often effects may be run again in one handler before the prover stops reading. */
const MAX_TURNS = 100;

/** Options that are not numbers and text the code writes. */
const NOT_PLAIN = Symbol("not plain");

/** What the library keeps while it runs effects of the code: a value, or the failure the code can handle. */
type Held = Value.Rejected;

const success = (value: V): V => Value.obj({ _tag: Value.str("Success"), value });
const reason = (tag: string, fields: Record<string, V>): V =>
  Value.obj({ _tag: Value.str(tag), ...fields });
const failure = (reasons: ReadonlyArray<V>): V =>
  Value.obj({ _tag: Value.str("Failure"), cause: Value.obj({ reasons: arr(reasons) }) });

/**
 * Time and fibers: `Effect.sleep`, `timeout`, `race`, `forkChild`, effects
 * run together, `Fiber`, `Deferred`, `Queue`, `Latch`, `Semaphore` and
 * `Schedule`. None of them is rewritten here. Each is the library's own,
 * given the code's effects to run on the handler's timeline: what it does to
 * them is what the deployed handler does, by being the same code.
 */
export const make = (
  kit: Kit,
  base: Models,
  /** Say that a value is a class, and what a class that extends it is. */
  asClass: (made: V, extended: (name: string) => V) => V,
) => {
  const { host, ran } = kit;

  // ---- What the library holds, as values of the code, and back.

  const wrap = (kind: Kind, held: unknown): V =>
    Value.obj({ [IS]: Value.str(kind), [HELD]: { _tag: "Host", value: held, name: kind } }, REF);

  const heldOf = <A>(kind: Kind, v: V | undefined): A | undefined => {
    if (v?._tag !== "Obj" || v.brand?.kind !== "Ref") return undefined;
    const is = v.fields[IS];
    const held = v.fields[HELD];
    return is?._tag === "Str" && is.value === kind && held?._tag === "Host"
      ? (held.value as A)
      : undefined;
  };

  const kindOf = (v: V | undefined): string | undefined => {
    const is = v?._tag === "Obj" && v.brand?.kind === "Ref" ? v.fields[IS] : undefined;
    return is?._tag === "Str" ? is.value : undefined;
  };

  const whole = (v: V | undefined): number | undefined =>
    v?._tag === "Num" && Number.isInteger(v.value) && v.value >= 0 ? v.value : undefined;

  const unseen = (site: Site, what: string): Eval<never> =>
    Effect.fail(Value.notTranslated(site, what));

  /** A span of time the code gives: a `Duration`, a number of milliseconds, or text such as `"1 second"`. */
  const span = (name: string, v: V | undefined, site: Site): Eval<Timeline.Time> => {
    const millis = v?._tag === "Obj" ? Brands.durationOf(v) : v;
    if (millis?._tag === "Num") return Effect.succeed(millis.value);
    if (millis?._tag === "Term" && millis.term.sort === "Int")
      return Effect.succeed(millis.term.text);
    if (millis?._tag === "Str") {
      const read = Duration.fromInput(millis.value as Duration.Input);
      if (read._tag === "Some") return read.value.pipe(Duration.toMillis, Effect.succeed);
    }
    return unseen(site, `calls ${name} with a duration the prover cannot see`);
  };

  /** A span of time the library is given: one the code writes. */
  const written = (name: string, v: V | undefined, site: Site): Eval<Duration.Duration> =>
    Effect.flatMap(span(name, v, site), (time) =>
      typeof time === "number"
        ? Effect.succeed(Duration.millis(time))
        : unseen(site, `calls ${name} with a duration an input decides`),
    );

  const durationOf = (duration: Duration.Duration): V =>
    Brands.duration(duration.pipe(Duration.toMillis, Value.num));

  /** How an effect ended, as the code holds an `Exit`. */
  const exitOf = (timeline: Timeline.Timeline, exit: Exit.Exit<unknown, unknown>): Eval<V> => {
    if (Exit.isSuccess(exit))
      return Effect.succeed(success(isValue(exit.value) ? exit.value : Value.undef));
    const stop = Timeline.stopOf(timeline, exit.cause);
    if (stop && stop._tag !== "Rejected") return Effect.fail(stop);
    return Effect.succeed(
      failure([
        ...(stop
          ? [
              stop.defect === true
                ? reason("Die", { defect: stop.rejection })
                : reason("Fail", { error: stop.rejection }),
            ]
          : []),
        ...(Cause.hasInterrupts(exit.cause) ? [reason("Interrupt", {})] : []),
      ]),
    );
  };

  /** What a schedule gives each time it goes on: a count, a duration, or one of each. */
  const outputOf = (output: unknown): V =>
    typeof output === "number"
      ? Value.num(output)
      : Duration.isDuration(output)
        ? durationOf(output)
        : Array.isArray(output)
          ? arr(output.map(outputOf))
          : isValue(output)
            ? output
            : Value.undef;

  const isValue = (value: unknown): value is V =>
    typeof value === "object" && value !== null && "_tag" in value && !Effect.isEffect(value);

  // ---- An effect of the code that the library runs.

  /**
   * A model that needs a timeline: an effect, run when the code runs it. A
   * handler has one. Code read outside one, such as a policy's, is given one
   * for as long as the effect runs.
   */
  const timed = (name: string, body: (timeline: Timeline.Timeline) => Eval<V>, site: Site): V => {
    void name;
    const inside = Effect.flatMap(Effect.service(Timeline.Current), (timeline) =>
      timeline
        ? body(timeline)
        : Effect.die("a timeline is provided to every effect that is run on one"),
    );
    return lazy(() =>
      Effect.flatMap(Effect.service(Timeline.Current), (timeline) =>
        timeline ? body(timeline) : Timeline.run(() => host.current.run, site, inside),
      ),
    );
  };

  /** A function of an effect, with the effect first or given it by `pipe`. */
  const onEffect = (
    name: string,
    extra: number,
    body: (
      timeline: Timeline.Timeline,
      self: Effect.Effect<V, Held>,
      rest: ReadonlyArray<V>,
      site: Site,
    ) => Eval<V>,
  ): Model => {
    const made = (self: V & { readonly _tag: "Effect" }, rest: ReadonlyArray<V>, site: Site): V =>
      timed(
        name,
        (timeline) => body(timeline, Timeline.real(timeline, self.run), rest, site),
        site,
      );
    return (args, site) => {
      const [first, ...rest] = args;
      if (args.length === extra + 1 && first?._tag === "Effect")
        return Effect.succeed(made(first, rest, site));
      if (args.length === extra)
        return Effect.succeed(
          native(name, ([self], at) =>
            self?._tag === "Effect"
              ? Effect.succeed(made(self, args, at))
              : wrongArguments(at, name),
          ),
        );
      return wrongArguments(site, name);
    };
  };

  /** A finalizer, as the library takes one: it cannot fail, so a failure of it is a defect. */
  const sure = <A>(self: Effect.Effect<A, Held>): Effect.Effect<A> =>
    Effect.catch(self, (failed) => Effect.die(new Timeline.Defect(failed.rejection)));

  /** What a function of the code gives when the library calls it for an effect. */
  const called =
    (timeline: Timeline.Timeline, fn: V, site: Site) =>
    (...args: ReadonlyArray<V>): Effect.Effect<V, Held> =>
      Timeline.real(timeline, ran(fn, args, site));

  /** An effect, or a function that gives one, as the library is given either. */
  const effectOf = (
    timeline: Timeline.Timeline,
    v: V | undefined,
    site: Site,
  ): Effect.Effect<V, Held> | undefined =>
    v?._tag === "Effect"
      ? Timeline.real(timeline, v.run)
      : v && callable(v)
        ? Effect.suspend(() => called(timeline, v, site)())
        : undefined;

  const effects = (
    name: string,
    timeline: Timeline.Timeline,
    given: V | undefined,
    site: Site,
  ): Eval<ReadonlyArray<Effect.Effect<V, Held>>> =>
    Effect.flatMap(given ? kit.iterate(given, site) : Effect.succeed(undefined), (items) =>
      items && items.every((item) => item._tag === "Effect")
        ? Effect.succeed(
            items.map((item) => Timeline.real(timeline, (item as { run: Eval<V> }).run)),
          )
        : wrongArguments(site, name),
    );

  /** How many effects run together, as the code wrote it: `undefined` for one after another. */
  const together = (
    name: string,
    options: V | undefined,
    site: Site,
  ): Eval<number | "unbounded" | undefined> => {
    const fields = options?._tag === "Obj" && !options.brand ? options.fields : {};
    const concurrency = fields.concurrency;
    if (fields.concurrent?._tag === "Bool" && fields.concurrent.value)
      return Effect.succeed("unbounded");
    if (concurrency === undefined || concurrency._tag === "Undef") return Effect.succeed(undefined);
    if (concurrency._tag === "Str" && concurrency.value === "unbounded")
      return Effect.succeed("unbounded");
    const count = whole(concurrency);
    if (count === undefined || count === 0)
      return unseen(site, `calls ${name} with a concurrency the prover cannot see`);
    return Effect.succeed(count === 1 ? undefined : count);
  };

  const flag = (options: V | undefined, key: string): boolean => {
    const value = options?._tag === "Obj" ? options.fields[key] : undefined;
    return value?._tag === "Bool" && value.value;
  };

  // ---- Schedules.

  const scheduleOf = (v: V | undefined): Schedule.Schedule<unknown, unknown> | undefined =>
    heldOf("Schedule", v);

  /** A schedule made from numbers and durations the code writes. */
  const schedule =
    (
      name: string,
      made: (args: ReadonlyArray<V>, site: Site) => Eval<Schedule.Schedule<unknown, unknown>>,
    ): Model =>
    (args, site) =>
      Effect.map(made(args, site), (held) => wrap("Schedule", held));

  const count = (name: string, v: V | undefined, site: Site): Eval<number> =>
    Effect.flatMap(kit.picked(v), (n) =>
      n === undefined
        ? unseen(site, `calls ${name} without a count the prover can see`)
        : Effect.succeed(n),
    );

  /** A schedule changed by another function of the module, given first or by `pipe`. */
  const onSchedule = (
    name: string,
    arity: number,
    made: (
      self: Schedule.Schedule<unknown, unknown>,
      rest: ReadonlyArray<V>,
      site: Site,
    ) => Eval<Schedule.Schedule<unknown, unknown>>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) => {
      const held = scheduleOf(self);
      return held
        ? Effect.map(made(held, rest, site), (next) => wrap("Schedule", next))
        : wrongArguments(site, name);
    });

  /**
   * How an effect is run again, as the library takes it: a schedule, or a
   * count of times, a test of what the last run gave, and a schedule.
   */
  const again = (
    name: string,
    timeline: Timeline.Timeline,
    options: V | undefined,
    last: (given: unknown) => V,
    site: Site,
  ): Eval<Schedule.Schedule<unknown, unknown> | Record<string, unknown>> => {
    const alone = scheduleOf(options);
    if (alone) return Effect.succeed(alone);
    const fields = options?._tag === "Obj" && !options.brand ? options.fields : undefined;
    if (
      !fields ||
      !Object.keys(fields).every((key) => ["times", "while", "until", "schedule"].includes(key))
    )
      return wrongArguments(site, name);
    const out: Record<string, unknown> = {};
    if (fields.schedule !== undefined && fields.schedule._tag !== "Undef") {
      const held = scheduleOf(fields.schedule);
      if (!held) return wrongArguments(site, name);
      out.schedule = held;
    }
    for (const key of ["while", "until"] as const) {
      const test = fields[key];
      if (test === undefined || test._tag === "Undef") continue;
      out[key] = (given: unknown) =>
        Timeline.real(timeline, Effect.map(kit.holds(test, [last(given)], site), Value.bool)).pipe(
          Effect.map((held) => held._tag === "Bool" && held.value),
        );
    }
    if (fields.times === undefined || fields.times._tag === "Undef") return Effect.succeed(out);
    // A count of times an input decides is each count it can be, a path at a time.
    return Effect.flatMap(kit.picked(fields.times), (times) =>
      times === undefined
        ? unseen(site, `calls ${name} without a count of times the prover can see`)
        : Effect.succeed({ ...out, times }),
    );
  };

  /** One more run of an effect that is run again: a handler that never stops running it is not read. */
  const turn = (
    name: string,
    timeline: Timeline.Timeline,
    self: Effect.Effect<V, Held>,
    site: Site,
  ): Effect.Effect<V, Held> =>
    Effect.suspend(() =>
      ++timeline.turns > MAX_TURNS
        ? Timeline.real(
            timeline,
            unseen(site, `runs an effect again more than ${MAX_TURNS} times, with ${name}`),
          )
        : self,
    );

  // ---- Deferred, Queue, Latch and Semaphore: the library's own, holding values of the code.

  /** A function of one of these that gives an effect, where something is worked out before the library's is made. */
  const later = <H, A>(
    kind: Kind,
    name: string,
    arity: number,
    body: (
      held: H,
      rest: ReadonlyArray<V>,
      site: Site,
      timeline: Timeline.Timeline,
    ) => Eval<Effect.Effect<A, unknown>>,
    give: (value: A, timeline: Timeline.Timeline) => V,
    wait?: string,
  ): Model =>
    dual(`${kind}.${name}`, arity, ([self, ...rest], site) => {
      const held = heldOf<H>(kind, self);
      if (held === undefined) return wrongArguments(site, `${kind}.${name}`);
      return Effect.succeed(
        timed(
          `${kind}.${name}`,
          (timeline) =>
            Effect.flatMap(body(held, rest, site, timeline), (effect) =>
              Timeline.back(
                timeline,
                wait ? Timeline.waiting(timeline, wait, site, effect) : effect,
                (value) => give(value, timeline),
              ),
            ),
          site,
        ),
      );
    });

  /** A function of one of these that gives an effect: `body` gives the library's, to be run. */
  const on = <H, A>(
    kind: Kind,
    name: string,
    arity: number,
    body: (held: H, rest: ReadonlyArray<V>) => Effect.Effect<A, unknown>,
    give: (value: A, timeline: Timeline.Timeline) => V,
    wait?: string,
  ): Model =>
    later<H, A>(kind, name, arity, (held, rest) => Effect.succeed(body(held, rest)), give, wait);

  /** A function of one of these that gives a value at once. */
  const now = <H, A>(
    kind: Kind,
    name: string,
    arity: number,
    body: (held: H, rest: ReadonlyArray<V>) => A,
    give: (value: A) => V,
  ): Model =>
    dual(`${kind}.${name}`, arity, ([self, ...rest], site) => {
      const held = heldOf<H>(kind, self);
      return held === undefined
        ? wrongArguments(site, `${kind}.${name}`)
        : Effect.sync(() => give(body(held, rest)));
    });

  const bool = (value: boolean): V => Value.bool(value);
  const num = (value: number): V => Value.num(value);
  const none = (): V => Value.undef;
  const same = (value: V): V => value;
  const list = (values: ReadonlyArray<V>): V => arr(values);
  const option = (value: Option.Option<V>): V =>
    Option.isSome(value) ? Value.some(value.value) : Value.none;

  const made =
    (kind: Kind, build: (args: ReadonlyArray<V>, site: Site) => Eval<unknown>): Model =>
    (args, site) =>
      Effect.succeed(lazy(() => Effect.map(build(args, site), (held) => wrap(kind, held))));
  const madeNow =
    (kind: Kind, build: (args: ReadonlyArray<V>, site: Site) => Eval<unknown>): Model =>
    (args, site) =>
      Effect.map(build(args, site), (held) => wrap(kind, held));

  type D = Deferred.Deferred<V, Held>;
  type Q = Queue.Queue<V, Held>;

  const thunk = (name: string, rest: ReadonlyArray<V>, site: Site): Eval<V> =>
    rest[0] ? host.call(rest[0], [], site) : wrongArguments(site, name);

  const deferreds: Models = {
    "effect/Deferred:make": made("Deferred", () => Deferred.make<V, Held>()),
    "effect/Deferred:makeUnsafe": madeNow("Deferred", () =>
      Effect.sync(() => Deferred.makeUnsafe<V, Held>()),
    ),
    "effect/Deferred:succeed": on<D, boolean>(
      "Deferred",
      "succeed",
      2,
      (held, [value]) => Deferred.succeed(held, value ?? Value.undef),
      bool,
    ),
    "effect/Deferred:sync": later<D, boolean>(
      "Deferred",
      "sync",
      2,
      (held, rest, site) =>
        Effect.map(thunk("Deferred.sync", rest, site), (value) => Deferred.succeed(held, value)),
      bool,
    ),
    "effect/Deferred:fail": on<D, boolean>(
      "Deferred",
      "fail",
      2,
      (held, [error]) =>
        Deferred.fail(held, new Value.Rejected({ rejection: error ?? Value.undef })),
      bool,
    ),
    "effect/Deferred:failSync": later<D, boolean>(
      "Deferred",
      "failSync",
      2,
      (held, rest, site) =>
        Effect.map(thunk("Deferred.failSync", rest, site), (error) =>
          Deferred.fail(held, new Value.Rejected({ rejection: error })),
        ),
      bool,
    ),
    "effect/Deferred:die": on<D, boolean>(
      "Deferred",
      "die",
      2,
      (held, [defect]) => Deferred.die(held, new Timeline.Defect(defect ?? Value.undef)),
      bool,
    ),
    "effect/Deferred:dieSync": later<D, boolean>(
      "Deferred",
      "dieSync",
      2,
      (held, rest, site) =>
        Effect.map(thunk("Deferred.dieSync", rest, site), (defect) =>
          Deferred.die(held, new Timeline.Defect(defect)),
        ),
      bool,
    ),
    "effect/Deferred:completeWith": later<D, boolean>(
      "Deferred",
      "completeWith",
      2,
      (held, [effect], site, timeline) => {
        const given = effectOf(timeline, effect, site);
        return given
          ? Effect.succeed(Deferred.completeWith(held, given))
          : wrongArguments(site, "Deferred.completeWith");
      },
      bool,
    ),
    "effect/Deferred:interrupt": on<D, boolean>(
      "Deferred",
      "interrupt",
      1,
      (held) => Deferred.interrupt(held),
      bool,
    ),
    "effect/Deferred:await": on<D, V>(
      "Deferred",
      "await",
      1,
      (held) => Deferred.await(held),
      same,
      "waits for a Deferred that nothing completes",
    ),
    "effect/Deferred:isDone": on<D, boolean>(
      "Deferred",
      "isDone",
      1,
      (held) => Deferred.isDone(held),
      bool,
    ),
    "effect/Deferred:isDoneUnsafe": now<D, boolean>(
      "Deferred",
      "isDoneUnsafe",
      1,
      Deferred.isDoneUnsafe,
      bool,
    ),
    "effect/Deferred:poll": on<D, Option.Option<Effect.Effect<V, Held>>>(
      "Deferred",
      "poll",
      1,
      (held) => Deferred.poll(held),
      (found, timeline) =>
        Option.isSome(found)
          ? Value.some(lazy(() => Timeline.back(timeline, found.value, same)))
          : Value.none,
    ),
  };

  const capacity = (name: string, v: V | undefined, site: Site): Eval<number> => {
    const n = whole(v);
    return n === undefined
      ? unseen(site, `makes a Queue of a size the prover cannot see`)
      : Effect.succeed(n);
  };

  const items = (name: string, v: V | undefined, site: Site): Eval<ReadonlyArray<V>> =>
    Effect.flatMap(v ? kit.iterate(v, site) : Effect.succeed(undefined), (found) =>
      found ? Effect.succeed(found) : wrongArguments(site, name),
    );

  const EMPTY = "takes from a Queue that nothing offers to";
  const FULL = "offers to a full Queue that nothing takes from";

  const queues: Models = {
    "effect/Queue:unbounded": made("Queue", () => Queue.unbounded<V, Held>()),
    "effect/Queue:bounded": made("Queue", ([size], site) =>
      Effect.flatMap(capacity("Queue.bounded", size, site), (n) => Queue.bounded<V, Held>(n)),
    ),
    "effect/Queue:sliding": made("Queue", ([size], site) =>
      Effect.flatMap(capacity("Queue.sliding", size, site), (n) => Queue.sliding<V, Held>(n)),
    ),
    "effect/Queue:dropping": made("Queue", ([size], site) =>
      Effect.flatMap(capacity("Queue.dropping", size, site), (n) => Queue.dropping<V, Held>(n)),
    ),
    "effect/Queue:offer": on<Q, boolean>(
      "Queue",
      "offer",
      2,
      (held, [value]) => Queue.offer(held, value ?? Value.undef),
      bool,
      FULL,
    ),
    "effect/Queue:offerUnsafe": now<Q, boolean>(
      "Queue",
      "offerUnsafe",
      2,
      (held, [value]) => Queue.offerUnsafe(held, value ?? Value.undef),
      bool,
    ),
    "effect/Queue:offerAll": later<Q, ReadonlyArray<V>>(
      "Queue",
      "offerAll",
      2,
      (held, [values], site) =>
        Effect.map(items("Queue.offerAll", values, site), (found) => Queue.offerAll(held, found)),
      list,
      FULL,
    ),
    "effect/Queue:take": on<Q, V>("Queue", "take", 1, (held) => Queue.take(held), same, EMPTY),
    "effect/Queue:takeAll": on<Q, ReadonlyArray<V>>(
      "Queue",
      "takeAll",
      1,
      (held) => Queue.takeAll(held),
      list,
      EMPTY,
    ),
    "effect/Queue:takeN": later<Q, ReadonlyArray<V>>(
      "Queue",
      "takeN",
      2,
      (held, [n], site) =>
        Effect.map(count("Queue.takeN", n, site), (found) => Queue.takeN(held, found)),
      list,
      EMPTY,
    ),
    "effect/Queue:takeBetween": later<Q, ReadonlyArray<V>>(
      "Queue",
      "takeBetween",
      3,
      (held, [min, max], site) =>
        Effect.flatMap(count("Queue.takeBetween", min, site), (least) =>
          Effect.map(count("Queue.takeBetween", max, site), (most) =>
            Queue.takeBetween(held, least, most),
          ),
        ),
      list,
      EMPTY,
    ),
    "effect/Queue:peek": on<Q, V>("Queue", "peek", 1, (held) => Queue.peek(held), same, EMPTY),
    "effect/Queue:poll": on<Q, Option.Option<V>>(
      "Queue",
      "poll",
      1,
      (held) => Queue.poll(held),
      option,
    ),
    "effect/Queue:clear": on<Q, ReadonlyArray<V>>(
      "Queue",
      "clear",
      1,
      (held) => Queue.clear(held),
      list,
    ),
    "effect/Queue:size": on<Q, number>("Queue", "size", 1, (held) => Queue.size(held), num),
    "effect/Queue:sizeUnsafe": now<Q, number>("Queue", "sizeUnsafe", 1, Queue.sizeUnsafe, num),
    "effect/Queue:isFull": on<Q, boolean>("Queue", "isFull", 1, (held) => Queue.isFull(held), bool),
    "effect/Queue:isFullUnsafe": now<Q, boolean>(
      "Queue",
      "isFullUnsafe",
      1,
      Queue.isFullUnsafe,
      bool,
    ),
    "effect/Queue:end": on<Q, boolean>(
      "Queue",
      "end",
      1,
      (held) => Queue.end(held as unknown as Queue.Queue<V, Cause.Done>),
      bool,
    ),
    "effect/Queue:fail": on<Q, boolean>(
      "Queue",
      "fail",
      2,
      (held, [error]) => Queue.fail(held, new Value.Rejected({ rejection: error ?? Value.undef })),
      bool,
    ),
    "effect/Queue:shutdown": on<Q, boolean>(
      "Queue",
      "shutdown",
      1,
      (held) => Queue.shutdown(held),
      bool,
    ),
  };

  // ---- PubSub: what is published reaches each one who subscribed before it was.

  type P = PubSub.PubSub<V>;
  type S = PubSub.Subscription<V>;

  /** Numbers and text the code writes, as the library takes its options. */
  const plainOf = (v: V | undefined): unknown => {
    if (v === undefined || v._tag === "Undef") return undefined;
    if (v._tag === "Num" || v._tag === "Str" || v._tag === "Bool") return v.value;
    if (v._tag === "Obj" && !v.brand) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(v.fields)) {
        const made = plainOf(value);
        if (made === NOT_PLAIN) return NOT_PLAIN;
        out[key] = made;
      }
      return out;
    }
    return NOT_PLAIN;
  };

  const options = <A>(name: string, v: V | undefined, site: Site): Eval<A> => {
    const made = plainOf(v);
    return made === NOT_PLAIN
      ? unseen(site, `calls ${name} with options the prover cannot see`)
      : Effect.succeed(made as A);
  };

  /** Options the code writes, or none where it writes something else. */
  const optionsOf = (v: V | undefined): unknown => {
    const read = plainOf(v);
    return read === NOT_PLAIN ? undefined : read;
  };

  const SUBSCRIPTION_WAIT = "takes from a PubSub that nothing publishes to";

  const pubsubs: Models = {
    "effect/PubSub:unbounded": made("PubSub", ([given_], site) =>
      Effect.flatMap(options<{ replay?: number }>("PubSub.unbounded", given_, site), (read) =>
        PubSub.unbounded<V>(read),
      ),
    ),
    "effect/PubSub:bounded": made("PubSub", ([given_], site) =>
      Effect.flatMap(options<number>("PubSub.bounded", given_, site), (read) =>
        PubSub.bounded<V>(read),
      ),
    ),
    "effect/PubSub:dropping": made("PubSub", ([given_], site) =>
      Effect.flatMap(options<number>("PubSub.dropping", given_, site), (read) =>
        PubSub.dropping<V>(read),
      ),
    ),
    "effect/PubSub:sliding": made("PubSub", ([given_], site) =>
      Effect.flatMap(options<number>("PubSub.sliding", given_, site), (read) =>
        PubSub.sliding<V>(read),
      ),
    ),
    "effect/PubSub:publish": on<P, boolean>(
      "PubSub",
      "publish",
      2,
      (held, [value]) => PubSub.publish(held, value ?? Value.undef),
      bool,
      "publishes to a full PubSub that nothing takes from",
    ),
    "effect/PubSub:publishAll": later<P, boolean>(
      "PubSub",
      "publishAll",
      2,
      (held, [values], site) =>
        Effect.map(items("PubSub.publishAll", values, site), (found) =>
          PubSub.publishAll(held, found),
        ),
      bool,
      "publishes to a full PubSub that nothing takes from",
    ),
    "effect/PubSub:size": on<P, number>("PubSub", "size", 1, (held) => PubSub.size(held), num),
    "effect/PubSub:isFull": on<P, boolean>(
      "PubSub",
      "isFull",
      1,
      (held) => PubSub.isFull(held),
      bool,
    ),
    "effect/PubSub:isEmpty": on<P, boolean>(
      "PubSub",
      "isEmpty",
      1,
      (held) => PubSub.isEmpty(held),
      bool,
    ),
    "effect/PubSub:shutdown": on<P, void>(
      "PubSub",
      "shutdown",
      1,
      (held) => PubSub.shutdown(held),
      none,
    ),
    "effect/PubSub:subscribe": ([self], site) => {
      const held = heldOf<P>("PubSub", self);
      return held
        ? Effect.succeed(
            scoped(
              "PubSub.subscribe",
              site,
              () => PubSub.subscribe(held),
              (subscription) => wrap("Subscription", subscription),
            ),
          )
        : wrongArguments(site, "PubSub.subscribe");
    },
    "effect/PubSub:take": on<S, V>(
      "Subscription",
      "take",
      1,
      (held) => PubSub.take(held),
      same,
      SUBSCRIPTION_WAIT,
    ),
    "effect/PubSub:takeAll": on<S, ReadonlyArray<V>>(
      "Subscription",
      "takeAll",
      1,
      (held) => PubSub.takeAll(held),
      list,
      SUBSCRIPTION_WAIT,
    ),
    "effect/PubSub:takeUpTo": later<S, ReadonlyArray<V>>(
      "Subscription",
      "takeUpTo",
      2,
      (held, [max], site) =>
        Effect.map(count("PubSub.takeUpTo", max, site), (most) => PubSub.takeUpTo(held, most)),
      list,
    ),
    "effect/PubSub:remaining": on<S, number>(
      "Subscription",
      "remaining",
      1,
      (held) => PubSub.remaining(held),
      num,
    ),
  };

  // A latch and a semaphore have members of their own, which the module's functions call.

  type Member = (args: ReadonlyArray<V>, site: Site) => Eval<V>;

  const LATCH_WAIT = "waits for a Latch that nothing opens";
  const PERMITS_WAIT = "waits for permits of a Semaphore that nothing releases";

  /** An effect of the library that gives a value of its own, as an effect of the code. */
  const given = <A>(
    name: string,
    effect: Effect.Effect<A, unknown>,
    give: (value: A) => V,
    site: Site,
    wait?: string,
  ): V =>
    timed(
      name,
      (timeline) =>
        Timeline.back(
          timeline,
          wait ? Timeline.waiting(timeline, wait, site, effect) : effect,
          give,
        ),
      site,
    );

  /** An effect of the code that the library wraps: `latch.whenOpen(effect)`, `semaphore.withPermits(1)(effect)`. */
  const around =
    <A>(
      name: string,
      wrapped: (self: Effect.Effect<V, Held>) => Effect.Effect<A, unknown>,
      give: (value: A) => V,
      wait: string,
    ): Member =>
    ([effect], site) =>
      effect?._tag === "Effect"
        ? Effect.succeed(
            timed(
              name,
              (timeline) =>
                Timeline.back(
                  timeline,
                  // While it waits to get in, the wait is the latch's or the semaphore's.
                  Timeline.waiting(
                    timeline,
                    wait,
                    site,
                    wrapped(Timeline.real(timeline, effect.run)),
                  ),
                  give,
                ),
              site,
            ),
          )
        : wrongArguments(site, name);

  const latchMembers = (latch: Latch.Latch, site: Site): Record<string, V | Member> => ({
    open: lazy(() => Effect.map(latch.open, bool)),
    close: lazy(() => Effect.map(latch.close, bool)),
    release: lazy(() => Effect.map(latch.release, bool)),
    await: given("latch.await", latch.await, none, site, LATCH_WAIT),
    whenOpen: around("latch.whenOpen", (self) => latch.whenOpen(self), same, LATCH_WAIT),
    isOpen: () => Effect.sync(() => bool(latch.isOpen())),
    openUnsafe: () => Effect.sync(() => bool(latch.openUnsafe())),
    closeUnsafe: () => Effect.sync(() => bool(latch.closeUnsafe())),
  });

  const permits = (name: string, v: V | undefined, site: Site): Eval<number> => {
    const n = whole(v);
    return n === undefined
      ? unseen(site, `calls ${name} with a count of permits the prover cannot see`)
      : Effect.succeed(n);
  };

  const semaphoreMembers = (semaphore: Semaphore.Semaphore): Record<string, V | Member> => ({
    withPermits: ([n], site) =>
      Effect.map(permits("semaphore.withPermits", n, site), (found) =>
        native(
          "semaphore.withPermits",
          around(
            "semaphore.withPermits",
            (self) => semaphore.withPermits(found)(self),
            same,
            PERMITS_WAIT,
          ),
        ),
      ),
    withPermit: around(
      "semaphore.withPermit",
      (self) => semaphore.withPermit(self),
      same,
      PERMITS_WAIT,
    ),
    withPermitsIfAvailable: ([n], site) =>
      Effect.map(permits("semaphore.withPermitsIfAvailable", n, site), (found) =>
        native(
          "semaphore.withPermitsIfAvailable",
          around(
            "semaphore.withPermitsIfAvailable",
            (self) => semaphore.withPermitsIfAvailable(found)(self),
            option,
            PERMITS_WAIT,
          ),
        ),
      ),
    take: ([n], site) =>
      Effect.map(permits("semaphore.take", n, site), (found) =>
        given("semaphore.take", semaphore.take(found), num, site, PERMITS_WAIT),
      ),
    takeIfAvailable: ([n], site) =>
      Effect.map(permits("semaphore.takeIfAvailable", n, site), (found) =>
        given("semaphore.takeIfAvailable", semaphore.takeIfAvailable(found), bool, site),
      ),
    release: ([n], site) =>
      Effect.map(permits("semaphore.release", n, site), (found) =>
        given("semaphore.release", semaphore.release(found), num, site),
      ),
    resize: ([n], site) =>
      Effect.map(permits("semaphore.resize", n, site), (found) =>
        given("semaphore.resize", semaphore.resize(found), none, site),
      ),
    releaseAll: lazy(() => Effect.map(semaphore.releaseAll, num)),
  });

  /** What a request asks for, as a value of the code. */
  const asked = (request: object): V => {
    const read = (value: unknown): V =>
      typeof value === "number"
        ? Value.num(value)
        : typeof value === "string"
          ? Value.str(value)
          : typeof value === "boolean"
            ? Value.bool(value)
            : Array.isArray(value)
              ? arr(value.map(read))
              : typeof value === "object" && value !== null
                ? Value.obj(
                    Object.fromEntries(
                      Object.entries(value).map(([name, each]) => [name, read(each)]),
                    ),
                  )
                : Value.undef;
    return read({ ...request });
  };

  /** A member of a latch or a semaphore, as the code reads it: `latch.open`, `semaphore.take`. */
  const member = (value: V, key: string, site: Site): V | undefined => {
    // What an entry of a batch asks for: `entry.request`.
    const entry = heldOf<Request.Entry<Request.Request<V, Value.Rejected>>>("Entry", value);
    if (entry && key === "request") return asked(entry.request);
    const latch = heldOf<Latch.Latch>("Latch", value);
    const semaphore = heldOf<Semaphore.Semaphore>("Semaphore", value);
    const members = latch
      ? latchMembers(latch, site)
      : semaphore
        ? semaphoreMembers(semaphore)
        : undefined;
    const found = members?.[key];
    if (found === undefined) return undefined;
    return typeof found === "function"
      ? native(`${latch ? "latch" : "semaphore"}.${key}`, found)
      : found;
  };

  /** A function of the module that is a member of the latch or the semaphore, given the rest. */
  const ofMember =
    (kind: "Latch" | "Semaphore", key: string, calls: number, piped: boolean): Model =>
    (args, site) => {
      const name = `${kind}.${key}`;
      const [self, ...rest] = args;
      if (kindOf(self) !== kind) {
        // `Semaphore.take(n)` then the semaphore.
        return piped
          ? Effect.succeed(
              native(name, ([given_], at) =>
                kindOf(given_) === kind
                  ? ofMember(kind, key, calls, false)([given_!, ...args], at)
                  : wrongArguments(at, name),
              ),
            )
          : wrongArguments(site, name);
      }
      const found = member(self!, key, site);
      if (!found) return wrongArguments(site, name);
      if (calls === 0) return Effect.succeed(found);
      // The member is called with its own arguments, and what it gives with the rest.
      return Effect.flatMap(
        host.call(found, rest.slice(0, calls === 1 ? rest.length : 1), site),
        (first) =>
          calls === 2 && rest.length > 1
            ? host.call(first, rest.slice(1), site)
            : Effect.succeed(first),
      );
    };

  const open = (v: V | undefined, site: Site): Eval<boolean> =>
    v === undefined || v._tag === "Undef" ? Effect.succeed(false) : host.decide(v, site);

  const latches: Models = {
    "effect/Latch:make": made("Latch", ([opened], site) =>
      Effect.flatMap(open(opened, site), (is) => Latch.make(is)),
    ),
    "effect/Latch:makeUnsafe": madeNow("Latch", ([opened], site) =>
      Effect.map(open(opened, site), (is) => Latch.makeUnsafe(is)),
    ),
    "effect/Latch:open": ofMember("Latch", "open", 0, false),
    "effect/Latch:close": ofMember("Latch", "close", 0, false),
    "effect/Latch:release": ofMember("Latch", "release", 0, false),
    "effect/Latch:await": ofMember("Latch", "await", 0, false),
    "effect/Latch:isOpen": ofMember("Latch", "isOpen", 1, false),
    "effect/Latch:openUnsafe": ofMember("Latch", "openUnsafe", 1, false),
    "effect/Latch:closeUnsafe": ofMember("Latch", "closeUnsafe", 1, false),
    "effect/Latch:whenOpen": (args, site) =>
      args.length === 1
        ? ofMember("Latch", "whenOpen", 0, false)(args, site)
        : ofMember("Latch", "whenOpen", 1, false)(args, site),
  };

  const semaphores: Models = {
    "effect/Semaphore:make": made("Semaphore", ([n], site) =>
      Effect.flatMap(permits("Semaphore.make", n, site), (found) => Semaphore.make(found)),
    ),
    "effect/Semaphore:makeUnsafe": madeNow("Semaphore", ([n], site) =>
      Effect.map(permits("Semaphore.makeUnsafe", n, site), (found) => Semaphore.makeUnsafe(found)),
    ),
    "effect/Semaphore:withPermits": ofMember("Semaphore", "withPermits", 2, false),
    "effect/Semaphore:withPermitsIfAvailable": ofMember(
      "Semaphore",
      "withPermitsIfAvailable",
      2,
      false,
    ),
    "effect/Semaphore:withPermit": (args, site) =>
      args.length === 1
        ? ofMember("Semaphore", "withPermit", 0, false)(args, site)
        : ofMember("Semaphore", "withPermit", 1, false)(args, site),
    "effect/Semaphore:take": ofMember("Semaphore", "take", 1, true),
    "effect/Semaphore:takeIfAvailable": ofMember("Semaphore", "takeIfAvailable", 1, true),
    "effect/Semaphore:release": ofMember("Semaphore", "release", 1, true),
    "effect/Semaphore:resize": ofMember("Semaphore", "resize", 1, true),
    "effect/Semaphore:releaseAll": ofMember("Semaphore", "releaseAll", 0, false),
  };

  // ---- Fibers.

  type F = Fiber.Fiber<V, Held>;
  const FIBER_WAIT = "waits for a fiber that never ends";

  const forked = (name: string, fork: (self: Effect.Effect<V, Held>) => Effect.Effect<F>): Model =>
    dualBy(
      name,
      (v) => v._tag === "Effect",
      ([self], site) =>
        self?._tag === "Effect"
          ? Effect.succeed(
              timed(
                name,
                (timeline) =>
                  Effect.map(fork(Timeline.real(timeline, self.run)), (fiber) =>
                    wrap("Fiber", fiber),
                  ),
                site,
              ),
            )
          : wrongArguments(site, name),
    );

  const fibersOf = (name: string, given_: V | undefined, site: Site): Eval<ReadonlyArray<F>> =>
    Effect.flatMap(items(name, given_, site), (found) => {
      const held = found.map((item) => heldOf<F>("Fiber", item));
      return held.every((fiber) => fiber !== undefined)
        ? Effect.succeed(held as ReadonlyArray<F>)
        : wrongArguments(site, name);
    });

  const fibers: Models = {
    "effect/Effect:forkChild": forked("Effect.forkChild", (self) => Effect.forkChild(self)),
    "effect/Effect:forkDetach": forked("Effect.forkDetach", (self) => Effect.forkDetach(self)),
    "effect/Fiber:join": on<F, V>("Fiber", "join", 1, (held) => Fiber.join(held), same, FIBER_WAIT),
    "effect/Fiber:await": (args, site) => {
      const held = heldOf<F>("Fiber", args[0]);
      return held
        ? Effect.succeed(
            timed(
              "Fiber.await",
              (timeline) =>
                Effect.flatMap(
                  Timeline.waiting(timeline, FIBER_WAIT, site, Fiber.await(held)),
                  (exit) => exitOf(timeline, exit),
                ),
              site,
            ),
          )
        : wrongArguments(site, "Fiber.await");
    },
    "effect/Fiber:interrupt": on<F, void>(
      "Fiber",
      "interrupt",
      1,
      (held) => Fiber.interrupt(held),
      none,
    ),
    "effect/Fiber:joinAll": (args, site) =>
      Effect.map(fibersOf("Fiber.joinAll", args[0], site), (held) =>
        given("Fiber.joinAll", Fiber.joinAll(held), list, site, FIBER_WAIT),
      ),
    "effect/Fiber:interruptAll": (args, site) =>
      Effect.map(fibersOf("Fiber.interruptAll", args[0], site), (held) =>
        given("Fiber.interruptAll", Fiber.interruptAll(held), none, site),
      ),
  };

  // ---- Effects that take time, and effects run together.

  /** A function of two effects, with either first. */
  const pairing =
    (
      name: string,
      body: (
        timeline: Timeline.Timeline,
        self: Effect.Effect<V, Held>,
        that: Effect.Effect<V, Held>,
      ) => Effect.Effect<V, unknown>,
    ): Model =>
    (args, site) => {
      const [first, second] = args;
      const both = (self: V, that: V): V =>
        timed(
          name,
          (timeline) =>
            Timeline.back(
              timeline,
              body(
                timeline,
                Timeline.real(timeline, (self as { run: Eval<V> }).run),
                Timeline.real(timeline, (that as { run: Eval<V> }).run),
              ),
              same,
            ),
          site,
        );
      if (first?._tag === "Effect" && second?._tag === "Effect")
        return Effect.succeed(both(first, second));
      if (first?._tag !== "Effect") return wrongArguments(site, name);
      return Effect.succeed(
        native(name, ([self], at) =>
          self?._tag === "Effect" ? Effect.succeed(both(self, first)) : wrongArguments(at, name),
        ),
      );
    };

  const racing =
    (
      name: string,
      race: (all: ReadonlyArray<Effect.Effect<V, Held>>) => Effect.Effect<V, unknown>,
    ): Model =>
    ([given_], site) =>
      Effect.succeed(
        timed(
          name,
          (timeline) =>
            Effect.flatMap(effects(name, timeline, given_, site), (all) =>
              Timeline.back(timeline, race(all), same),
            ),
          site,
        ),
      );

  /** `self` within a time: the library's own race of it against a sleep, on the handler's timeline. */
  const within = (
    timeline: Timeline.Timeline,
    self: Effect.Effect<V, Held>,
    time: Timeline.Time,
  ): Effect.Effect<Option.Option<V>, Held> =>
    Effect.raceFirst(
      Effect.asSome(self),
      Effect.as(timeline.instant.sleep(time), Option.none<V>()),
    );

  const timeoutError = (time: Timeline.Time): V =>
    Value.obj({
      "~effect/Cause/TimeoutError": Value.str("~effect/Cause/TimeoutError"),
      _tag: Value.str("TimeoutError"),
      ...(typeof time === "number"
        ? {
            message: Value.str(
              `Operation timed out after '${Duration.format(Duration.millis(time))}'`,
            ),
          }
        : {}),
    });

  const exits =
    (timeline: Timeline.Timeline, fn: V, site: Site) =>
    (exit: Exit.Exit<V, unknown>): Effect.Effect<V> =>
      sure(
        Timeline.real(
          timeline,
          Effect.flatMap(exitOf(timeline, exit), (held) => ran(fn, [held], site)),
        ),
      );

  const timing: Models = {
    "effect/Effect:sleep": ([duration], site) =>
      Effect.succeed(
        timed(
          "Effect.sleep",
          (timeline) =>
            Effect.flatMap(span("Effect.sleep", duration, site), (time) =>
              Effect.as(timeline.instant.sleep(time), Value.undef),
            ),
          site,
        ),
      ),
    "effect/Effect:delay": onEffect("Effect.delay", 1, (timeline, self, [duration], site) =>
      Effect.flatMap(span("Effect.delay", duration, site), (time) =>
        Timeline.back(timeline, Effect.andThen(timeline.instant.sleep(time), self), same),
      ),
    ),
    "effect/Effect:timeout": onEffect("Effect.timeout", 1, (timeline, self, [duration], site) =>
      Effect.flatMap(span("Effect.timeout", duration, site), (time) =>
        Effect.flatMap(Timeline.back(timeline, within(timeline, self, time), option), (made) => {
          const read = Value.optionOf(made);
          return read?._tag === "Some"
            ? Effect.succeed(read.value)
            : Effect.fail(new Value.Rejected({ rejection: timeoutError(time) }));
        }),
      ),
    ),
    "effect/Effect:timeoutOption": onEffect(
      "Effect.timeoutOption",
      1,
      (timeline, self, [duration], site) =>
        Effect.flatMap(span("Effect.timeoutOption", duration, site), (time) =>
          Timeline.back(timeline, within(timeline, self, time), option),
        ),
    ),
    "effect/Effect:timeoutOrElse": onEffect(
      "Effect.timeoutOrElse",
      1,
      (timeline, self, [options], site) => {
        const fields = options?._tag === "Obj" ? options.fields : {};
        const orElse = fields.orElse;
        if (!orElse) return wrongArguments(site, "Effect.timeoutOrElse");
        return Effect.flatMap(span("Effect.timeoutOrElse", fields.duration, site), (time) =>
          Effect.flatMap(Timeline.back(timeline, within(timeline, self, time), option), (made) => {
            const read = Value.optionOf(made);
            return read?._tag === "Some" ? Effect.succeed(read.value) : ran(orElse, [], site);
          }),
        );
      },
    ),
    "effect/Effect:race": pairing("Effect.race", (_, self, that) => Effect.race(self, that)),
    "effect/Effect:raceFirst": pairing("Effect.raceFirst", (_, self, that) =>
      Effect.raceFirst(self, that),
    ),
    "effect/Effect:raceAll": racing("Effect.raceAll", (all) => Effect.raceAll(all)),
    "effect/Effect:raceAllFirst": racing("Effect.raceAllFirst", (all) => Effect.raceAllFirst(all)),
    "effect/Effect:uninterruptible": onEffect("Effect.uninterruptible", 0, (timeline, self) =>
      Timeline.back(timeline, Effect.uninterruptible(self), same),
    ),
    "effect/Effect:interruptible": onEffect("Effect.interruptible", 0, (timeline, self) =>
      Timeline.back(timeline, Effect.interruptible(self), same),
    ),
    "effect/Effect:onExit": onEffect("Effect.onExit", 1, (timeline, self, [f], site) =>
      f
        ? Timeline.back(timeline, Effect.onExit(self, exits(timeline, f, site)), same)
        : wrongArguments(site, "Effect.onExit"),
    ),
    "effect/Effect:onInterrupt": onEffect("Effect.onInterrupt", 1, (timeline, self, [f], site) => {
      const finalizer = effectOf(timeline, f, site);
      return finalizer
        ? Timeline.back(
            timeline,
            Effect.onInterrupt(self, () => sure(finalizer)),
            same,
          )
        : wrongArguments(site, "Effect.onInterrupt");
    }),
    "effect/Effect:retry": onEffect("Effect.retry", 1, (timeline, self, [options], site) =>
      Effect.flatMap(
        again("Effect.retry", timeline, options, (error) => (error as Held).rejection, site),
        (policy) =>
          Timeline.back(
            timeline,
            Effect.retry(turn("Effect.retry", timeline, self, site), policy as never),
            same,
          ),
      ),
    ),
    "effect/Effect:repeat": onEffect("Effect.repeat", 1, (timeline, self, [options], site) =>
      Effect.flatMap(
        again("Effect.repeat", timeline, options, (value) => value as V, site),
        (policy) =>
          Timeline.back(
            timeline,
            Effect.repeat(turn("Effect.repeat", timeline, self, site), policy as never),
            outputOf,
          ),
      ),
    ),
  };

  /** Values of the library that are read where the code names them. */
  const sited: Readonly<Record<string, (site: Site) => V>> = {
    "effect/Effect:scope": (site) =>
      scoped(
        "Effect.scope",
        site,
        () => Effect.scope,
        (held) => wrap("Scope", held),
      ),
    "effect/Random:next": (site) =>
      drawn("Random.next", site, () => Effect.succeed(Random.next), num),
    "effect/Random:nextInt": (site) =>
      drawn("Random.nextInt", site, () => Effect.succeed(Random.nextInt), num),
    "effect/Random:nextBoolean": (site) =>
      drawn("Random.nextBoolean", site, () => Effect.succeed(Random.nextBoolean), bool),
    "effect/Effect:undefined": () => lazy(() => Effect.succeed(Value.undef)),
    "effect/Effect:yieldNow": () => lazy(() => Effect.as(Effect.yieldNow, Value.undef)),
    "effect/Effect:never": (site) =>
      timed(
        "Effect.never",
        (timeline) =>
          Timeline.back(
            timeline,
            Timeline.waiting(timeline, "waits for Effect.never", site, Effect.never),
            same,
          ),
        site,
      ),
    "effect/Effect:interrupt": () => lazy(() => Effect.interrupt),
    // Begin the transaction again when what it read changes.
    "effect/Effect:txRetry": (site) =>
      lazy(() =>
        Effect.flatMap(Effect.serviceOption(Effect.Transaction), (state) =>
          Option.isSome(state)
            ? Effect.provideService(Effect.txRetry, Effect.Transaction, state.value)
            : unseen(site, "calls Effect.txRetry outside a transaction"),
        ),
      ),
    "effect/Schedule:forever": () => wrap("Schedule", Schedule.forever),
    "effect/Request:Class": () =>
      requestClass("Request.Class", (fields) => Request.of<Asked>()(fields as never)),
    "effect/Schedule:once": () => wrap("Schedule", Schedule.once),
  };

  const schedulesOf = (
    name: string,
    given_: V | undefined,
    site: Site,
  ): Eval<
    readonly [Schedule.Schedule<unknown, unknown>, ...Array<Schedule.Schedule<unknown, unknown>>]
  > =>
    Effect.flatMap(items(name, given_, site), (found) => {
      const held = found.map(scheduleOf);
      return held.length > 0 && held.every((each) => each !== undefined)
        ? Effect.succeed(held as never)
        : wrongArguments(site, name);
    });

  const schedules: Models = {
    "effect/Schedule:recurs": schedule("Schedule.recurs", ([n], site) =>
      Effect.map(count("Schedule.recurs", n, site), (times) => Schedule.recurs(times)),
    ),
    "effect/Schedule:spaced": schedule("Schedule.spaced", ([duration], site) =>
      Effect.map(written("Schedule.spaced", duration, site), (time) => Schedule.spaced(time)),
    ),
    "effect/Schedule:fixed": schedule("Schedule.fixed", ([duration], site) =>
      Effect.map(written("Schedule.fixed", duration, site), (time) => Schedule.fixed(time)),
    ),
    "effect/Schedule:windowed": schedule("Schedule.windowed", ([duration], site) =>
      Effect.map(written("Schedule.windowed", duration, site), (time) => Schedule.windowed(time)),
    ),
    "effect/Schedule:duration": schedule("Schedule.duration", ([duration], site) =>
      Effect.map(written("Schedule.duration", duration, site), (time) => Schedule.duration(time)),
    ),
    "effect/Schedule:exponential": schedule("Schedule.exponential", ([base, factor], site) =>
      Effect.flatMap(written("Schedule.exponential", base, site), (time) =>
        factor === undefined || factor._tag === "Undef"
          ? time.pipe(Schedule.exponential, Effect.succeed)
          : factor._tag === "Num"
            ? Effect.succeed(Schedule.exponential(time, factor.value))
            : unseen(site, "calls Schedule.exponential with a factor the prover cannot see"),
      ),
    ),
    "effect/Schedule:fibonacci": schedule("Schedule.fibonacci", ([one], site) =>
      Effect.map(written("Schedule.fibonacci", one, site), (time) => Schedule.fibonacci(time)),
    ),
    "effect/Schedule:max": schedule("Schedule.max", ([all], site) =>
      Effect.map(schedulesOf("Schedule.max", all, site), (held) => Schedule.max(held)),
    ),
    "effect/Schedule:min": schedule("Schedule.min", ([all], site) =>
      Effect.map(schedulesOf("Schedule.min", all, site), (held) => Schedule.min(held)),
    ),
    "effect/Schedule:concat": onSchedule("Schedule.concat", 2, (self, [other], site) => {
      const that = scheduleOf(other);
      return that
        ? Effect.succeed(Schedule.concat(self, that) as Schedule.Schedule<unknown, unknown>)
        : wrongArguments(site, "Schedule.concat");
    }),
    // Each wait is drawn around the one the schedule gives: the seed decides it.
    "effect/Schedule:jittered": onSchedule("Schedule.jittered", 1, (self) =>
      Effect.sync(() => Schedule.jittered(self)),
    ),
    "effect/Schedule:upTo": onSchedule("Schedule.upTo", 2, (self, [limit], site) => {
      const fields = limit?._tag === "Obj" && !limit.brand ? limit.fields : undefined;
      if (!fields) return wrongArguments(site, "Schedule.upTo");
      const out: { times?: number; duration?: Duration.Duration } = {};
      return Effect.gen(function* () {
        if (fields.times) out.times = yield* count("Schedule.upTo", fields.times, site);
        if (fields.duration) out.duration = yield* written("Schedule.upTo", fields.duration, site);
        return Schedule.upTo(self, out as never) as Schedule.Schedule<unknown, unknown>;
      });
    }),
    "effect/Schedule:passthrough": onSchedule("Schedule.passthrough", 1, (self) =>
      Effect.succeed(Schedule.passthrough(self) as Schedule.Schedule<unknown, unknown>),
    ),
  };

  // ---- Effects run together. One after another is read as before.

  const struct = (timeline: Timeline.Timeline, given_: V): Record<string, Effect.Effect<V, Held>> =>
    Object.fromEntries(
      Object.entries((given_ as { fields: Record<string, V> }).fields).map(([key, value]) => [
        key,
        Timeline.real(timeline, (value as { run: Eval<V> }).run),
      ]),
    );

  const concurrent: Models = {
    "effect/Effect:all": (args, site) => {
      const [given_, options] = args;
      return Effect.flatMap(together("Effect.all", options, site), (concurrency) => {
        if (concurrency === undefined) return base["effect/Effect:all"]!(args, site);
        const discard = flag(options, "discard");
        const fields = options?._tag === "Obj" ? Object.keys(options.fields) : [];
        if (!given_ || !fields.every((key) => key === "concurrency" || key === "discard"))
          return wrongArguments(site, "Effect.all");
        const keyed =
          given_._tag === "Obj" &&
          !given_.brand &&
          Object.values(given_.fields).every((value) => value._tag === "Effect");
        return Effect.succeed(
          timed(
            "Effect.all",
            (timeline) =>
              keyed
                ? Timeline.back(
                    timeline,
                    Effect.all(struct(timeline, given_), { concurrency }),
                    (out) => (discard ? Value.undef : Value.obj(out)),
                  )
                : Effect.flatMap(effects("Effect.all", timeline, given_, site), (all) =>
                    Timeline.back(timeline, Effect.all(all, { concurrency }), (out) =>
                      discard ? Value.undef : arr(out),
                    ),
                  ),
            site,
          ),
        );
      });
    },
    "effect/Effect:forEach": dualBy(
      "Effect.forEach",
      (v) => !callable(v),
      (args, site) => {
        const [given_, f, options] = args;
        return Effect.flatMap(together("Effect.forEach", options, site), (concurrency) => {
          if (concurrency === undefined) return base["effect/Effect:forEach"]!(args, site);
          if (!f) return wrongArguments(site, "Effect.forEach");
          const discard = flag(options, "discard");
          return Effect.succeed(
            timed(
              "Effect.forEach",
              (timeline) =>
                Effect.flatMap(items("Effect.forEach", given_, site), (found) =>
                  Timeline.back(
                    timeline,
                    Effect.forEach(
                      found,
                      (item, index) => called(timeline, f, site)(item, Value.num(index)),
                      { concurrency },
                    ),
                    (out) => (discard ? Value.undef : arr(out)),
                  ),
                ),
              site,
            ),
          );
        });
      },
    ),
    "effect/Effect:zip": (args, site) => {
      const [self, that, options] = args;
      return self?._tag === "Effect" && that?._tag === "Effect" && flag(options, "concurrent")
        ? Effect.succeed(
            timed(
              "Effect.zip",
              (timeline) =>
                Timeline.back(
                  timeline,
                  Effect.zip(Timeline.real(timeline, self.run), Timeline.real(timeline, that.run), {
                    concurrent: true,
                  }),
                  (pair) => arr(pair),
                ),
              site,
            ),
          )
        : base["effect/Effect:zip"]!(args, site);
    },
    "effect/Effect:zipWith": (args, site) => {
      const [self, that, f, options] = args;
      return self?._tag === "Effect" && that?._tag === "Effect" && f && flag(options, "concurrent")
        ? Effect.succeed(
            timed(
              "Effect.zipWith",
              (timeline) =>
                Effect.flatMap(
                  Timeline.back(
                    timeline,
                    Effect.zip(
                      Timeline.real(timeline, self.run),
                      Timeline.real(timeline, that.run),
                      { concurrent: true },
                    ),
                    (pair) => arr(pair),
                  ),
                  (pair) => host.call(f, kit.itemsOf(pair) ?? [], site),
                ),
              site,
            ),
          )
        : base["effect/Effect:zipWith"]!(args, site);
    },
  };

  // ---- Scopes: what is acquired is released when the scope closes, however it closes.

  /** An effect that needs a scope, which `Effect.scoped` gives it. */
  const scoped = <A>(
    name: string,
    site: Site,
    body: (timeline: Timeline.Timeline) => Effect.Effect<A, unknown, Scope.Scope>,
    give: (value: A) => V,
  ): V =>
    timed(
      name,
      (timeline) =>
        Effect.flatMap(Effect.serviceOption(Scope.Scope), (scope) =>
          Option.isSome(scope)
            ? Timeline.back(
                timeline,
                Effect.provideService(body(timeline), Scope.Scope, scope.value),
                give,
              )
            : unseen(site, `calls ${name} outside Effect.scoped`),
        ),
      site,
    );

  /** What a function of the code does when a scope closes, given how it closed. */
  const closing =
    (timeline: Timeline.Timeline, fn: V, site: Site, held: ReadonlyArray<V>) =>
    (exit: Exit.Exit<unknown, unknown>): Effect.Effect<V> =>
      sure(
        Timeline.real(
          timeline,
          Effect.flatMap(exitOf(timeline, exit), (ended) => ran(fn, [...held, ended], site)),
        ),
      );

  const scopes: Models = {
    // `Effect.fn(body, Effect.scoped)` gives it the function's arguments after the effect.
    "effect/Effect:scoped": ([self], site) =>
      self?._tag === "Effect"
        ? Effect.succeed(
            timed(
              "Effect.scoped",
              (timeline) =>
                Timeline.back(timeline, Effect.scoped(Timeline.real(timeline, self.run)), same),
              site,
            ),
          )
        : wrongArguments(site, "Effect.scoped"),
    "effect/Effect:acquireRelease": ([acquire, release], site) =>
      acquire?._tag === "Effect" && release
        ? Effect.succeed(
            scoped(
              "Effect.acquireRelease",
              site,
              (timeline) =>
                Effect.acquireRelease(Timeline.real(timeline, acquire.run), (held, exit) =>
                  closing(timeline, release, site, [held])(exit),
                ),
              same,
            ),
          )
        : wrongArguments(site, "Effect.acquireRelease"),
    "effect/Effect:acquireUseRelease": ([acquire, use, release], site) =>
      acquire?._tag === "Effect" && use && release
        ? Effect.succeed(
            timed(
              "Effect.acquireUseRelease",
              (timeline) =>
                Timeline.back(
                  timeline,
                  Effect.acquireUseRelease(
                    Timeline.real(timeline, acquire.run),
                    (held) => called(timeline, use, site)(held),
                    (held, exit) => closing(timeline, release, site, [held])(exit),
                  ),
                  same,
                ),
              site,
            ),
          )
        : wrongArguments(site, "Effect.acquireUseRelease"),
    "effect/Effect:addFinalizer": ([finalizer], site) =>
      finalizer
        ? Effect.succeed(
            scoped(
              "Effect.addFinalizer",
              site,
              (timeline) => Effect.addFinalizer(closing(timeline, finalizer, site, [])),
              none,
            ),
          )
        : wrongArguments(site, "Effect.addFinalizer"),
    "effect/Effect:forkScoped": ([self], site) =>
      self?._tag === "Effect"
        ? Effect.succeed(
            scoped(
              "Effect.forkScoped",
              site,
              (timeline) => Effect.forkScoped(Timeline.real(timeline, self.run)),
              (fiber) => wrap("Fiber", fiber),
            ),
          )
        : wrongArguments(site, "Effect.forkScoped"),
  };

  // ---- A stream of what a `SubscriptionRef` held: its value now, then each one it is given.

  const changes: Models = {
    "effect/SubscriptionRef:changes": ([cell], site) => {
      const fields =
        cell?._tag === "Obj" && cell.brand?.kind === "Ref" && !cell.fields[IS]
          ? (cell.fields as Record<string, V>)
          : undefined;
      if (!fields) return wrongArguments(site, "SubscriptionRef.changes");
      const open = Effect.gen(function* () {
        const timeline = yield* Timeline.current(site, "reads SubscriptionRef.changes");
        // The library's own: it keeps the last value for one who subscribes later.
        const held = fields[CHANGES];
        const pubsub =
          held?._tag === "Host"
            ? (held as { readonly pubsub?: PubSub.PubSub<V> }).pubsub!
            : yield* PubSub.unbounded<V>({ replay: 1 });
        if (held?._tag !== "Host") {
          PubSub.publishUnsafe(pubsub, fields.value ?? Value.undef);
          fields[CHANGES] = Object.assign(
            {
              _tag: "Host" as const,
              name: "SubscriptionRef.changes",
              value: (value: V) => void PubSub.publishUnsafe(pubsub, value),
            },
            { pubsub },
          );
        }
        const scope = yield* Scope.make();
        const subscription = yield* Effect.provideService(
          PubSub.subscribe(pubsub),
          Scope.Scope,
          scope,
        );
        const pull: Eval<ReadonlyArray<V> | undefined> = Timeline.back(
          timeline,
          Timeline.waiting(
            timeline,
            "waits for a SubscriptionRef that nothing sets",
            site,
            PubSub.take(subscription),
          ),
          same,
        ).pipe(Effect.map((value) => [value]));
        return pull;
      });
      return Effect.succeed<V>({ _tag: "Stream", open });
    },
  };

  // ---- A set of fibers, and a place for one: stopped when their scope closes.

  type FS = FiberSet.FiberSet<V, Held>;
  type FH = FiberHandle.FiberHandle<V, Held>;

  /** `FiberSet.run(set, effect)`, or `FiberSet.run(set)` then the effect. */
  const running = <H>(
    kind: "FiberSet" | "FiberHandle",
    run: (held: H, effect: Effect.Effect<V, Held>, options: unknown) => Effect.Effect<F>,
  ): Model => {
    const name = `${kind}.run`;
    const start = (held: H, effect: V | undefined, given_: V | undefined, site: Site): Eval<V> =>
      effect?._tag === "Effect"
        ? Effect.succeed(
            timed(
              name,
              (timeline) =>
                Timeline.back(
                  timeline,
                  run(held, Timeline.real(timeline, effect.run), optionsOf(given_)),
                  (fiber) => wrap("Fiber", fiber),
                ),
              site,
            ),
          )
        : wrongArguments(site, name);
    return ([self, second, third], site) => {
      const held = heldOf<H>(kind, self);
      if (held === undefined) return wrongArguments(site, name);
      return second?._tag === "Effect"
        ? start(held, second, third, site)
        : Effect.succeed(native(name, ([effect], at) => start(held, effect, second, at)));
    };
  };

  const sets: Models = {
    "effect/FiberSet:make": (_, site) =>
      Effect.succeed(
        scoped(
          "FiberSet.make",
          site,
          () => FiberSet.make<V, Held>(),
          (held) => wrap("FiberSet", held),
        ),
      ),
    "effect/FiberSet:run": running<FS>("FiberSet", (held, effect, read) =>
      FiberSet.run(held, effect, read as never),
    ),
    "effect/FiberSet:add": later<FS, void>(
      "FiberSet",
      "add",
      2,
      (held, [fiber], site) => {
        const given_ = heldOf<F>("Fiber", fiber);
        return given_
          ? Effect.succeed(FiberSet.add(held, given_))
          : wrongArguments(site, "FiberSet.add");
      },
      none,
    ),
    "effect/FiberSet:join": on<FS, void>(
      "FiberSet",
      "join",
      1,
      (held) => FiberSet.join(held),
      none,
      "waits for a FiberSet none of whose fibers fails",
    ),
    "effect/FiberSet:awaitEmpty": on<FS, void>(
      "FiberSet",
      "awaitEmpty",
      1,
      (held) => FiberSet.awaitEmpty(held),
      none,
      "waits for the fibers of a FiberSet, which never end",
    ),
    "effect/FiberSet:clear": on<FS, void>(
      "FiberSet",
      "clear",
      1,
      (held) => FiberSet.clear(held),
      none,
    ),
    "effect/FiberSet:size": on<FS, number>(
      "FiberSet",
      "size",
      1,
      (held) => FiberSet.size(held),
      num,
    ),
    "effect/FiberHandle:make": (_, site) =>
      Effect.succeed(
        scoped(
          "FiberHandle.make",
          site,
          () => FiberHandle.make<V, Held>(),
          (held) => wrap("FiberHandle", held),
        ),
      ),
    "effect/FiberHandle:run": running<FH>("FiberHandle", (held, effect, read) =>
      FiberHandle.run(held, effect, read as never),
    ),
    "effect/FiberHandle:join": on<FH, void>(
      "FiberHandle",
      "join",
      1,
      (held) => FiberHandle.join(held),
      none,
      "waits for a FiberHandle whose fiber does not fail",
    ),
    "effect/FiberHandle:awaitEmpty": on<FH, void>(
      "FiberHandle",
      "awaitEmpty",
      1,
      (held) => FiberHandle.awaitEmpty(held),
      none,
      "waits for the fiber of a FiberHandle, which never ends",
    ),
    "effect/FiberHandle:clear": on<FH, void>(
      "FiberHandle",
      "clear",
      1,
      (held) => FiberHandle.clear(held),
      none,
    ),
  };

  // ---- Transactions: what a fiber reads and writes in one is seen by the others all at once.

  type TR = TxRef.TxRef<V>;
  type TQ = TxQueue.TxQueue<V, Held>;

  /** What a function of the code gives of what a `TxRef` holds, in the transaction that reads it. */
  const changing = (
    name: string,
    give: (before: V, made: V, site: Site) => Eval<{ readonly next: V; readonly gives: V }>,
  ): Model =>
    dual(`TxRef.${name}`, 2, ([self, f], site) => {
      const held = heldOf<TR>("TxRef", self);
      return held && f
        ? Effect.succeed(
            timed(
              `TxRef.${name}`,
              (timeline) =>
                Timeline.back(
                  timeline,
                  held.pipe(
                    TxRef.get,
                    Effect.flatMap((before) =>
                      Timeline.real(
                        timeline,
                        Effect.flatMap(host.call(f, [before], site), (called_) =>
                          give(before, called_, site),
                        ),
                      ),
                    ),
                    Effect.flatMap((read) => Effect.as(TxRef.set(held, read.next), read.gives)),
                    Effect.tx,
                  ),
                  same,
                ),
              site,
            ),
          )
        : wrongArguments(site, `TxRef.${name}`);
    });

  const TX_EMPTY = "takes from a TxQueue that nothing offers to";

  const transactions: Models = {
    "effect/TxRef:make": made("TxRef", ([value]) => TxRef.make<V>(value ?? Value.undef)),
    "effect/TxRef:makeUnsafe": madeNow("TxRef", ([value]) =>
      Effect.sync(() => TxRef.makeUnsafe<V>(value ?? Value.undef)),
    ),
    "effect/TxRef:get": on<TR, V>("TxRef", "get", 1, (held) => TxRef.get(held), same),
    "effect/TxRef:set": on<TR, void>(
      "TxRef",
      "set",
      2,
      (held, [value]) => TxRef.set(held, value ?? Value.undef),
      none,
    ),
    "effect/TxRef:update": changing("update", (_, next) =>
      Effect.succeed({ next, gives: Value.undef }),
    ),
    "effect/TxRef:modify": changing("modify", (_, pair, site) => {
      const read = kit.itemsOf(pair);
      return read && read.length === 2
        ? Effect.succeed({ gives: read[0]!, next: read[1]! })
        : wrongArguments(site, "TxRef.modify");
    }),
    "effect/Effect:tx": onEffect("Effect.tx", 0, (timeline, self, _, site) =>
      Timeline.back(
        timeline,
        Timeline.waiting(
          timeline,
          "retries a transaction whose TxRefs nothing changes",
          site,
          Effect.tx(self),
        ),
        same,
      ),
    ),
    "effect/TxQueue:unbounded": made("TxQueue", () => TxQueue.unbounded<V, Held>()),
    "effect/TxQueue:bounded": made("TxQueue", ([size], site) =>
      Effect.flatMap(capacity("TxQueue.bounded", size, site), (n) => TxQueue.bounded<V, Held>(n)),
    ),
    "effect/TxQueue:offer": on<TQ, boolean>(
      "TxQueue",
      "offer",
      2,
      (held, [value]) => TxQueue.offer(held, value ?? Value.undef),
      bool,
      "offers to a full TxQueue that nothing takes from",
    ),
    "effect/TxQueue:offerAll": later<TQ, ReadonlyArray<V>>(
      "TxQueue",
      "offerAll",
      2,
      (held, [values], site) =>
        Effect.map(items("TxQueue.offerAll", values, site), (found) =>
          TxQueue.offerAll(held, found),
        ),
      list,
    ),
    "effect/TxQueue:take": on<TQ, V>(
      "TxQueue",
      "take",
      1,
      (held) => TxQueue.take(held),
      same,
      TX_EMPTY,
    ),
    "effect/TxQueue:takeAll": on<TQ, ReadonlyArray<V>>(
      "TxQueue",
      "takeAll",
      1,
      (held) => TxQueue.takeAll(held),
      list,
      TX_EMPTY,
    ),
    "effect/TxQueue:takeN": later<TQ, ReadonlyArray<V>>(
      "TxQueue",
      "takeN",
      2,
      (held, [n], site) =>
        Effect.map(count("TxQueue.takeN", n, site), (found) => TxQueue.takeN(held, found)),
      list,
      TX_EMPTY,
    ),
    "effect/TxQueue:peek": on<TQ, V>(
      "TxQueue",
      "peek",
      1,
      (held) => TxQueue.peek(held),
      same,
      TX_EMPTY,
    ),
    "effect/TxQueue:poll": on<TQ, Option.Option<V>>(
      "TxQueue",
      "poll",
      1,
      (held) => TxQueue.poll(held),
      option,
    ),
    "effect/TxQueue:size": on<TQ, number>("TxQueue", "size", 1, (held) => TxQueue.size(held), num),
    "effect/TxQueue:isEmpty": on<TQ, boolean>(
      "TxQueue",
      "isEmpty",
      1,
      (held) => TxQueue.isEmpty(held),
      bool,
    ),
    "effect/TxQueue:isFull": on<TQ, boolean>(
      "TxQueue",
      "isFull",
      1,
      (held) => TxQueue.isFull(held),
      bool,
    ),
  };

  // ---- What is kept by a key: a `Cache` and a `FiberMap`. The key is one the code writes.

  type Key = string | number | boolean;
  type FM = FiberMap.FiberMap<Key, V, Held>;
  type C = Cache.Cache<Key, V, Held>;
  type PL = Pool.Pool<V, Held>;

  /** The library finds a key by what it is, so the prover has to know what it is. */
  const keyOf = (name: string, v: V | undefined, site: Site): Eval<Key> =>
    v?._tag === "Num" || v?._tag === "Str" || v?._tag === "Bool"
      ? Effect.succeed(v.value)
      : unseen(site, `calls ${name} with a key the prover cannot see`);

  const keyed = (key: Key): V =>
    typeof key === "number" ? Value.num(key) : typeof key === "string" ? Value.str(key) : bool(key);

  /** A function of one of these and a key, which gives an effect. */
  const byKey = <H, A>(
    kind: "FiberMap" | "Cache" | "ScopedCache" | "RcMap",
    name: string,
    arity: number,
    body: (
      held: H,
      key: Key,
      rest: ReadonlyArray<V>,
      site: Site,
    ) => Eval<Effect.Effect<A, unknown>>,
    give: (value: A) => V,
    wait?: string,
  ): Model =>
    later<H, A>(
      kind,
      name,
      arity,
      (held, [key, ...rest], site) =>
        Effect.flatMap(keyOf(`${kind}.${name}`, key, site), (read) => body(held, read, rest, site)),
      give,
      wait,
    );

  const kept: Models = {
    "effect/FiberMap:make": (_, site) =>
      Effect.succeed(
        scoped(
          "FiberMap.make",
          site,
          () => FiberMap.make<Key, V, Held>(),
          (held) => wrap("FiberMap", held),
        ),
      ),
    "effect/FiberMap:run": ([self, key, third, fourth], site) => {
      const held = heldOf<FM>("FiberMap", self);
      if (held === undefined) return wrongArguments(site, "FiberMap.run");
      const start = (read: Key, effect: V | undefined, given_: V | undefined, at: Site): Eval<V> =>
        effect?._tag === "Effect"
          ? Effect.succeed(
              timed(
                "FiberMap.run",
                (timeline) =>
                  Timeline.back(
                    timeline,
                    FiberMap.run(
                      held,
                      read,
                      Timeline.real(timeline, effect.run),
                      optionsOf(given_) as never,
                    ),
                    (fiber) => wrap("Fiber", fiber),
                  ),
                at,
              ),
            )
          : wrongArguments(at, "FiberMap.run");
      return Effect.flatMap(keyOf("FiberMap.run", key, site), (read) =>
        third?._tag === "Effect"
          ? start(read, third, fourth, site)
          : Effect.succeed(
              native("FiberMap.run", ([effect], at) => start(read, effect, third, at)),
            ),
      );
    },
    "effect/FiberMap:get": byKey<FM, Option.Option<F>>(
      "FiberMap",
      "get",
      2,
      (held, key) => Effect.succeed(FiberMap.get(held, key)),
      (found) => (Option.isSome(found) ? Value.some(wrap("Fiber", found.value)) : Value.none),
    ),
    "effect/FiberMap:has": byKey<FM, boolean>(
      "FiberMap",
      "has",
      2,
      (held, key) => Effect.succeed(FiberMap.has(held, key)),
      bool,
    ),
    "effect/FiberMap:remove": byKey<FM, void>(
      "FiberMap",
      "remove",
      2,
      (held, key) => Effect.succeed(FiberMap.remove(held, key)),
      none,
    ),
    "effect/FiberMap:clear": on<FM, void>(
      "FiberMap",
      "clear",
      1,
      (held) => FiberMap.clear(held),
      none,
    ),
    "effect/FiberMap:size": on<FM, number>(
      "FiberMap",
      "size",
      1,
      (held) => FiberMap.size(held),
      num,
    ),
    "effect/FiberMap:awaitEmpty": on<FM, void>(
      "FiberMap",
      "awaitEmpty",
      1,
      (held) => FiberMap.awaitEmpty(held),
      none,
      "waits for the fibers of a FiberMap, which never end",
    ),
    "effect/Cache:make": ([given_], site) => {
      const fields = given_?._tag === "Obj" && !given_.brand ? given_.fields : undefined;
      const lookup = fields?.lookup;
      if (
        !fields ||
        !lookup ||
        !Object.keys(fields).every((key) => ["lookup", "capacity", "timeToLive"].includes(key))
      )
        return wrongArguments(site, "Cache.make");
      return Effect.succeed(
        timed(
          "Cache.make",
          (timeline) =>
            Effect.gen(function* () {
              const size = yield* count("Cache.make", fields.capacity, site);
              const timeToLive = fields.timeToLive
                ? yield* written("Cache.make", fields.timeToLive, site)
                : undefined;
              const held = yield* Cache.make<Key, V, Held>({
                capacity: size,
                timeToLive,
                lookup: (key) => called(timeline, lookup, site)(keyed(key)),
              });
              return wrap("Cache", held);
            }),
          site,
        ),
      );
    },
    "effect/Cache:get": byKey<C, V>(
      "Cache",
      "get",
      2,
      (held, key) => Effect.succeed(Cache.get(held, key)),
      same,
    ),
    "effect/Cache:getOption": byKey<C, Option.Option<V>>(
      "Cache",
      "getOption",
      2,
      (held, key) => Effect.succeed(Cache.getOption(held, key)),
      option,
    ),
    "effect/Cache:set": byKey<C, void>(
      "Cache",
      "set",
      3,
      (held, key, [value]) => Effect.succeed(Cache.set(held, key, value ?? Value.undef)),
      none,
    ),
    "effect/Cache:has": byKey<C, boolean>(
      "Cache",
      "has",
      2,
      (held, key) => Effect.succeed(Cache.has(held, key)),
      bool,
    ),
    "effect/Cache:invalidate": byKey<C, void>(
      "Cache",
      "invalidate",
      2,
      (held, key) => Effect.succeed(Cache.invalidate(held, key)),
      none,
    ),
    "effect/Cache:refresh": byKey<C, V>(
      "Cache",
      "refresh",
      2,
      (held, key) => Effect.succeed(Cache.refresh(held, key)),
      same,
    ),
    "effect/Cache:invalidateAll": on<C, void>(
      "Cache",
      "invalidateAll",
      1,
      (held) => Cache.invalidateAll(held),
      none,
    ),
    "effect/Cache:size": on<C, number>("Cache", "size", 1, (held) => Cache.size(held), num),
    "effect/Pool:make": ([given_], site) => {
      const fields = given_?._tag === "Obj" && !given_.brand ? given_.fields : undefined;
      const acquire = fields?.acquire;
      if (
        !fields ||
        acquire?._tag !== "Effect" ||
        !Object.keys(fields).every((key) => ["acquire", "size"].includes(key))
      )
        return wrongArguments(site, "Pool.make");
      return Effect.succeed(
        scoped(
          "Pool.make",
          site,
          (timeline) =>
            Effect.flatMap(Timeline.real(timeline, count("Pool.make", fields.size, site)), (size) =>
              Pool.make({ acquire: Timeline.real(timeline, acquire.run), size }),
            ),
          (held) => wrap("Pool", held),
        ),
      );
    },
    "effect/Pool:get": ([self], site) => {
      const held = heldOf<PL>("Pool", self);
      return held
        ? Effect.succeed(
            scoped(
              "Pool.get",
              site,
              (timeline) =>
                Timeline.waiting(
                  timeline,
                  "waits for an item of a Pool that nothing gives back",
                  site,
                  Pool.get(held),
                ),
              same,
            ),
          )
        : wrongArguments(site, "Pool.get");
    },
    "effect/Pool:invalidate": on<PL, void>(
      "Pool",
      "invalidate",
      2,
      (held, [item]) => Pool.invalidate(held, item ?? Value.undef),
      none,
    ),
  };

  // ---- The rest of what a transaction shares, and what is shared by a key.

  type TD = TxDeferred.TxDeferred<V, Held>;
  type TS = TxSemaphore.TxSemaphore;
  type TP = TxPubSub.TxPubSub<V>;
  type TSR = TxSubscriptionRef.TxSubscriptionRef<V>;
  type TL = TxReentrantLock.TxReentrantLock;
  type PS = PartitionedSemaphore.PartitionedSemaphore<Key>;
  type SC = ScopedCache.ScopedCache<Key, V, Held>;

  /**
   * A function that runs an effect of the code inside what one of these
   * holds: `f(self, ...given, effect)`, or `f(self, ...given)` then the effect.
   */
  const around2 = <H, A>(
    kind: Kind,
    name: string,
    takes: number,
    read: (rest: ReadonlyArray<V>, site: Site) => Eval<ReadonlyArray<unknown>>,
    wrapped: (
      held: H,
      given_: ReadonlyArray<unknown>,
      effect: Effect.Effect<V, Held>,
    ) => Effect.Effect<A, unknown>,
    give: (value: A) => V,
    wait: string,
  ): Model => {
    const label = `${kind}.${name}`;
    const start = (
      held: H,
      given_: ReadonlyArray<unknown>,
      effect: V | undefined,
      site: Site,
    ): Eval<V> =>
      effect?._tag === "Effect"
        ? Effect.succeed(
            timed(
              label,
              (timeline) =>
                Timeline.back(
                  timeline,
                  Timeline.waiting(
                    timeline,
                    wait,
                    site,
                    wrapped(held, given_, Timeline.real(timeline, effect.run)),
                  ),
                  give,
                ),
              site,
            ),
          )
        : wrongArguments(site, label);
    return ([self, ...rest], site) => {
      const held = heldOf<H>(kind, self);
      // `f(effect)` then the one that holds it, where the function takes nothing else.
      if (held === undefined && takes === 0 && self?._tag === "Effect" && rest.length === 0)
        return Effect.succeed(
          native(label, ([holder], at) => {
            const found = heldOf<H>(kind, holder);
            return found === undefined ? wrongArguments(at, label) : start(found, [], self, at);
          }),
        );
      if (held === undefined) return wrongArguments(site, label);
      return Effect.flatMap(read(rest.slice(0, takes), site), (given_) =>
        rest.length > takes
          ? start(held, given_, rest[takes], site)
          : Effect.succeed(native(label, ([effect], at) => start(held, given_, effect, at))),
      );
    };
  };

  const nothing = (): Eval<ReadonlyArray<unknown>> => Effect.succeed([]);
  const oneCount =
    (name: string) =>
    ([n]: ReadonlyArray<V>, site: Site): Eval<ReadonlyArray<unknown>> =>
      Effect.map(permits(name, n, site), (found) => [found]);

  /** What a function of the code makes of what a `TxSubscriptionRef` holds, in one transaction. */
  const subscribed = (name: string, give: (before: V, after: V) => V): Model =>
    dual(`TxSubscriptionRef.${name}`, 2, ([self, f], site) => {
      const held = heldOf<TSR>("TxSubscriptionRef", self);
      return held && f
        ? Effect.succeed(
            timed(
              `TxSubscriptionRef.${name}`,
              (timeline) =>
                Timeline.back(
                  timeline,
                  held.pipe(
                    TxSubscriptionRef.get,
                    Effect.flatMap((before) =>
                      Effect.map(
                        Timeline.real(timeline, host.call(f, [before], site)),
                        (after) => ({
                          before,
                          after,
                        }),
                      ),
                    ),
                    Effect.flatMap((read) =>
                      Effect.as(
                        TxSubscriptionRef.set(held, read.after),
                        give(read.before, read.after),
                      ),
                    ),
                    Effect.tx,
                  ),
                  same,
                ),
              site,
            ),
          )
        : wrongArguments(site, `TxSubscriptionRef.${name}`);
    });

  const TX_PERMITS = "waits for permits of a TxSemaphore that nothing releases";
  const TX_LOCK = "waits for a TxReentrantLock that nothing releases";
  const PARTITION = "waits for permits of a PartitionedSemaphore that nothing releases";

  const cacheOptions = (
    name: string,
    given_: V | undefined,
    site: Site,
  ): Eval<{
    readonly lookup: V;
    readonly capacity: number;
    readonly timeToLive?: Duration.Duration;
  }> => {
    const fields = given_?._tag === "Obj" && !given_.brand ? given_.fields : undefined;
    const lookup = fields?.lookup;
    if (
      !fields ||
      !lookup ||
      !Object.keys(fields).every((key) => ["lookup", "capacity", "timeToLive"].includes(key))
    )
      return wrongArguments(site, name);
    return Effect.gen(function* () {
      const size = yield* count(name, fields.capacity, site);
      return fields.timeToLive
        ? { lookup, capacity: size, timeToLive: yield* written(name, fields.timeToLive, site) }
        : { lookup, capacity: size };
    });
  };

  const shared: Models = {
    "effect/TxDeferred:make": made("TxDeferred", () => TxDeferred.make<V, Held>()),
    "effect/TxDeferred:succeed": on<TD, boolean>(
      "TxDeferred",
      "succeed",
      2,
      (held, [value]) => TxDeferred.succeed(held, value ?? Value.undef),
      bool,
    ),
    "effect/TxDeferred:fail": on<TD, boolean>(
      "TxDeferred",
      "fail",
      2,
      (held, [error]) =>
        TxDeferred.fail(held, new Value.Rejected({ rejection: error ?? Value.undef })),
      bool,
    ),
    "effect/TxDeferred:await": on<TD, V>(
      "TxDeferred",
      "await",
      1,
      (held) => TxDeferred.await(held),
      same,
      "waits for a TxDeferred that nothing completes",
    ),
    "effect/TxDeferred:poll": on<TD, Option.Option<Result.Result<V, Held>>>(
      "TxDeferred",
      "poll",
      1,
      (held) => TxDeferred.poll(held),
      (found) =>
        Option.isSome(found)
          ? Value.some(
              Result.isSuccess(found.value)
                ? Brands.success(found.value.success)
                : Brands.failure(found.value.failure.rejection),
            )
          : Value.none,
    ),
    "effect/TxSemaphore:make": made("TxSemaphore", ([n], site) =>
      Effect.flatMap(permits("TxSemaphore.make", n, site), (found) => TxSemaphore.make(found)),
    ),
    "effect/TxSemaphore:available": on<TS, number>(
      "TxSemaphore",
      "available",
      1,
      (held) => TxSemaphore.available(held),
      num,
    ),
    "effect/TxSemaphore:capacity": on<TS, number>(
      "TxSemaphore",
      "capacity",
      1,
      (held) => TxSemaphore.capacity(held),
      num,
    ),
    "effect/TxSemaphore:acquire": on<TS, void>(
      "TxSemaphore",
      "acquire",
      1,
      (held) => TxSemaphore.acquire(held),
      none,
      TX_PERMITS,
    ),
    "effect/TxSemaphore:acquireN": later<TS, void>(
      "TxSemaphore",
      "acquireN",
      2,
      (held, [n], site) =>
        Effect.map(permits("TxSemaphore.acquireN", n, site), (found) =>
          TxSemaphore.acquireN(held, found),
        ),
      none,
      TX_PERMITS,
    ),
    "effect/TxSemaphore:tryAcquire": on<TS, boolean>(
      "TxSemaphore",
      "tryAcquire",
      1,
      (held) => TxSemaphore.tryAcquire(held),
      bool,
    ),
    "effect/TxSemaphore:tryAcquireN": later<TS, boolean>(
      "TxSemaphore",
      "tryAcquireN",
      2,
      (held, [n], site) =>
        Effect.map(permits("TxSemaphore.tryAcquireN", n, site), (found) =>
          TxSemaphore.tryAcquireN(held, found),
        ),
      bool,
    ),
    "effect/TxSemaphore:release": on<TS, void>(
      "TxSemaphore",
      "release",
      1,
      (held) => TxSemaphore.release(held),
      none,
    ),
    "effect/TxSemaphore:releaseN": later<TS, void>(
      "TxSemaphore",
      "releaseN",
      2,
      (held, [n], site) =>
        Effect.map(permits("TxSemaphore.releaseN", n, site), (found) =>
          TxSemaphore.releaseN(held, found),
        ),
      none,
    ),
    "effect/TxSemaphore:withPermit": around2<TS, V>(
      "TxSemaphore",
      "withPermit",
      0,
      nothing,
      (held, _, effect) => TxSemaphore.withPermit(held, effect),
      same,
      TX_PERMITS,
    ),
    "effect/TxSemaphore:withPermits": around2<TS, V>(
      "TxSemaphore",
      "withPermits",
      1,
      oneCount("TxSemaphore.withPermits"),
      (held, [n], effect) => TxSemaphore.withPermits(held, n as number, effect),
      same,
      TX_PERMITS,
    ),
    "effect/TxPubSub:unbounded": made("TxPubSub", () => TxPubSub.unbounded<V>()),
    "effect/TxPubSub:bounded": made("TxPubSub", ([size], site) =>
      Effect.flatMap(capacity("TxPubSub.bounded", size, site), (n) => TxPubSub.bounded<V>(n)),
    ),
    "effect/TxPubSub:dropping": made("TxPubSub", ([size], site) =>
      Effect.flatMap(capacity("TxPubSub.dropping", size, site), (n) => TxPubSub.dropping<V>(n)),
    ),
    "effect/TxPubSub:sliding": made("TxPubSub", ([size], site) =>
      Effect.flatMap(capacity("TxPubSub.sliding", size, site), (n) => TxPubSub.sliding<V>(n)),
    ),
    "effect/TxPubSub:publish": on<TP, boolean>(
      "TxPubSub",
      "publish",
      2,
      (held, [value]) => TxPubSub.publish(held, value ?? Value.undef),
      bool,
      "publishes to a full TxPubSub that nothing takes from",
    ),
    "effect/TxPubSub:publishAll": later<TP, boolean>(
      "TxPubSub",
      "publishAll",
      2,
      (held, [values], site) =>
        Effect.map(items("TxPubSub.publishAll", values, site), (found) =>
          TxPubSub.publishAll(held, found),
        ),
      bool,
    ),
    "effect/TxPubSub:subscribe": ([self], site) => {
      const held = heldOf<TP>("TxPubSub", self);
      return held
        ? Effect.succeed(
            scoped(
              "TxPubSub.subscribe",
              site,
              () => TxPubSub.subscribe(held),
              (queue) => wrap("TxQueue", queue),
            ),
          )
        : wrongArguments(site, "TxPubSub.subscribe");
    },
    "effect/TxPubSub:size": on<TP, number>(
      "TxPubSub",
      "size",
      1,
      (held) => TxPubSub.size(held),
      num,
    ),
    "effect/TxPubSub:isEmpty": on<TP, boolean>(
      "TxPubSub",
      "isEmpty",
      1,
      (held) => TxPubSub.isEmpty(held),
      bool,
    ),
    "effect/TxPubSub:isFull": on<TP, boolean>(
      "TxPubSub",
      "isFull",
      1,
      (held) => TxPubSub.isFull(held),
      bool,
    ),
    "effect/TxPubSub:shutdown": on<TP, void>(
      "TxPubSub",
      "shutdown",
      1,
      (held) => TxPubSub.shutdown(held),
      none,
    ),
    "effect/TxPubSub:isShutdown": on<TP, boolean>(
      "TxPubSub",
      "isShutdown",
      1,
      (held) => TxPubSub.isShutdown(held),
      bool,
    ),
    "effect/TxSubscriptionRef:make": made("TxSubscriptionRef", ([value]) =>
      TxSubscriptionRef.make<V>(value ?? Value.undef),
    ),
    "effect/TxSubscriptionRef:get": on<TSR, V>(
      "TxSubscriptionRef",
      "get",
      1,
      (held) => TxSubscriptionRef.get(held),
      same,
    ),
    "effect/TxSubscriptionRef:set": on<TSR, void>(
      "TxSubscriptionRef",
      "set",
      2,
      (held, [value]) => TxSubscriptionRef.set(held, value ?? Value.undef),
      none,
    ),
    "effect/TxSubscriptionRef:getAndSet": on<TSR, V>(
      "TxSubscriptionRef",
      "getAndSet",
      2,
      (held, [value]) => TxSubscriptionRef.getAndSet(held, value ?? Value.undef),
      same,
    ),
    "effect/TxSubscriptionRef:update": subscribed("update", () => Value.undef),
    "effect/TxSubscriptionRef:updateAndGet": subscribed("updateAndGet", (_, after) => after),
    "effect/TxSubscriptionRef:getAndUpdate": subscribed("getAndUpdate", (before) => before),
    "effect/TxSubscriptionRef:changes": ([self], site) => {
      const held = heldOf<TSR>("TxSubscriptionRef", self);
      return held
        ? Effect.succeed(
            scoped(
              "TxSubscriptionRef.changes",
              site,
              () => TxSubscriptionRef.changes(held),
              (queue) => wrap("TxQueue", queue),
            ),
          )
        : wrongArguments(site, "TxSubscriptionRef.changes");
    },
    "effect/TxReentrantLock:make": made("TxReentrantLock", () => TxReentrantLock.make()),
    "effect/TxReentrantLock:acquireRead": on<TL, number>(
      "TxReentrantLock",
      "acquireRead",
      1,
      (held) => TxReentrantLock.acquireRead(held),
      num,
      TX_LOCK,
    ),
    "effect/TxReentrantLock:acquireWrite": on<TL, number>(
      "TxReentrantLock",
      "acquireWrite",
      1,
      (held) => TxReentrantLock.acquireWrite(held),
      num,
      TX_LOCK,
    ),
    "effect/TxReentrantLock:releaseRead": on<TL, number>(
      "TxReentrantLock",
      "releaseRead",
      1,
      (held) => TxReentrantLock.releaseRead(held),
      num,
    ),
    "effect/TxReentrantLock:releaseWrite": on<TL, number>(
      "TxReentrantLock",
      "releaseWrite",
      1,
      (held) => TxReentrantLock.releaseWrite(held),
      num,
    ),
    "effect/TxReentrantLock:readLocks": on<TL, number>(
      "TxReentrantLock",
      "readLocks",
      1,
      (held) => TxReentrantLock.readLocks(held),
      num,
    ),
    "effect/TxReentrantLock:writeLocks": on<TL, number>(
      "TxReentrantLock",
      "writeLocks",
      1,
      (held) => TxReentrantLock.writeLocks(held),
      num,
    ),
    "effect/TxReentrantLock:locked": on<TL, boolean>(
      "TxReentrantLock",
      "locked",
      1,
      (held) => TxReentrantLock.locked(held),
      bool,
    ),
    "effect/TxReentrantLock:readLocked": on<TL, boolean>(
      "TxReentrantLock",
      "readLocked",
      1,
      (held) => TxReentrantLock.readLocked(held),
      bool,
    ),
    "effect/TxReentrantLock:writeLocked": on<TL, boolean>(
      "TxReentrantLock",
      "writeLocked",
      1,
      (held) => TxReentrantLock.writeLocked(held),
      bool,
    ),
    "effect/TxReentrantLock:withReadLock": around2<TL, V>(
      "TxReentrantLock",
      "withReadLock",
      0,
      nothing,
      (held, _, effect) => TxReentrantLock.withReadLock(held, effect),
      same,
      TX_LOCK,
    ),
    "effect/TxReentrantLock:withWriteLock": around2<TL, V>(
      "TxReentrantLock",
      "withWriteLock",
      0,
      nothing,
      (held, _, effect) => TxReentrantLock.withWriteLock(held, effect),
      same,
      TX_LOCK,
    ),
    "effect/TxReentrantLock:withLock": around2<TL, V>(
      "TxReentrantLock",
      "withLock",
      0,
      nothing,
      (held, _, effect) => TxReentrantLock.withLock(held, effect),
      same,
      TX_LOCK,
    ),
    "effect/PartitionedSemaphore:make": made("PartitionedSemaphore", ([given_], site) =>
      Effect.flatMap(
        options<{ permits: number }>("PartitionedSemaphore.make", given_, site),
        (read) => PartitionedSemaphore.make<Key>(read),
      ),
    ),
    "effect/PartitionedSemaphore:available": on<PS, number>(
      "PartitionedSemaphore",
      "available",
      1,
      (held) => PartitionedSemaphore.available(held),
      num,
    ),
    "effect/PartitionedSemaphore:take": later<PS, void>(
      "PartitionedSemaphore",
      "take",
      3,
      (held, [key, n], site) =>
        Effect.flatMap(keyOf("PartitionedSemaphore.take", key, site), (read) =>
          Effect.map(permits("PartitionedSemaphore.take", n, site), (found) =>
            PartitionedSemaphore.take(held, read, found),
          ),
        ),
      none,
      PARTITION,
    ),
    "effect/PartitionedSemaphore:release": later<PS, number>(
      "PartitionedSemaphore",
      "release",
      2,
      (held, [n], site) =>
        Effect.map(permits("PartitionedSemaphore.release", n, site), (found) =>
          PartitionedSemaphore.release(held, found),
        ),
      num,
    ),
    "effect/PartitionedSemaphore:withPermits": around2<PS, V>(
      "PartitionedSemaphore",
      "withPermits",
      2,
      ([key, n], site) =>
        Effect.flatMap(keyOf("PartitionedSemaphore.withPermits", key, site), (read) =>
          Effect.map(permits("PartitionedSemaphore.withPermits", n, site), (found) => [
            read,
            found,
          ]),
        ),
      (held, [key, n], effect) =>
        PartitionedSemaphore.withPermits(held, key as Key, n as number, effect),
      same,
      PARTITION,
    ),
    "effect/PartitionedSemaphore:withPermit": around2<PS, V>(
      "PartitionedSemaphore",
      "withPermit",
      1,
      ([key], site) =>
        Effect.map(keyOf("PartitionedSemaphore.withPermit", key, site), (read) => [read]),
      (held, [key], effect) => PartitionedSemaphore.withPermit(held, key as Key, effect),
      same,
      PARTITION,
    ),
    "effect/ScopedCache:make": ([given_], site) =>
      Effect.succeed(
        scoped(
          "ScopedCache.make",
          site,
          (timeline) =>
            Effect.flatMap(
              Timeline.real(timeline, cacheOptions("ScopedCache.make", given_, site)),
              (read) =>
                ScopedCache.make<Key, V, Held>({
                  capacity: read.capacity,
                  timeToLive: read.timeToLive,
                  lookup: (key) => called(timeline, read.lookup, site)(keyed(key)),
                }),
            ),
          (held) => wrap("ScopedCache", held),
        ),
      ),
    "effect/ScopedCache:get": byKey<SC, V>(
      "ScopedCache",
      "get",
      2,
      (held, key) => Effect.succeed(ScopedCache.get(held, key)),
      same,
    ),
    "effect/ScopedCache:has": byKey<SC, boolean>(
      "ScopedCache",
      "has",
      2,
      (held, key) => Effect.succeed(ScopedCache.has(held, key)),
      bool,
    ),
    "effect/ScopedCache:set": byKey<SC, void>(
      "ScopedCache",
      "set",
      3,
      (held, key, [value]) => Effect.succeed(ScopedCache.set(held, key, value ?? Value.undef)),
      none,
    ),
    "effect/ScopedCache:invalidate": byKey<SC, void>(
      "ScopedCache",
      "invalidate",
      2,
      (held, key) => Effect.succeed(ScopedCache.invalidate(held, key)),
      none,
    ),
    "effect/ScopedCache:size": on<SC, number>(
      "ScopedCache",
      "size",
      1,
      (held) => ScopedCache.size(held),
      num,
    ),
    "effect/Pool:makeWithTTL": ([given_], site) => {
      const fields = given_?._tag === "Obj" && !given_.brand ? given_.fields : undefined;
      const acquire = fields?.acquire;
      if (!fields || acquire?._tag !== "Effect") return wrongArguments(site, "Pool.makeWithTTL");
      const { acquire: _, ...rest } = fields;
      return Effect.succeed(
        scoped(
          "Pool.makeWithTTL",
          site,
          (timeline) =>
            Effect.flatMap(
              Timeline.real(
                timeline,
                options<{
                  readonly min: number;
                  readonly max: number;
                  readonly timeToLive: Duration.Input;
                  readonly timeToLiveStrategy?: "creation" | "usage";
                }>("Pool.makeWithTTL", Value.obj(rest), site),
              ),
              (read) =>
                Pool.makeWithTTL({ ...read, acquire: Timeline.real(timeline, acquire.run) }),
            ),
          (held) => wrap("Pool", held),
        ),
      );
    },
  };

  // ---- A chunk in a transaction. The prover holds a chunk as a list, and the library is given one of its own.

  type TC = TxChunk.TxChunk<V>;

  const chunkOf = (name: string, v: V | undefined, site: Site): Eval<Chunk.Chunk<V>> =>
    Effect.map(items(name, v, site), (found) => Chunk.fromIterable(found));

  const listed = (chunk: Chunk.Chunk<V>): V => chunk.pipe(Chunk.toReadonlyArray, arr);

  /** What a function of the code makes of the chunk, in the transaction that reads it. */
  const rechunked = (
    name: string,
    made_: (
      chunk: ReadonlyArray<V>,
      f: V,
      site: Site,
    ) => Eval<{ readonly next: V; readonly gives: V }>,
  ): Model =>
    dual(`TxChunk.${name}`, 2, ([self, f], site) => {
      const held = heldOf<TC>("TxChunk", self);
      return held && f
        ? Effect.succeed(
            timed(
              `TxChunk.${name}`,
              (timeline) =>
                Timeline.back(
                  timeline,
                  held.pipe(
                    TxChunk.get,
                    Effect.flatMap((before) =>
                      Timeline.real(
                        timeline,
                        Effect.flatMap(made_(Chunk.toReadonlyArray(before), f, site), (read) =>
                          Effect.map(chunkOf(`TxChunk.${name}`, read.next, site), (next) => ({
                            next,
                            gives: read.gives,
                          })),
                        ),
                      ),
                    ),
                    Effect.flatMap((read) => Effect.as(TxChunk.set(held, read.next), read.gives)),
                    Effect.tx,
                  ),
                  same,
                ),
              site,
            ),
          )
        : wrongArguments(site, `TxChunk.${name}`);
    });

  /** A function of a chunk and a count the code writes. */
  const cutting = (
    name: string,
    cut: (held: TC, counts: ReadonlyArray<number>) => Effect.Effect<void>,
    takes: number,
  ): Model =>
    later<TC, void>(
      "TxChunk",
      name,
      takes + 1,
      (held, rest, site) =>
        Effect.map(
          Effect.forEach(rest.slice(0, takes), (n) => count(`TxChunk.${name}`, n, site)),
          (counts) => cut(held, counts),
        ),
      none,
    );

  const chunks: Models = {
    "effect/TxChunk:make": made("TxChunk", ([chunk], site) =>
      Effect.flatMap(chunkOf("TxChunk.make", chunk, site), (read) => TxChunk.make(read)),
    ),
    "effect/TxChunk:fromIterable": made("TxChunk", ([given_], site) =>
      Effect.flatMap(items("TxChunk.fromIterable", given_, site), (read) =>
        TxChunk.fromIterable(read),
      ),
    ),
    "effect/TxChunk:empty": made("TxChunk", () => TxChunk.empty<V>()),
    "effect/TxChunk:get": on<TC, Chunk.Chunk<V>>(
      "TxChunk",
      "get",
      1,
      (held) => TxChunk.get(held),
      listed,
    ),
    "effect/TxChunk:set": later<TC, void>(
      "TxChunk",
      "set",
      2,
      (held, [chunk], site) =>
        Effect.map(chunkOf("TxChunk.set", chunk, site), (read) => TxChunk.set(held, read)),
      none,
    ),
    "effect/TxChunk:append": on<TC, void>(
      "TxChunk",
      "append",
      2,
      (held, [value]) => TxChunk.append(held, value ?? Value.undef),
      none,
    ),
    "effect/TxChunk:prepend": on<TC, void>(
      "TxChunk",
      "prepend",
      2,
      (held, [value]) => TxChunk.prepend(held, value ?? Value.undef),
      none,
    ),
    "effect/TxChunk:appendAll": later<TC, void>(
      "TxChunk",
      "appendAll",
      2,
      (held, [chunk], site) =>
        Effect.map(chunkOf("TxChunk.appendAll", chunk, site), (read) =>
          TxChunk.appendAll(held, read),
        ),
      none,
    ),
    "effect/TxChunk:prependAll": later<TC, void>(
      "TxChunk",
      "prependAll",
      2,
      (held, [chunk], site) =>
        Effect.map(chunkOf("TxChunk.prependAll", chunk, site), (read) =>
          TxChunk.prependAll(held, read),
        ),
      none,
    ),
    "effect/TxChunk:concat": later<TC, void>(
      "TxChunk",
      "concat",
      2,
      (held, [other], site) => {
        const that = heldOf<TC>("TxChunk", other);
        return that
          ? Effect.succeed(TxChunk.concat(held, that))
          : wrongArguments(site, "TxChunk.concat");
      },
      none,
    ),
    "effect/TxChunk:size": on<TC, number>("TxChunk", "size", 1, (held) => TxChunk.size(held), num),
    "effect/TxChunk:isEmpty": on<TC, boolean>(
      "TxChunk",
      "isEmpty",
      1,
      (held) => TxChunk.isEmpty(held),
      bool,
    ),
    "effect/TxChunk:isNonEmpty": on<TC, boolean>(
      "TxChunk",
      "isNonEmpty",
      1,
      (held) => TxChunk.isNonEmpty(held),
      bool,
    ),
    "effect/TxChunk:take": cutting("take", (held, [n]) => TxChunk.take(held, n!), 1),
    "effect/TxChunk:drop": cutting("drop", (held, [n]) => TxChunk.drop(held, n!), 1),
    "effect/TxChunk:slice": cutting(
      "slice",
      (held, [start, end]) => TxChunk.slice(held, start!, end!),
      2,
    ),
    "effect/TxChunk:update": rechunked("update", (chunk, f, site) =>
      Effect.map(host.call(f, [arr(chunk)], site), (next) => ({ next, gives: Value.undef })),
    ),
    "effect/TxChunk:modify": rechunked("modify", (chunk, f, site) =>
      Effect.flatMap(host.call(f, [arr(chunk)], site), (pair) => {
        const read = kit.itemsOf(pair);
        return read && read.length === 2
          ? Effect.succeed({ gives: read[0]!, next: read[1]! })
          : wrongArguments(site, "TxChunk.modify");
      }),
    ),
    "effect/TxChunk:map": rechunked("map", (chunk, f, site) =>
      Effect.map(
        Effect.forEach(chunk, (item) => host.call(f, [item], site)),
        (next) => ({ next: arr(next), gives: Value.undef }),
      ),
    ),
    "effect/TxChunk:filter": rechunked("filter", (chunk, f, site) =>
      Effect.map(
        Effect.filter(chunk, (item) => kit.holds(f, [item], site)),
        (next) => ({ next: arr(next), gives: Value.undef }),
      ),
    ),
  };

  // ---- Requests: asked for one at a time, answered a batch at a time.

  type Asked = Request.Request<V, Held> & Record<string, unknown>;
  type Answering = RequestResolver.RequestResolver<Asked>;
  /** A resolver is made of functions of the code, so it is made for the handler that uses it. */
  type Resolver = (timeline: Timeline.Timeline) => Answering;

  /** A request is found by what it asks for, so the prover has to know what that is. */
  const asking = (name: string, build: (fields: object) => Asked): V =>
    native(name, ([given_], site) => {
      const fields = plainOf(given_ ?? Value.obj({}));
      return fields === NOT_PLAIN || typeof fields !== "object" || fields === null
        ? unseen(site, `makes a ${name} request of values the prover cannot see`)
        : Effect.succeed(wrap("Request", build(fields)));
    });

  const entryOf = (entry: Request.Entry<Asked>): V => wrap("Entry", entry);

  /** One resolver for each handler that uses it: it remembers the requests of that handler only. */
  const resolving = (make_: (timeline: Timeline.Timeline) => Answering): V => {
    const made_ = new WeakMap<Timeline.Timeline, Answering>();
    const resolver: Resolver = (timeline) => {
      const known = made_.get(timeline);
      if (known) return known;
      const fresh = make_(timeline);
      made_.set(timeline, fresh);
      return fresh;
    };
    return wrap("Resolver", resolver);
  };

  const onEntry = (
    name: string,
    answer: (
      entry: Request.Entry<Asked>,
      rest: ReadonlyArray<V>,
      timeline: Timeline.Timeline,
      site: Site,
    ) => Effect.Effect<void, unknown> | undefined,
  ): Model =>
    dual(`Request.${name}`, 2, ([self, ...rest], site) => {
      const held = heldOf<Request.Entry<Asked>>("Entry", self);
      return held
        ? Effect.succeed(
            timed(
              `Request.${name}`,
              (timeline) => {
                const made_ = answer(held, rest, timeline, site);
                return made_
                  ? Timeline.back(timeline, made_, none)
                  : wrongArguments(site, `Request.${name}`);
              },
              site,
            ),
          )
        : wrongArguments(site, `Request.${name}`);
    });

  const requests: Record<string, Model> = {
    "effect/Request:tagged": ([tag], site) =>
      tag?._tag === "Str"
        ? Effect.succeed(
            asking(tag.value, (fields) =>
              Request.tagged<Asked & { _tag: string }>(tag.value)(fields as never),
            ),
          )
        : wrongArguments(site, "Request.tagged"),
    "effect/Request:of": () =>
      Effect.succeed(asking("Request.of", (fields) => Request.of<Asked>()(fields as never))),
    "effect/Request:succeed": onEntry("succeed", (entry, [value]) =>
      Request.succeed(entry, value ?? Value.undef),
    ),
    "effect/Request:fail": onEntry("fail", (entry, [error]) =>
      Request.fail(entry, new Value.Rejected({ rejection: error ?? Value.undef })),
    ),
    "effect/Request:completeEffect": onEntry(
      "completeEffect",
      (entry, [effect], timeline, site) => {
        const given_ = effectOf(timeline, effect, site);
        return given_ ? Request.completeEffect(entry, given_) : undefined;
      },
    ),
    "effect/RequestResolver:make": ([runAll], site) =>
      runAll && callable(runAll)
        ? Effect.succeed(
            resolving((timeline) =>
              RequestResolver.make<Asked>((entries) =>
                Effect.asVoid(called(timeline, runAll, site)(arr(entries.map(entryOf)))),
              ),
            ),
          )
        : wrongArguments(site, "RequestResolver.make"),
    "effect/RequestResolver:fromEffect": ([f], site) =>
      f && callable(f)
        ? Effect.succeed(
            resolving((timeline) =>
              RequestResolver.fromEffect<Asked>((entry) =>
                called(timeline, f, site)(entryOf(entry)),
              ),
            ),
          )
        : wrongArguments(site, "RequestResolver.fromEffect"),
    "effect/RequestResolver:batchN": dual("RequestResolver.batchN", 2, ([self, n], site) => {
      const held = heldOf<Resolver>("Resolver", self);
      return held
        ? Effect.map(count("RequestResolver.batchN", n, site), (size) =>
            resolving((timeline) => RequestResolver.batchN(held(timeline), size)),
          )
        : wrongArguments(site, "RequestResolver.batchN");
    }),
    "effect/RequestResolver:setDelay": dual(
      "RequestResolver.setDelay",
      2,
      ([self, duration], site) => {
        const held = heldOf<Resolver>("Resolver", self);
        return held
          ? Effect.map(written("RequestResolver.setDelay", duration, site), (time) =>
              resolving((timeline) => RequestResolver.setDelay(held(timeline), time)),
            )
          : wrongArguments(site, "RequestResolver.setDelay");
      },
    ),
    // `Effect.request(request, resolver)`, or `Effect.request(resolver)` then the request.
    "effect/Effect:request": (args, site) => {
      const ask = (request: V | undefined, resolver: V | undefined, at: Site): Eval<V> => {
        const asked = heldOf<Asked>("Request", request);
        const held = heldOf<Resolver>("Resolver", resolver);
        return asked && held
          ? Effect.succeed(
              timed(
                "Effect.request",
                (timeline) =>
                  Timeline.back(
                    timeline,
                    Timeline.waiting(
                      timeline,
                      "waits for a request that its resolver never answers",
                      at,
                      Effect.request(asked, held(timeline)),
                    ),
                    same,
                  ),
                at,
              ),
            )
          : wrongArguments(at, "Effect.request");
      };
      return args.length >= 2
        ? ask(args[0], args[1], site)
        : Effect.succeed(native("Effect.request", ([request], at) => ask(request, args[0], at)));
    },
  };

  // ---- A hash map, a hash set and a priority queue in a transaction.
  // Each is a `TxRef` of the collection, as the library has it: the collection is the prover's own,
  // so a key an input decides is read as it is in a `HashMap`.

  interface Store {
    readonly ref: TxRef.TxRef<V>;
    /** How a priority queue puts its items in order. */
    readonly order?: V;
  }
  type StoreKind = "TxHashMap" | "TxHashSet" | "TxPriorityQueue";

  /** A function of the library the prover has a model for, by `module:name`. */
  const lib = (key: string, args: ReadonlyArray<V>, site: Site): Eval<V> => {
    const model = base[key];
    return model ? model(args, site) : wrongArguments(site, key);
  };

  const storing = (kind: StoreKind, collection: Eval<V>, order?: V): V =>
    lazy(() =>
      Effect.flatMap(collection, (held) =>
        Effect.map(TxRef.make(held), (ref) => wrap(kind, order ? { ref, order } : { ref })),
      ),
    );

  /**
   * A function of one of these: `step` says what it gives of what the store
   * holds, what the store holds after, or that it waits for the store to change.
   */
  const stored = (
    kind: StoreKind,
    name: string,
    step: (
      before: V,
      rest: ReadonlyArray<V>,
      site: Site,
      store: Store,
    ) => Eval<{ readonly next?: V; readonly gives: V } | "retry">,
    /** How many arguments it takes, when another is a store too: which comes first is then counted. */
    arity?: number,
  ): Model =>
    (arity === undefined
      ? (body: Model) => dualBy(`${kind}.${name}`, (v) => kindOf(v) === kind, body)
      : (body: Model) => dual(`${kind}.${name}`, arity, body))(([self, ...rest], site) => {
      const store = heldOf<Store>(kind, self);
      return store
        ? Effect.succeed(
            timed(
              `${kind}.${name}`,
              (timeline) =>
                Timeline.back(
                  timeline,
                  Timeline.waiting(
                    timeline,
                    `waits for a ${kind} that nothing changes`,
                    site,
                    store.ref.pipe(
                      TxRef.get,
                      Effect.flatMap((before) =>
                        Timeline.real(timeline, step(before, rest, site, store)),
                      ),
                      Effect.flatMap((read) =>
                        read === "retry"
                          ? Effect.txRetry
                          : read.next
                            ? Effect.as(TxRef.set(store.ref, read.next), read.gives)
                            : Effect.succeed(read.gives),
                      ),
                      Effect.tx,
                    ),
                  ),
                  same,
                ),
              site,
            ),
          )
        : wrongArguments(site, `${kind}.${name}`);
    });

  /** A function that reads the collection as the prover's model of it does. */
  const reads = (kind: StoreKind, name: string, key: string, listed_ = false): Model =>
    stored(kind, name, (before, rest, site) =>
      Effect.flatMap(lib(key, [before, ...rest], site), (made_) =>
        listed_
          ? Effect.map(lib("effect/Array:fromIterable", [made_], site), (gives) => ({ gives }))
          : Effect.succeed({ gives: made_ }),
      ),
    );

  /** A function that changes the collection as the prover's model of it does. */
  const writes = (kind: StoreKind, name: string, key: string): Model =>
    stored(kind, name, (before, rest, site) =>
      Effect.map(lib(key, [before, ...rest], site), (next) => ({ next, gives: Value.undef })),
    );

  /** A function that gives a new store of what the prover's model makes of this one. */
  const derives = (kind: StoreKind, name: string, key: string, arity?: number): Model =>
    stored(
      kind,
      name,
      (before, rest, site) =>
        Effect.flatMap(
          Effect.forEach(rest, (each) => {
            const other = heldOf<Store>(kind, each);
            return other ? TxRef.get(other.ref) : Effect.succeed(each);
          }),
          (given_) =>
            Effect.flatMap(lib(key, [before, ...given_], site), (made_) =>
              Effect.map(TxRef.make(made_), (ref) => ({ gives: wrap(kind, { ref }) })),
            ),
        ),
      arity,
    );

  const not = (v: V, site: Site): Eval<V> =>
    Effect.map(host.decide(v, site), (held) => bool(!held));

  const itemsOf_ = (v: V): ReadonlyArray<V> => kit.itemsOf(v) ?? [];
  const sorted = (itemsNow: ReadonlyArray<V>, store: Store, site: Site): Eval<V> =>
    lib("effect/Array:sort", [arr(itemsNow), store.order ?? Value.undef], site);

  const queueOf = (
    name: string,
    order: V | undefined,
    given_: Eval<ReadonlyArray<V>>,
    site: Site,
  ): V =>
    order
      ? storing(
          "TxPriorityQueue",
          Effect.flatMap(given_, (found) => lib("effect/Array:sort", [arr(found), order], site)),
          order,
        )
      : lazy(() => wrongArguments(site, name));

  const stores: Models = {
    "effect/TxHashMap:empty": (_, site) =>
      Effect.succeed(storing("TxHashMap", lib("effect/HashMap:empty", [], site))),
    "effect/TxHashMap:make": (args, site) =>
      Effect.succeed(storing("TxHashMap", lib("effect/HashMap:make", args, site))),
    "effect/TxHashMap:fromIterable": (args, site) =>
      Effect.succeed(storing("TxHashMap", lib("effect/HashMap:fromIterable", args, site))),
    "effect/TxHashMap:get": reads("TxHashMap", "get", "effect/HashMap:get"),
    "effect/TxHashMap:has": reads("TxHashMap", "has", "effect/HashMap:has"),
    "effect/TxHashMap:size": reads("TxHashMap", "size", "effect/HashMap:size"),
    "effect/TxHashMap:isEmpty": reads("TxHashMap", "isEmpty", "effect/HashMap:isEmpty"),
    "effect/TxHashMap:isNonEmpty": stored("TxHashMap", "isNonEmpty", (before, _, site) =>
      Effect.flatMap(lib("effect/HashMap:isEmpty", [before], site), (empty) =>
        Effect.map(not(empty, site), (gives) => ({ gives })),
      ),
    ),
    "effect/TxHashMap:keys": reads("TxHashMap", "keys", "effect/HashMap:keys", true),
    "effect/TxHashMap:values": reads("TxHashMap", "values", "effect/HashMap:values", true),
    "effect/TxHashMap:toValues": reads("TxHashMap", "toValues", "effect/HashMap:values", true),
    "effect/TxHashMap:entries": reads("TxHashMap", "entries", "effect/HashMap:entries", true),
    "effect/TxHashMap:toEntries": reads("TxHashMap", "toEntries", "effect/HashMap:entries", true),
    "effect/TxHashMap:some": reads("TxHashMap", "some", "effect/HashMap:some"),
    "effect/TxHashMap:every": reads("TxHashMap", "every", "effect/HashMap:every"),
    "effect/TxHashMap:hasBy": reads("TxHashMap", "hasBy", "effect/HashMap:hasBy"),
    "effect/TxHashMap:findFirst": reads("TxHashMap", "findFirst", "effect/HashMap:findFirst"),
    "effect/TxHashMap:reduce": reads("TxHashMap", "reduce", "effect/HashMap:reduce"),
    "effect/TxHashMap:snapshot": stored("TxHashMap", "snapshot", (before) =>
      Effect.succeed({ gives: before }),
    ),
    "effect/TxHashMap:set": writes("TxHashMap", "set", "effect/HashMap:set"),
    "effect/TxHashMap:setMany": writes("TxHashMap", "setMany", "effect/HashMap:setMany"),
    "effect/TxHashMap:removeMany": writes("TxHashMap", "removeMany", "effect/HashMap:removeMany"),
    "effect/TxHashMap:union": writes("TxHashMap", "union", "effect/HashMap:union"),
    "effect/TxHashMap:modifyAt": writes("TxHashMap", "modifyAt", "effect/HashMap:modifyAt"),
    "effect/TxHashMap:clear": stored("TxHashMap", "clear", (_, __, site) =>
      Effect.map(lib("effect/HashMap:empty", [], site), (next) => ({ next, gives: Value.undef })),
    ),
    // Whether the key was there.
    "effect/TxHashMap:remove": stored("TxHashMap", "remove", (before, rest, site) =>
      Effect.flatMap(lib("effect/HashMap:has", [before, ...rest], site), (gives) =>
        Effect.map(lib("effect/HashMap:remove", [before, ...rest], site), (next) => ({
          next,
          gives,
        })),
      ),
    ),
    // What the key held before.
    "effect/TxHashMap:modify": stored("TxHashMap", "modify", (before, rest, site) =>
      Effect.flatMap(lib("effect/HashMap:get", [before, rest[0] ?? Value.undef], site), (gives) =>
        Effect.map(lib("effect/HashMap:modify", [before, ...rest], site), (next) => ({
          next,
          gives,
        })),
      ),
    ),
    "effect/TxHashMap:map": derives("TxHashMap", "map", "effect/HashMap:map"),
    "effect/TxHashMap:filter": derives("TxHashMap", "filter", "effect/HashMap:filter"),
    "effect/TxHashSet:empty": (_, site) =>
      Effect.succeed(storing("TxHashSet", lib("effect/HashSet:empty", [], site))),
    "effect/TxHashSet:make": (args, site) =>
      Effect.succeed(storing("TxHashSet", lib("effect/HashSet:make", args, site))),
    "effect/TxHashSet:fromIterable": (args, site) =>
      Effect.succeed(storing("TxHashSet", lib("effect/HashSet:fromIterable", args, site))),
    "effect/TxHashSet:fromHashSet": ([set]) =>
      Effect.succeed(storing("TxHashSet", Effect.succeed(set ?? Value.undef))),
    "effect/TxHashSet:has": reads("TxHashSet", "has", "effect/HashSet:has"),
    "effect/TxHashSet:size": reads("TxHashSet", "size", "effect/HashSet:size"),
    "effect/TxHashSet:isEmpty": reads("TxHashSet", "isEmpty", "effect/HashSet:isEmpty"),
    "effect/TxHashSet:isNonEmpty": stored("TxHashSet", "isNonEmpty", (before, _, site) =>
      Effect.flatMap(lib("effect/HashSet:isEmpty", [before], site), (empty) =>
        Effect.map(not(empty, site), (gives) => ({ gives })),
      ),
    ),
    "effect/TxHashSet:some": reads("TxHashSet", "some", "effect/HashSet:some"),
    "effect/TxHashSet:every": reads("TxHashSet", "every", "effect/HashSet:every"),
    "effect/TxHashSet:reduce": reads("TxHashSet", "reduce", "effect/HashSet:reduce"),
    "effect/TxHashSet:add": writes("TxHashSet", "add", "effect/HashSet:add"),
    "effect/TxHashSet:clear": stored("TxHashSet", "clear", (_, __, site) =>
      Effect.map(lib("effect/HashSet:empty", [], site), (next) => ({ next, gives: Value.undef })),
    ),
    "effect/TxHashSet:remove": stored("TxHashSet", "remove", (before, rest, site) =>
      Effect.flatMap(lib("effect/HashSet:has", [before, ...rest], site), (gives) =>
        Effect.map(lib("effect/HashSet:remove", [before, ...rest], site), (next) => ({
          next,
          gives,
        })),
      ),
    ),
    "effect/TxHashSet:map": derives("TxHashSet", "map", "effect/HashSet:map"),
    "effect/TxHashSet:filter": derives("TxHashSet", "filter", "effect/HashSet:filter"),
    "effect/TxHashSet:union": derives("TxHashSet", "union", "effect/HashSet:union", 2),
    "effect/TxHashSet:intersection": derives(
      "TxHashSet",
      "intersection",
      "effect/HashSet:intersection",
      2,
    ),
    "effect/TxHashSet:difference": derives(
      "TxHashSet",
      "difference",
      "effect/HashSet:difference",
      2,
    ),
    "effect/TxHashSet:isSubset": stored(
      "TxHashSet",
      "isSubset",
      (before, [that], site) => {
        const other = heldOf<Store>("TxHashSet", that);
        return other
          ? Effect.flatMap(TxRef.get(other.ref), (held) =>
              Effect.map(lib("effect/HashSet:isSubset", [before, held], site), (gives) => ({
                gives,
              })),
            )
          : wrongArguments(site, "TxHashSet.isSubset");
      },
      2,
    ),
    "effect/TxPriorityQueue:empty": ([order], site) =>
      Effect.succeed(queueOf("TxPriorityQueue.empty", order, Effect.succeed([]), site)),
    "effect/TxPriorityQueue:fromIterable": ([order, given_], site) =>
      Effect.succeed(
        queueOf(
          "TxPriorityQueue.fromIterable",
          order,
          items("TxPriorityQueue.fromIterable", given_, site),
          site,
        ),
      ),
    "effect/TxPriorityQueue:make": ([order]) =>
      Effect.succeed(
        native("TxPriorityQueue.make", (given_, site) =>
          Effect.succeed(queueOf("TxPriorityQueue.make", order, Effect.succeed(given_), site)),
        ),
      ),
    "effect/TxPriorityQueue:size": stored("TxPriorityQueue", "size", (before) =>
      Effect.succeed({ gives: num(itemsOf_(before).length) }),
    ),
    "effect/TxPriorityQueue:isEmpty": stored("TxPriorityQueue", "isEmpty", (before) =>
      Effect.succeed({ gives: bool(itemsOf_(before).length === 0) }),
    ),
    "effect/TxPriorityQueue:isNonEmpty": stored("TxPriorityQueue", "isNonEmpty", (before) =>
      Effect.succeed({ gives: bool(itemsOf_(before).length > 0) }),
    ),
    "effect/TxPriorityQueue:toArray": stored("TxPriorityQueue", "toArray", (before) =>
      Effect.succeed({ gives: before }),
    ),
    "effect/TxPriorityQueue:peek": stored("TxPriorityQueue", "peek", (before) => {
      const [first] = itemsOf_(before);
      return Effect.succeed(first ? { gives: first } : ("retry" as const));
    }),
    "effect/TxPriorityQueue:peekOption": stored("TxPriorityQueue", "peekOption", (before) => {
      const [first] = itemsOf_(before);
      return Effect.succeed({ gives: first ? Value.some(first) : Value.none });
    }),
    "effect/TxPriorityQueue:take": stored("TxPriorityQueue", "take", (before) => {
      const [first, ...rest] = itemsOf_(before);
      return Effect.succeed(first ? { gives: first, next: arr(rest) } : ("retry" as const));
    }),
    "effect/TxPriorityQueue:takeOption": stored("TxPriorityQueue", "takeOption", (before) => {
      const [first, ...rest] = itemsOf_(before);
      return Effect.succeed(
        first ? { gives: Value.some(first), next: arr(rest) } : { gives: Value.none },
      );
    }),
    "effect/TxPriorityQueue:takeAll": stored("TxPriorityQueue", "takeAll", (before) =>
      Effect.succeed({ gives: before, next: arr([]) }),
    ),
    "effect/TxPriorityQueue:takeUpTo": stored("TxPriorityQueue", "takeUpTo", (before, [n], site) =>
      Effect.map(count("TxPriorityQueue.takeUpTo", n, site), (most) => ({
        gives: arr(itemsOf_(before).slice(0, most)),
        next: arr(itemsOf_(before).slice(most)),
      })),
    ),
    "effect/TxPriorityQueue:offer": stored(
      "TxPriorityQueue",
      "offer",
      (before, [value], site, store) =>
        Effect.map(sorted([...itemsOf_(before), value ?? Value.undef], store, site), (next) => ({
          next,
          gives: Value.undef,
        })),
    ),
    "effect/TxPriorityQueue:offerAll": stored(
      "TxPriorityQueue",
      "offerAll",
      (before, [values], site, store) =>
        Effect.flatMap(items("TxPriorityQueue.offerAll", values, site), (found) =>
          Effect.map(sorted([...itemsOf_(before), ...found], store, site), (next) => ({
            next,
            gives: Value.undef,
          })),
        ),
    ),
    "effect/TxPriorityQueue:retainIf": stored(
      "TxPriorityQueue",
      "retainIf",
      (before, [test], site) =>
        test
          ? Effect.map(
              Effect.filter(itemsOf_(before), (item) => kit.holds(test, [item], site)),
              (kept_) => ({ next: arr(kept_), gives: Value.undef }),
            )
          : wrongArguments(site, "TxPriorityQueue.retainIf"),
    ),
    "effect/TxPriorityQueue:removeIf": stored(
      "TxPriorityQueue",
      "removeIf",
      (before, [test], site) =>
        test
          ? Effect.map(
              Effect.filter(itemsOf_(before), (item) =>
                Effect.map(kit.holds(test, [item], site), (held) => !held),
              ),
              (kept_) => ({ next: arr(kept_), gives: Value.undef }),
            )
          : wrongArguments(site, "TxPriorityQueue.removeIf"),
    ),
  };

  /** An instance of a request class a file exports: the class is the one the runtime loaded. */
  const constructs = (cls: unknown, args: ReadonlyArray<V>, site: Site): Eval<V> | undefined => {
    if (typeof cls !== "function" || !Request.isRequest(cls.prototype)) return undefined;
    const fields = plainOf(args[0] ?? Value.obj({}));
    return fields === NOT_PLAIN || typeof fields !== "object" || fields === null
      ? unseen(site, `makes a ${cls.name} request of values the prover cannot see`)
      : Effect.sync(() => wrap("Request", Reflect.construct(cls, [fields]) as Asked));
  };

  /** A request written as a class: `class GetPrice extends Request.TaggedClass("GetPrice")<...> {}`. */
  const requestClass = (name: string, build: (fields: object) => Asked): V =>
    asClass(asking(name, build), (extended) => requestClass(extended, build));

  // A resolver from a plain function: each request is answered with what the function gives.
  Object.assign(requests, {
    "effect/Request:TaggedClass": ([tag]: ReadonlyArray<V>, site: Site) =>
      tag?._tag === "Str"
        ? Effect.succeed(
            requestClass(tag.value, (fields) =>
              Request.tagged<Asked & { _tag: string }>(tag.value)(fields as never),
            ),
          )
        : wrongArguments(site, "Request.TaggedClass"),
    "effect/RequestResolver:fromFunction": ([f]: ReadonlyArray<V>, site: Site) =>
      f && callable(f)
        ? Effect.succeed(
            resolving((timeline) =>
              RequestResolver.fromEffect<Asked>((entry) =>
                Timeline.real(timeline, host.call(f, [entryOf(entry)], site)),
              ),
            ),
          )
        : wrongArguments(site, "RequestResolver.fromFunction"),
  });

  // ---- A scope the code holds, and what lives as long as one.

  /** An `Exit` of the code, as the library takes one. */
  const ended = (exit: V | undefined): Exit.Exit<V, Held> | undefined => {
    if (exit?._tag !== "Obj") return undefined;
    if (tagOf(exit) === "Success") return Exit.succeed(exit.fields.value ?? Value.undef);
    const cause = exit.fields.cause;
    const reasons = cause?._tag === "Obj" ? kit.itemsOf(cause.fields.reasons) : undefined;
    if (tagOf(exit) !== "Failure" || !reasons) return undefined;
    const die = reasons.find((each) => tagOf(each) === "Die");
    const fail = reasons.find((each) => tagOf(each) === "Fail");
    if (die?._tag === "Obj") return Exit.die(new Timeline.Defect(die.fields.defect ?? Value.undef));
    if (fail?._tag === "Obj")
      return Exit.fail(new Value.Rejected({ rejection: fail.fields.error ?? Value.undef }));
    return Exit.interrupt();
  };

  const strategy = (v: V | undefined): "sequential" | "parallel" | undefined =>
    v?._tag === "Str" && (v.value === "sequential" || v.value === "parallel") ? v.value : undefined;

  type SR = ScopedRef.ScopedRef<V>;
  type RR = RcRef.RcRef<V, Held>;
  type RM = RcMap.RcMap<Key, V, Held>;
  type RS = Resource.Resource<V, Held>;

  /** A function of one of these that leaves something open in the scope around it. */
  const opening = <H>(
    kind: Kind,
    name: string,
    arity: number,
    body: (
      held: H,
      rest: ReadonlyArray<V>,
      site: Site,
    ) => Eval<Effect.Effect<V, unknown, Scope.Scope>>,
  ): Model =>
    dual(`${kind}.${name}`, arity, ([self, ...rest], site) => {
      const held = heldOf<H>(kind, self);
      return held === undefined
        ? wrongArguments(site, `${kind}.${name}`)
        : Effect.succeed(
            scoped(
              `${kind}.${name}`,
              site,
              (timeline) =>
                Effect.flatMap(Timeline.real(timeline, body(held, rest, site)), (effect) => effect),
              same,
            ),
          );
    });

  const idle = (name: string, v: V | undefined, site: Site): Eval<Duration.Duration | undefined> =>
    v === undefined || v._tag === "Undef"
      ? Effect.succeed(undefined)
      : callable(v)
        ? unseen(site, `calls ${name} with a time to live that a function gives`)
        : written(name, v, site);

  const fieldOf = (v: V | undefined, key: string): V | undefined =>
    v?._tag === "Obj" ? v.fields[key] : undefined;

  const lifetimes: Models = {
    "effect/Scope:make": made("Scope", ([given_]) => Scope.make(strategy(given_))),
    "effect/Scope:fork": on<Scope.Scope, Scope.Closeable>(
      "Scope",
      "fork",
      1,
      (held, [given_]) => Scope.fork(held, strategy(given_)),
      (forked) => wrap("Scope", forked),
    ),
    "effect/Scope:addFinalizer": later<Scope.Scope, void>(
      "Scope",
      "addFinalizer",
      2,
      (held, [finalizer], site, timeline) => {
        const effect = effectOf(timeline, finalizer, site);
        return effect
          ? Effect.succeed(Scope.addFinalizer(held, sure(effect)))
          : wrongArguments(site, "Scope.addFinalizer");
      },
      none,
    ),
    "effect/Scope:addFinalizerExit": later<Scope.Scope, void>(
      "Scope",
      "addFinalizerExit",
      2,
      (held, [finalizer], site, timeline) =>
        finalizer
          ? Effect.succeed(Scope.addFinalizerExit(held, closing(timeline, finalizer, site, [])))
          : wrongArguments(site, "Scope.addFinalizerExit"),
      none,
    ),
    "effect/Scope:close": later<Scope.Closeable, void>(
      "Scope",
      "close",
      2,
      (held, [exit], site) => {
        const real = ended(exit);
        return real ? Effect.succeed(Scope.close(held, real)) : wrongArguments(site, "Scope.close");
      },
      none,
    ),
    "effect/Scope:provide": onEffect("Scope.provide", 1, (timeline, self, [scope], site) => {
      const held = heldOf<Scope.Scope>("Scope", scope);
      return held
        ? Timeline.back(timeline, Scope.provide(self, held), same)
        : wrongArguments(site, "Scope.provide");
    }),
    "effect/Scope:use": onEffect("Scope.use", 1, (timeline, self, [scope], site) => {
      const held = heldOf<Scope.Closeable>("Scope", scope);
      return held
        ? Timeline.back(timeline, Scope.use(self, held), same)
        : wrongArguments(site, "Scope.use");
    }),
    "effect/ScopedRef:make": ([evaluate], site) =>
      Effect.succeed(
        scoped(
          "ScopedRef.make",
          site,
          (timeline) =>
            Effect.flatMap(
              Timeline.real(
                timeline,
                evaluate ? host.call(evaluate, [], site) : wrongArguments(site, "ScopedRef.make"),
              ),
              (value) => ScopedRef.make(() => value),
            ),
          (held) => wrap("ScopedRef", held),
        ),
      ),
    "effect/ScopedRef:fromAcquire": ([acquire], site) =>
      Effect.succeed(
        scoped(
          "ScopedRef.fromAcquire",
          site,
          (timeline) =>
            ScopedRef.fromAcquire(
              effectOf(timeline, acquire, site) ??
                Timeline.real(timeline, wrongArguments(site, "ScopedRef.fromAcquire")),
            ),
          (held) => wrap("ScopedRef", held),
        ),
      ),
    "effect/ScopedRef:get": on<SR, V>("ScopedRef", "get", 1, (held) => ScopedRef.get(held), same),
    "effect/ScopedRef:getUnsafe": now<SR, V>(
      "ScopedRef",
      "getUnsafe",
      1,
      (held) => ScopedRef.getUnsafe(held),
      same,
    ),
    "effect/ScopedRef:set": later<SR, void>(
      "ScopedRef",
      "set",
      2,
      (held, [acquire], site, timeline) => {
        const effect = effectOf(timeline, acquire, site);
        return effect
          ? Effect.succeed(ScopedRef.set(held, effect))
          : wrongArguments(site, "ScopedRef.set");
      },
      none,
    ),
    "effect/RcRef:make": ([given_], site) =>
      Effect.succeed(
        scoped(
          "RcRef.make",
          site,
          (timeline) =>
            Effect.flatMap(
              Timeline.real(timeline, idle("RcRef.make", fieldOf(given_, "idleTimeToLive"), site)),
              (idleTimeToLive) =>
                RcRef.make({
                  acquire:
                    effectOf(timeline, fieldOf(given_, "acquire"), site) ??
                    Timeline.real(timeline, wrongArguments(site, "RcRef.make")),
                  idleTimeToLive,
                }),
            ),
          (held) => wrap("RcRef", held),
        ),
      ),
    "effect/RcRef:get": opening<RR>("RcRef", "get", 1, (held) =>
      held.pipe(RcRef.get, Effect.succeed),
    ),
    "effect/RcRef:invalidate": on<RR, void>(
      "RcRef",
      "invalidate",
      1,
      (held) => RcRef.invalidate(held),
      none,
    ),
    "effect/RcMap:make": ([given_], site) =>
      Effect.succeed(
        scoped(
          "RcMap.make",
          site,
          (timeline) => {
            const lookup = fieldOf(given_, "lookup");
            const size = fieldOf(given_, "capacity");
            return Effect.flatMap(
              Timeline.real(
                timeline,
                Effect.all([
                  idle("RcMap.make", fieldOf(given_, "idleTimeToLive"), site),
                  size === undefined || size._tag === "Undef"
                    ? Effect.succeed(undefined)
                    : count("RcMap.make", size, site),
                  lookup && callable(lookup)
                    ? Effect.succeed(lookup)
                    : wrongArguments(site, "RcMap.make"),
                ]),
              ),
              ([idleTimeToLive, capacity_, find]): Effect.Effect<RM, never, Scope.Scope> => {
                const options_ = {
                  lookup: (key: Key) => called(timeline, find, site)(keyed(key)),
                  idleTimeToLive,
                };
                return capacity_ === undefined
                  ? RcMap.make(options_)
                  : (RcMap.make({ ...options_, capacity: capacity_ }) as Effect.Effect<
                      RM,
                      never,
                      Scope.Scope
                    >);
              },
            );
          },
          (held) => wrap("RcMap", held),
        ),
      ),
    "effect/RcMap:get": opening<RM>("RcMap", "get", 2, (held, [key], site) =>
      Effect.map(keyOf("RcMap.get", key, site), (read) => RcMap.get(held, read)),
    ),
    "effect/RcMap:getOption": opening<RM>("RcMap", "getOption", 2, (held, [key], site) =>
      Effect.map(keyOf("RcMap.getOption", key, site), (read) =>
        Effect.map(RcMap.getOption(held, read), option),
      ),
    ),
    "effect/RcMap:keys": on<RM, Iterable<Key>>(
      "RcMap",
      "keys",
      1,
      (held) => RcMap.keys(held),
      (keys) => arr([...keys].map(keyed)),
    ),
    "effect/RcMap:has": byKey<RM, boolean>(
      "RcMap",
      "has",
      2,
      (held, key) => Effect.succeed(RcMap.has(held, key)),
      bool,
    ),
    "effect/RcMap:invalidate": byKey<RM, void>(
      "RcMap",
      "invalidate",
      2,
      (held, key) => Effect.succeed(RcMap.invalidate(held, key)),
      none,
    ),
    "effect/RcMap:touch": byKey<RM, void>(
      "RcMap",
      "touch",
      2,
      (held, key) => Effect.succeed(RcMap.touch(held, key)),
      none,
    ),
    "effect/Resource:manual": ([acquire], site) =>
      Effect.succeed(
        scoped(
          "Resource.manual",
          site,
          (timeline) =>
            Resource.manual(
              effectOf(timeline, acquire, site) ??
                Timeline.real(timeline, wrongArguments(site, "Resource.manual")),
            ),
          (held) => wrap("Resource", held),
        ),
      ),
    "effect/Resource:auto": ([acquire, policy], site) => {
      const schedule_ = scheduleOf(policy);
      return schedule_
        ? Effect.succeed(
            scoped(
              "Resource.auto",
              site,
              (timeline) =>
                Resource.auto(
                  effectOf(timeline, acquire, site) ??
                    Timeline.real(timeline, wrongArguments(site, "Resource.auto")),
                  schedule_,
                ),
              (held) => wrap("Resource", held),
            ),
          )
        : wrongArguments(site, "Resource.auto");
    },
    "effect/Resource:get": on<RS, V>("Resource", "get", 1, (held) => Resource.get(held), same),
    "effect/Resource:refresh": on<RS, void>(
      "Resource",
      "refresh",
      1,
      (held) => Resource.refresh(held),
      none,
    ),
    "effect/Resource:isResource": ([value]) =>
      Effect.succeed(bool(heldOf<RS>("Resource", value) !== undefined)),
  };

  // ---- Random numbers, which a seed decides.

  /** A draw: the library's own, from the seed the code gave. With no seed, no two runs give the same. */
  const drawn = <A>(
    name: string,
    site: Site,
    draw: (timeline: Timeline.Timeline) => Eval<Effect.Effect<A, unknown>>,
    give: (value: A) => V,
  ): V =>
    timed(
      name,
      (timeline) =>
        Effect.flatMap(draw(timeline), (effect) =>
          Effect.flatMap(
            Timeline.back(timeline, effect, give),
            // A draw with no seed has stopped the prover: the handler is not read further.
            (value) => (timeline.fatal ? Effect.fail(timeline.fatal) : Effect.succeed(value)),
          ),
        ),
      site,
    );

  const known = (name: string, v: V | undefined, site: Site): Eval<number> =>
    v?._tag === "Num"
      ? Effect.succeed(v.value)
      : unseen(site, `calls ${name} with a bound the prover cannot see`);

  const randoms: Models = {
    "effect/Random:nextBetween": ([min, max], site) =>
      Effect.succeed(
        drawn(
          "Random.nextBetween",
          site,
          () =>
            Effect.all([
              known("Random.nextBetween", min, site),
              known("Random.nextBetween", max, site),
            ]).pipe(Effect.map(([low, high]) => Random.nextBetween(low, high))),
          num,
        ),
      ),
    "effect/Random:nextIntBetween": ([min, max, given_], site) =>
      Effect.succeed(
        drawn(
          "Random.nextIntBetween",
          site,
          () =>
            Effect.all([
              known("Random.nextIntBetween", min, site),
              known("Random.nextIntBetween", max, site),
              given_ === undefined || given_._tag === "Undef"
                ? Effect.succeed(undefined)
                : options<{ readonly halfOpen?: boolean }>("Random.nextIntBetween", given_, site),
            ]).pipe(Effect.map(([low, high, read]) => Random.nextIntBetween(low, high, read))),
          num,
        ),
      ),
    "effect/Random:shuffle": ([given_], site) =>
      Effect.succeed(
        drawn(
          "Random.shuffle",
          site,
          () => Effect.map(items("Random.shuffle", given_, site), (all) => Random.shuffle(all)),
          list,
        ),
      ),
    "effect/Random:choice": ([given_], site) =>
      Effect.succeed(
        drawn(
          "Random.choice",
          site,
          () =>
            Effect.map(items("Random.choice", given_, site), (all) =>
              Random.choice(all as ReadonlyArray<V>),
            ),
          same,
        ),
      ),
    "effect/Random:withSeed": onEffect("Random.withSeed", 1, (timeline, self, [seed], site) =>
      seed?._tag === "Num" || seed?._tag === "Str"
        ? Timeline.back(timeline, Random.withSeed(self, seed.value), same)
        : unseen(site, "calls Random.withSeed with a seed the prover cannot see"),
    ),
  };

  // ---- More of `Effect`: what handles a cause, what runs an effect again, and other names for the same.

  /** A cause the library gives, as the code holds one. What stopped the prover is not a cause of the code's. */
  const causeTo = (
    timeline: Timeline.Timeline,
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<V, Held> =>
    Effect.map(Timeline.real(timeline, exitOf(timeline, Exit.failCause(cause))), (exit) =>
      exit._tag === "Obj" ? (exit.fields.cause ?? Value.undef) : Value.undef,
    );
  /** Whether a function of the code holds of a value, as the library asks. */
  const holding = (
    timeline: Timeline.Timeline,
    test: V | undefined,
    value: V,
    site: Site,
  ): Effect.Effect<boolean, Held> =>
    test
      ? Timeline.real(timeline, kit.holds(test, [value], site))
      : Timeline.real(timeline, wrongArguments(site, "a test"));
  /** A function of the code that gives a value, where the library takes one that gives an effect. */
  const plainly = (
    timeline: Timeline.Timeline,
    fn: V | undefined,
    site: Site,
  ): ((...args: ReadonlyArray<V>) => Effect.Effect<V, Held>) =>
    fn && callable(fn)
      ? (...args) => Timeline.real(timeline, host.call(fn, args, site))
      : () => Timeline.real(timeline, wrongArguments(site, "a function"));
  /** Another name of a function the prover reads: the same model. */
  const alias =
    (key: string): Model =>
    (args, site) =>
      lib(key, args, site);
  /** A function of an effect that says how it is watched: the effect is what it was. */
  const watched = (name: string): Model =>
    dualBy(
      name,
      (v) => v._tag === "Effect",
      ([self], site) => (self ? Effect.succeed(self) : wrongArguments(site, name)),
    );
  const field = (cases: V | undefined, key: string): V | undefined =>
    cases?._tag === "Obj" ? cases.fields[key] : undefined;
  /** An effect the library made, as one the code holds. */
  const effectFrom = (timeline: Timeline.Timeline, made_: Effect.Effect<V, unknown>): V => ({
    _tag: "Effect",
    run: Timeline.back(timeline, made_, same),
  });
  const isOurDefect = (defect: unknown): defect is Timeline.Defect =>
    typeof defect === "object" && defect !== null && "_tag" in defect && defect._tag === "Defect";

  const more: Models = {
    "effect/Effect:mapEager": alias("effect/Effect:map"),
    "effect/Effect:flatMapEager": alias("effect/Effect:flatMap"),
    "effect/Effect:mapErrorEager": alias("effect/Effect:mapError"),
    "effect/Effect:mapBothEager": alias("effect/Effect:mapBoth"),
    "effect/Effect:matchEager": alias("effect/Effect:match"),
    "effect/Effect:catchEager": alias("effect/Effect:catch"),
    "effect/Effect:fnUntracedEager": alias("effect/Effect:fnUntraced"),
    "effect/Effect:provideContext": alias("effect/Effect:provide"),
    "effect/Effect:catchCause": onEffect("Effect.catchCause", 1, (timeline, self, [f], site) =>
      f
        ? Timeline.back(
            timeline,
            Effect.catchCause(self, (cause) =>
              Effect.flatMap(causeTo(timeline, cause), called(timeline, f, site)),
            ),
            same,
          )
        : wrongArguments(site, "Effect.catchCause"),
    ),
    "effect/Effect:catchCauseIf": onEffect(
      "Effect.catchCauseIf",
      2,
      (timeline, self, [test, f], site) =>
        f
          ? Timeline.back(
              timeline,
              Effect.catchCause(self, (cause) =>
                Effect.flatMap(causeTo(timeline, cause), (held) =>
                  Effect.flatMap(holding(timeline, test, held, site), (holds) =>
                    holds ? called(timeline, f, site)(held) : Effect.failCause(cause),
                  ),
                ),
              ),
              same,
            )
          : wrongArguments(site, "Effect.catchCauseIf"),
    ),
    "effect/Effect:tapCause": onEffect("Effect.tapCause", 1, (timeline, self, [f], site) =>
      f
        ? Timeline.back(
            timeline,
            Effect.tapCause(self, (cause) =>
              Effect.flatMap(causeTo(timeline, cause), called(timeline, f, site)),
            ),
            same,
          )
        : wrongArguments(site, "Effect.tapCause"),
    ),
    "effect/Effect:tapCauseIf": onEffect(
      "Effect.tapCauseIf",
      2,
      (timeline, self, [test, f], site) =>
        f
          ? Timeline.back(
              timeline,
              Effect.tapCause(self, (cause) =>
                Effect.flatMap(causeTo(timeline, cause), (held) =>
                  Effect.flatMap(holding(timeline, test, held, site), (holds) =>
                    holds ? called(timeline, f, site)(held) : Effect.succeed(Value.undef),
                  ),
                ),
              ),
              same,
            )
          : wrongArguments(site, "Effect.tapCauseIf"),
    ),
    "effect/Effect:onError": onEffect("Effect.onError", 1, (timeline, self, [f], site) =>
      f
        ? Timeline.back(
            timeline,
            Effect.onError(self, (cause) =>
              sure(Effect.flatMap(causeTo(timeline, cause), called(timeline, f, site))),
            ),
            same,
          )
        : wrongArguments(site, "Effect.onError"),
    ),
    "effect/Effect:onErrorIf": onEffect("Effect.onErrorIf", 2, (timeline, self, [test, f], site) =>
      f
        ? Timeline.back(
            timeline,
            Effect.onError(self, (cause) =>
              sure(
                Effect.flatMap(causeTo(timeline, cause), (held) =>
                  Effect.flatMap(holding(timeline, test, held, site), (holds) =>
                    holds ? called(timeline, f, site)(held) : Effect.succeed(Value.undef),
                  ),
                ),
              ),
            ),
            same,
          )
        : wrongArguments(site, "Effect.onErrorIf"),
    ),
    "effect/Effect:matchCause": onEffect("Effect.matchCause", 1, (timeline, self, [cases], site) =>
      Timeline.back(
        timeline,
        Effect.matchCauseEffect(self, {
          onFailure: (cause) =>
            Effect.flatMap(
              causeTo(timeline, cause),
              plainly(timeline, field(cases, "onFailure"), site),
            ),
          onSuccess: plainly(timeline, field(cases, "onSuccess"), site),
        }),
        same,
      ),
    ),
    "effect/Effect:matchCauseEffect": onEffect(
      "Effect.matchCauseEffect",
      1,
      (timeline, self, [cases], site) => {
        const [onFailure, onSuccess] = [field(cases, "onFailure"), field(cases, "onSuccess")];
        return onFailure && onSuccess
          ? Timeline.back(
              timeline,
              Effect.matchCauseEffect(self, {
                onFailure: (cause) =>
                  Effect.flatMap(causeTo(timeline, cause), called(timeline, onFailure, site)),
                onSuccess: called(timeline, onSuccess, site),
              }),
              same,
            )
          : wrongArguments(site, "Effect.matchCauseEffect");
      },
    ),
    // The cause is what the effect fails with: nothing is a defect any more.
    "effect/Effect:sandbox": onEffect("Effect.sandbox", 0, (timeline, self) =>
      Timeline.back(
        timeline,
        Effect.catchCause(self, (cause) =>
          Effect.flatMap(causeTo(timeline, cause), (held) =>
            Effect.fail(new Value.Rejected({ rejection: held })),
          ),
        ),
        same,
      ),
    ),
    "effect/Effect:ignoreCause": onEffect("Effect.ignoreCause", 0, (timeline, self) =>
      Timeline.back(
        timeline,
        Effect.catchCause(self, (cause) => Effect.as(causeTo(timeline, cause), Value.undef)),
        () => Value.undef,
      ),
    ),
    "effect/Effect:catchDefect": onEffect("Effect.catchDefect", 1, (timeline, self, [f], site) =>
      f
        ? Timeline.back(
            timeline,
            Effect.catchDefect(self, (defect) =>
              isOurDefect(defect) ? called(timeline, f, site)(defect.defect) : Effect.die(defect),
            ),
            same,
          )
        : wrongArguments(site, "Effect.catchDefect"),
    ),
    "effect/Effect:tapDefect": onEffect("Effect.tapDefect", 1, (timeline, self, [f], site) =>
      f
        ? Timeline.back(
            timeline,
            Effect.tapDefect(self, (defect) =>
              isOurDefect(defect)
                ? called(timeline, f, site)(defect.defect)
                : Effect.succeed(Value.undef),
            ),
            same,
          )
        : wrongArguments(site, "Effect.tapDefect"),
    ),
    // Run again with nothing to stop it: it ends when it fails.
    "effect/Effect:forever": onEffect("Effect.forever", 0, (timeline, self, _, site) =>
      Timeline.back(timeline, Effect.forever(turn("Effect.forever", timeline, self, site)), same),
    ),
    "effect/Effect:eventually": onEffect("Effect.eventually", 0, (timeline, self, _, site) =>
      Timeline.back(
        timeline,
        Effect.eventually(turn("Effect.eventually", timeline, self, site)),
        same,
      ),
    ),
    "effect/Effect:replicate": dual("Effect.replicate", 2, ([self, n], site) =>
      Effect.map(count("Effect.replicate", n, site), (times) =>
        arr(Array.from({ length: times }, () => self ?? Value.undef)),
      ),
    ),
    "effect/Effect:replicateEffect": onEffect(
      "Effect.replicateEffect",
      1,
      (timeline, self, [n], site) =>
        Effect.flatMap(count("Effect.replicateEffect", n, site), (times) =>
          Timeline.back(timeline, Effect.replicateEffect(self, times), list),
        ),
    ),
    "effect/Effect:firstSuccessOf": ([given], site) =>
      Effect.succeed(
        timed(
          "Effect.firstSuccessOf",
          (timeline) =>
            Effect.flatMap(effects("Effect.firstSuccessOf", timeline, given, site), (all) =>
              all.length === 0
                ? wrongArguments(site, "Effect.firstSuccessOf")
                : Timeline.back(timeline, Effect.firstSuccessOf(all), same),
            ),
          site,
        ),
      ),
    "effect/Effect:whileLoop": ([given], site) => {
      const [test, body, step] = [
        field(given, "while"),
        field(given, "body"),
        field(given, "step"),
      ];
      if (!test || !body || !step) return wrongArguments(site, "Effect.whileLoop");
      return Effect.succeed(
        lazy(() =>
          Effect.gen(function* () {
            let turns = 0;
            while (yield* kit.holds(test, [], site)) {
              if (++turns > MAX_TURNS)
                return yield* unseen(
                  site,
                  `runs an effect again more than ${MAX_TURNS} times, with Effect.whileLoop`,
                );
              yield* host.call(step, [yield* ran(body, [], site)], site);
            }
            return Value.undef;
          }),
        ),
      );
    },
    "effect/Effect:try": ([given], site) => {
      const attempt = given && callable(given) ? given : field(given, "try");
      const mapped = given && callable(given) ? undefined : field(given, "catch");
      if (!attempt) return wrongArguments(site, "Effect.try");
      return Effect.succeed(
        lazy(() =>
          Effect.catchIf(
            host.call(attempt, [], site),
            // What the function throws: not a failure of an effect it yielded.
            (stop): stop is Value.Rejected =>
              stop._tag === "Rejected" && stop.defect === true && stop.yielded !== true,
            (stop) =>
              mapped
                ? Effect.flatMap(host.call(mapped, [stop.rejection], site), (error) =>
                    Effect.fail(new Value.Rejected({ rejection: error })),
                  )
                : Effect.fail(
                    new Value.Rejected({
                      rejection: Value.libraryError("UnknownError", {
                        cause: stop.rejection,
                      }),
                    }),
                  ),
          ),
        ),
      );
    },
    "effect/Effect:isEffect": ([value]) => Effect.succeed(bool(value?._tag === "Effect")),
    "effect/Effect:runSyncExit": (args, site) =>
      Effect.flatMap(lib("effect/Effect:exit", args, site), (made_) =>
        made_._tag === "Effect" ? made_.run : wrongArguments(site, "Effect.runSyncExit"),
      ),
    "effect/Effect:forkIn": onEffect("Effect.forkIn", 1, (timeline, self, [scope], site) => {
      const held = heldOf<Scope.Scope>("Scope", scope);
      return held
        ? Timeline.back(timeline, Effect.forkIn(self, held), (fiber) => wrap("Fiber", fiber))
        : wrongArguments(site, "Effect.forkIn");
    }),
    "effect/Effect:scopedWith": ([f], site) =>
      f
        ? Effect.succeed(
            timed(
              "Effect.scopedWith",
              (timeline) =>
                Timeline.back(
                  timeline,
                  Effect.scopedWith((scope) => called(timeline, f, site)(wrap("Scope", scope))),
                  same,
                ),
              site,
            ),
          )
        : wrongArguments(site, "Effect.scopedWith"),
    // The effect is run the first time what this gives is run, and never again.
    "effect/Effect:cached": onEffect("Effect.cached", 0, (timeline, self) =>
      Timeline.back(timeline, Effect.cached(self), (inner) => effectFrom(timeline, inner)),
    ),
    "effect/Effect:cachedWithTTL": onEffect(
      "Effect.cachedWithTTL",
      1,
      (timeline, self, [ttl], site) =>
        Effect.flatMap(written("Effect.cachedWithTTL", ttl, site), (time) =>
          Timeline.back(timeline, Effect.cachedWithTTL(self, time), (inner) =>
            effectFrom(timeline, inner),
          ),
        ),
    ),
    "effect/Effect:schedule": onEffect("Effect.schedule", 1, (timeline, self, [given], site) => {
      const held = scheduleOf(given);
      return held
        ? Timeline.back(
            timeline,
            Effect.schedule(turn("Effect.schedule", timeline, self, site), held),
            outputOf,
          )
        : wrongArguments(site, "Effect.schedule");
    }),
    "effect/Effect:retryOrElse": onEffect(
      "Effect.retryOrElse",
      2,
      (timeline, self, [given, orElse], site) => {
        const held = scheduleOf(given);
        return held && orElse
          ? Timeline.back(
              timeline,
              Effect.retryOrElse(
                turn("Effect.retryOrElse", timeline, self, site),
                held,
                (error, out) => called(timeline, orElse, site)(error.rejection, outputOf(out)),
              ),
              same,
            )
          : wrongArguments(site, "Effect.retryOrElse");
      },
    ),
    "effect/Effect:serviceOption": ([tag], site) =>
      tag?._tag === "Host"
        ? Effect.succeed(
            lazy(() =>
              Effect.sync(() => {
                const given = host.provided.get(tag.value);
                return given ? Value.some(given) : Value.none;
              }),
            ),
          )
        : wrongArguments(site, "Effect.serviceOption"),
    "effect/Effect:updateService": onEffectPlain(
      "Effect.updateService",
      2,
      (self, [tag, f], site) => {
        if (tag?._tag !== "Host" || !f) return wrongArguments(site, "Effect.updateService");
        const before = host.provided.get(tag.value);
        if (!before)
          return unseen(site, `calls Effect.updateService of ${tag.name}, which nothing provides`);
        return Effect.flatMap(host.call(f, [before], site), (next) =>
          Effect.suspend(() => {
            host.provided.set(tag.value, next);
            return Effect.ensuring(
              self,
              Effect.sync(() => void host.provided.set(tag.value, before)),
            );
          }),
        );
      },
    ),
    "effect/Effect:provideServiceEffect": onEffectPlain(
      "Effect.provideServiceEffect",
      2,
      (self, [tag, made_], site) => {
        if (tag?._tag !== "Host" || made_?._tag !== "Effect")
          return wrongArguments(site, "Effect.provideServiceEffect");
        return Effect.flatMap(made_.run, (value) =>
          Effect.suspend(() => {
            const before = host.provided.get(tag.value);
            host.provided.set(tag.value, value);
            return Effect.ensuring(
              self,
              Effect.sync(() => {
                if (before) host.provided.set(tag.value, before);
                else host.provided.delete(tag.value);
              }),
            );
          }),
        );
      },
    ),
    "effect/Effect:withTracerEnabled": watched("Effect.withTracerEnabled"),
    "effect/Effect:withTracerTiming": watched("Effect.withTracerTiming"),
    "effect/Effect:annotateLogsScoped": () =>
      Effect.succeed(lazy(() => Effect.succeed(Value.undef))),
  };

  // ---- The rest of `Queue`, `PubSub` and `Deferred`.

  /** A cause of the code, as the library takes one. */
  const realCause = (cause: V | undefined): Cause.Cause<Held> | undefined => {
    const exit = cause ? ended(Value.obj({ _tag: Value.str("Failure"), cause })) : undefined;
    return exit && Exit.isFailure(exit) ? exit.cause : undefined;
  };
  const isKind =
    (kind: Kind): Model =>
    ([value]) =>
      Effect.succeed(bool(kindOf(value) === kind));
  type QD = Queue.Queue<V, Held | Cause.Done>;
  type Hub = PubSub.PubSub<V>;
  type SB = PubSub.Subscription<V>;

  const rest: Models = {
    "effect/Queue:asDequeue": ([queue]) => Effect.succeed(queue ?? Value.undef),
    "effect/Queue:asEnqueue": ([queue]) => Effect.succeed(queue ?? Value.undef),
    "effect/Queue:isQueue": isKind("Queue"),
    "effect/Queue:isDequeue": isKind("Queue"),
    "effect/Queue:isEnqueue": isKind("Queue"),
    "effect/Queue:make": made("Queue", ([given_], site) =>
      given_ === undefined || given_._tag === "Undef"
        ? Queue.make<V, Held>()
        : Effect.flatMap(
            options<{ readonly capacity?: number; readonly strategy?: "suspend" }>(
              "Queue.make",
              given_,
              site,
            ),
            (read) => Queue.make<V, Held>(read),
          ),
    ),
    // Every item until the queue is ended.
    "effect/Queue:collect": on<QD, Array<V>>(
      "Queue",
      "collect",
      1,
      (held) => Queue.collect(held),
      list,
      "collects a Queue that nothing ends",
    ),
    "effect/Queue:endUnsafe": now<QD, boolean>(
      "Queue",
      "endUnsafe",
      1,
      (held) => Queue.endUnsafe(held),
      bool,
    ),
    "effect/Queue:shutdownUnsafe": now<Q, boolean>(
      "Queue",
      "shutdownUnsafe",
      1,
      (held) => Queue.shutdownUnsafe(held),
      bool,
    ),
    "effect/Queue:interrupt": on<Q, boolean>(
      "Queue",
      "interrupt",
      1,
      (held) => Queue.interrupt(held),
      bool,
    ),
    "effect/Queue:failCause": later<Q, boolean>(
      "Queue",
      "failCause",
      2,
      (held, [cause], site) => {
        const real = realCause(cause);
        return real
          ? Effect.succeed(Queue.failCause(held, real))
          : wrongArguments(site, "Queue.failCause");
      },
      bool,
    ),
    "effect/Queue:offerAllUnsafe": dual("Queue.offerAllUnsafe", 2, ([self, given_], site) => {
      const held = heldOf<Q>("Queue", self);
      return held
        ? Effect.map(items("Queue.offerAllUnsafe", given_, site), (all) =>
            arr(Queue.offerAllUnsafe(held, all)),
          )
        : wrongArguments(site, "Queue.offerAllUnsafe");
    }),
    // What the effect gives is offered, and the queue is ended: how it ended otherwise fails the queue.
    "effect/Queue:into": onEffect("Queue.into", 1, (timeline, self, [queue], site) => {
      const held = heldOf<QD>("Queue", queue);
      return held
        ? Timeline.back(timeline, Queue.into(self, held), bool)
        : wrongArguments(site, "Queue.into");
    }),
    "effect/PubSub:isPubSub": isKind("PubSub"),
    "effect/PubSub:capacity": now<Hub, number>(
      "PubSub",
      "capacity",
      1,
      (held) => PubSub.capacity(held),
      num,
    ),
    "effect/PubSub:sizeUnsafe": now<Hub, number>(
      "PubSub",
      "sizeUnsafe",
      1,
      (held) => PubSub.sizeUnsafe(held),
      num,
    ),
    "effect/PubSub:isShutdown": on<Hub, boolean>(
      "PubSub",
      "isShutdown",
      1,
      (held) => PubSub.isShutdown(held),
      bool,
    ),
    "effect/PubSub:isShutdownUnsafe": now<Hub, boolean>(
      "PubSub",
      "isShutdownUnsafe",
      1,
      (held) => PubSub.isShutdownUnsafe(held),
      bool,
    ),
    "effect/PubSub:publishUnsafe": now<Hub, boolean>(
      "PubSub",
      "publishUnsafe",
      2,
      (held, [value]) => PubSub.publishUnsafe(held, value ?? Value.undef),
      bool,
    ),
    "effect/PubSub:awaitShutdown": on<Hub, void>(
      "PubSub",
      "awaitShutdown",
      1,
      (held) => PubSub.awaitShutdown(held),
      none,
      "waits for a PubSub that nothing shuts down",
    ),
    "effect/PubSub:takeBetween": dual("PubSub.takeBetween", 3, ([self, min, max], site) => {
      const held = heldOf<SB>("Subscription", self);
      if (!held) return wrongArguments(site, "PubSub.takeBetween");
      return Effect.map(
        Effect.all([
          count("PubSub.takeBetween", min, site),
          count("PubSub.takeBetween", max, site),
        ]),
        ([least, most]) =>
          timed(
            "PubSub.takeBetween",
            (timeline) =>
              Timeline.back(
                timeline,
                Timeline.waiting(
                  timeline,
                  "takes from a PubSub that nothing publishes to",
                  site,
                  PubSub.takeBetween(held, least, most),
                ),
                list,
              ),
            site,
          ),
      );
    }),
    "effect/Deferred:isDeferred": isKind("Deferred"),
    // The effect is run once, and what it gives is what every one who waits is given.
    "effect/Deferred:complete": later<D, boolean>(
      "Deferred",
      "complete",
      2,
      (held, [effect], site, timeline) => {
        const given_ = effectOf(timeline, effect, site);
        return given_
          ? Effect.succeed(Deferred.complete(held, given_))
          : wrongArguments(site, "Deferred.complete");
      },
      bool,
    ),
    "effect/Deferred:done": later<D, boolean>(
      "Deferred",
      "done",
      2,
      (held, [exit], site) => {
        const real = ended(exit);
        return real
          ? Effect.succeed(Deferred.done(held, real))
          : wrongArguments(site, "Deferred.done");
      },
      bool,
    ),
    "effect/Deferred:failCause": later<D, boolean>(
      "Deferred",
      "failCause",
      2,
      (held, [cause], site) => {
        const real = realCause(cause);
        return real
          ? Effect.succeed(Deferred.failCause(held, real))
          : wrongArguments(site, "Deferred.failCause");
      },
      bool,
    ),
    "effect/Deferred:failCauseSync": later<D, boolean>(
      "Deferred",
      "failCauseSync",
      2,
      (held, [f], site) =>
        Effect.flatMap(
          f ? host.call(f, [], site) : wrongArguments(site, "Deferred.failCauseSync"),
          (cause) => {
            const real = realCause(cause);
            return real
              ? Effect.succeed(Deferred.failCause(held, real))
              : wrongArguments(site, "Deferred.failCauseSync");
          },
        ),
      bool,
    ),
    // How the effect ends is how the Deferred is completed.
    "effect/Deferred:into": onEffect("Deferred.into", 1, (timeline, self, [deferred], site) => {
      const held = heldOf<D>("Deferred", deferred);
      return held
        ? Timeline.back(timeline, Deferred.into(self, held), bool)
        : wrongArguments(site, "Deferred.into");
    }),
  };

  // ---- The rest of `Schedule`: a schedule changed by a function of the code.

  /** What a schedule tells a function of each turn, as the code holds it. The clock's own time is not told. */
  const turnOf = (meta: Schedule.Metadata<unknown, unknown>): V => {
    const input: unknown = meta.input;
    const clock: V = { _tag: "Opaque", what: "the time a schedule reads off the clock" };
    return Value.obj({
      input:
        typeof input === "object" && input !== null && "_tag" in input && input._tag === "Rejected"
          ? (input as Held).rejection
          : outputOf(input),
      output: outputOf(meta.output),
      attempt: num(meta.attempt),
      elapsed: num(meta.elapsed),
      elapsedSincePrevious: num(meta.elapsedSincePrevious),
      duration: durationOf(meta.duration),
      start: clock,
      now: clock,
    });
  };
  /** A function of the code a schedule calls on each turn, on the timeline of the handler that runs it. */
  const eachTurn =
    <A>(body: (turn: V) => Eval<A>) =>
    (meta: Schedule.Metadata<unknown, unknown>): Effect.Effect<A, Held> =>
      Effect.flatMap(Effect.service(Timeline.Current), (timeline) =>
        timeline
          ? Timeline.real(timeline, body(turnOf(meta)))
          : Effect.die("a schedule is run on the timeline of a handler"),
      );
  const anyInput = (self: Schedule.Schedule<unknown, unknown>) =>
    self as Schedule.Schedule<unknown, unknown, Held>;
  /** A schedule changed by a function of the code: a failure of the function is the effect's that runs it. */
  const onTurns = (
    name: string,
    arity: number,
    made_: (
      self: Schedule.Schedule<unknown, unknown>,
      rest: ReadonlyArray<V>,
      site: Site,
    ) => Eval<Schedule.Schedule<unknown, unknown, Held>>,
  ): Model =>
    onSchedule(name, arity, (self, rest, site) =>
      Effect.map(
        made_(self, rest, site),
        (changed) => changed as unknown as Schedule.Schedule<unknown, unknown>,
      ),
    );

  const turns: Models = {
    "effect/Schedule:isSchedule": ([value]) =>
      Effect.succeed(bool(scheduleOf(value) !== undefined)),
    "effect/Schedule:identity": schedule("Schedule.identity", () =>
      Effect.sync(() => Schedule.identity<unknown>()),
    ),
    "effect/Schedule:during": schedule("Schedule.during", ([duration], site) =>
      Effect.map(written("Schedule.during", duration, site), (time) => Schedule.during(time)),
    ),
    "effect/Schedule:setInputType": () =>
      Effect.succeed(
        native("Schedule.setInputType", ([self]) => Effect.succeed(self ?? Value.undef)),
      ),
    // What the schedule gives each turn, as the function makes it.
    "effect/Schedule:map": onTurns("Schedule.map", 2, (self, [f], site) =>
      f
        ? Effect.sync(() =>
            Schedule.map(
              anyInput(self),
              eachTurn((turn) =>
                Effect.flatMap(host.call(f, [turn], site), (made_) =>
                  made_._tag === "Effect" ? made_.run : Effect.succeed(made_),
                ),
              ),
            ),
          )
        : wrongArguments(site, "Schedule.map"),
    ),
    "effect/Schedule:tap": onTurns("Schedule.tap", 2, (self, [f], site) =>
      f
        ? Effect.sync(() =>
            Schedule.tap(
              anyInput(self),
              eachTurn((turn) => ran(f, [turn], site)),
            ),
          )
        : wrongArguments(site, "Schedule.tap"),
    ),
    // It goes on while the function says so.
    "effect/Schedule:while": onTurns("Schedule.while", 2, (self, [f], site) =>
      f
        ? Effect.sync(() =>
            Schedule.while(
              anyInput(self),
              eachTurn((turn) =>
                Effect.flatMap(host.call(f, [turn], site), (made_) =>
                  made_._tag === "Effect"
                    ? Effect.flatMap(made_.run, (held) => host.decide(held, site))
                    : host.decide(made_, site),
                ),
              ),
            ),
          )
        : wrongArguments(site, "Schedule.while"),
    ),
    // A wait the function adds to the one the schedule gives, or puts in its place.
    "effect/Schedule:addDelay": onTurns("Schedule.addDelay", 2, (self, [f], site) =>
      f
        ? Effect.sync(() =>
            Schedule.addDelay(
              anyInput(self),
              eachTurn((turn) =>
                Effect.flatMap(ran(f, [turn], site), (more_) =>
                  written("Schedule.addDelay", more_, site),
                ),
              ),
            ),
          )
        : wrongArguments(site, "Schedule.addDelay"),
    ),
    "effect/Schedule:modifyDelay": onTurns("Schedule.modifyDelay", 2, (self, [f], site) =>
      f
        ? Effect.sync(() =>
            Schedule.modifyDelay(
              anyInput(self),
              eachTurn((turn) =>
                Effect.flatMap(ran(f, [turn], site), (next) =>
                  written("Schedule.modifyDelay", next, site),
                ),
              ),
            ),
          )
        : wrongArguments(site, "Schedule.modifyDelay"),
    ),
  };

  // ---- Yet more of `Effect`.

  /** A function that is its argument: `Effect.satisfiesSuccessType<number>()(effect)`. */
  const itself =
    (name: string): Model =>
    () =>
      Effect.succeed(native(name, ([self]) => Effect.succeed(self ?? Value.undef)));
  /** An effect that ends as a cause of the code says. */
  const endedBy = (cause: V | undefined, site: Site, name: string): Eval<never> => {
    const real = realCause(cause);
    if (!real) return wrongArguments(site, name);
    const [die, fail] = [
      real.reasons.find(Cause.isDieReason),
      real.reasons.find(Cause.isFailReason),
    ];
    if (die && isOurDefect(die.defect))
      return Effect.fail(new Value.Rejected({ rejection: die.defect.defect, defect: true }));
    return fail ? Effect.fail(fail.error) : Effect.interrupt;
  };
  /** `restore`, as the code is given it: an effect that may be interrupted again. */
  const restoring = (
    timeline: Timeline.Timeline,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ): V =>
    native("restore", ([given_], at) =>
      given_?._tag === "Effect"
        ? Effect.succeed(effectFrom(timeline, restore(Timeline.real(timeline, given_.run))))
        : wrongArguments(at, "restore"),
    );
  const masked =
    (
      name: string,
      mask: (
        f: (
          restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
        ) => Effect.Effect<V, Held>,
      ) => Effect.Effect<V, Held>,
    ): Model =>
    ([f], site) =>
      f
        ? Effect.succeed(
            timed(
              name,
              (timeline) =>
                Timeline.back(
                  timeline,
                  mask((restore) => called(timeline, f, site)(restoring(timeline, restore))),
                  same,
                ),
              site,
            ),
          )
        : wrongArguments(site, name);

  const yetMore: Models = {
    "effect/Effect:matchCauseEager": (args, site) =>
      (models["effect/Effect:matchCause"] ?? alias("effect/Effect:matchCause"))(args, site),
    "effect/Effect:matchCauseEffectEager": (args, site) =>
      (models["effect/Effect:matchCauseEffect"] ?? alias("effect/Effect:matchCauseEffect"))(
        args,
        site,
      ),
    "effect/Effect:satisfiesSuccessType": itself("Effect.satisfiesSuccessType"),
    "effect/Effect:satisfiesErrorType": itself("Effect.satisfiesErrorType"),
    "effect/Effect:satisfiesServicesType": itself("Effect.satisfiesServicesType"),
    // What an effect is measured by decides nothing.
    "effect/Effect:track": watched("Effect.track"),
    "effect/Effect:trackDuration": watched("Effect.trackDuration"),
    "effect/Effect:trackErrors": watched("Effect.trackErrors"),
    "effect/Effect:trackSuccesses": watched("Effect.trackSuccesses"),
    "effect/Effect:trackDefects": watched("Effect.trackDefects"),
    "effect/Effect:logWithLevel": () =>
      Effect.succeed(
        native("Effect.logWithLevel", () =>
          Effect.succeed(lazy(() => Effect.succeed(Value.undef))),
        ),
      ),
    "effect/Effect:yieldNowWith": () =>
      Effect.succeed(lazy(() => Effect.as(Effect.yieldNow, Value.undef))),
    "effect/Effect:failCauseSync": ([f], site) =>
      f
        ? Effect.succeed(
            lazy(() =>
              Effect.flatMap(host.call(f, [], site), (cause) =>
                endedBy(cause, site, "Effect.failCauseSync"),
              ),
            ),
          )
        : wrongArguments(site, "Effect.failCauseSync"),
    // Nothing, or the effect's value in an Option.
    "effect/Effect:transposeOption": ([given_], site) => {
      const option_ = Value.optionOf(given_);
      if (!option_) return wrongArguments(site, "Effect.transposeOption");
      if (option_._tag === "None") return Effect.succeed(lazy(() => Effect.succeed(Value.none)));
      const inner = option_.value;
      return inner._tag === "Effect"
        ? Effect.succeed(lazy(() => Effect.map(inner.run, Value.some)))
        : wrongArguments(site, "Effect.transposeOption");
    },
    // Every item is tried: the errors of the ones that fail, all of them, or what each gave.
    "effect/Effect:validate": dualBy(
      "Effect.validate",
      (v) => !callable(v),
      ([given_, f, options_], site) => {
        const fields = options_?._tag === "Obj" ? options_.fields : {};
        if (!f || Object.keys(fields).some((key) => key !== "discard"))
          return wrongArguments(site, "Effect.validate");
        const discard = fields.discard?._tag === "Bool" && fields.discard.value;
        return Effect.succeed(
          lazy(() =>
            Effect.gen(function* () {
              const all = yield* items("Effect.validate", given_, site);
              const [errors, values]: [Array<V>, Array<V>] = [[], []];
              for (const [index, item] of all.entries()) {
                const error = yield* Effect.matchEffect(ran(f, [item, num(index)], site), {
                  onSuccess: (value) =>
                    Effect.sync(() => {
                      values.push(value);
                      return undefined as V | undefined;
                    }),
                  onFailure: (stop): Eval<V | undefined> =>
                    stop._tag === "Rejected" && stop.defect !== true
                      ? Effect.succeed(stop.rejection)
                      : Effect.fail(stop),
                });
                if (error) errors.push(error);
              }
              if (errors.length > 0) return yield* new Value.Rejected({ rejection: arr(errors) });
              return discard ? Value.undef : arr(values);
            }),
          ),
        );
      },
    ),
    "effect/Effect:repeatOrElse": onEffect(
      "Effect.repeatOrElse",
      2,
      (timeline, self, [given_, orElse], site) => {
        const held = scheduleOf(given_);
        return held && orElse
          ? Timeline.back(
              timeline,
              Effect.repeatOrElse(
                turn("Effect.repeatOrElse", timeline, self, site),
                held,
                (error, last) =>
                  called(
                    timeline,
                    orElse,
                    site,
                  )(error.rejection, option(Option.map(last, outputOf))),
              ),
              outputOf,
            )
          : wrongArguments(site, "Effect.repeatOrElse");
      },
    ),
    "effect/Effect:scheduleFrom": onEffect(
      "Effect.scheduleFrom",
      2,
      (timeline, self, [initial, given_], site) => {
        const held = scheduleOf(given_);
        return held
          ? Timeline.back(
              timeline,
              Effect.scheduleFrom(
                turn("Effect.scheduleFrom", timeline, self, site),
                initial ?? Value.undef,
                held,
              ),
              outputOf,
            )
          : wrongArguments(site, "Effect.scheduleFrom");
      },
    ),
    // What it gives, and an effect that forgets it.
    "effect/Effect:cachedInvalidateWithTTL": onEffect(
      "Effect.cachedInvalidateWithTTL",
      1,
      (timeline, self, [ttl], site) =>
        Effect.flatMap(written("Effect.cachedInvalidateWithTTL", ttl, site), (time) =>
          Timeline.back(
            timeline,
            Effect.cachedInvalidateWithTTL(self, time),
            ([kept_, invalidate]) =>
              arr([
                effectFrom(timeline, kept_),
                effectFrom(timeline, Effect.as(invalidate, Value.undef)),
              ]),
          ),
        ),
    ),
    "effect/Effect:onExitIf": onEffect("Effect.onExitIf", 2, (timeline, self, [test, f], site) =>
      f
        ? Timeline.back(
            timeline,
            Effect.onExit(self, (exit) =>
              sure(
                Effect.flatMap(Timeline.real(timeline, exitOf(timeline, exit)), (held) =>
                  Effect.flatMap(holding(timeline, test, held, site), (holds) =>
                    holds ? called(timeline, f, site)(held) : Effect.succeed(Value.undef),
                  ),
                ),
              ),
            ),
            same,
          )
        : wrongArguments(site, "Effect.onExitIf"),
    ),
    "effect/Effect:awaitAllChildren": onEffect("Effect.awaitAllChildren", 0, (timeline, self) =>
      Timeline.back(timeline, Effect.awaitAllChildren(self), same),
    ),
    "effect/Effect:uninterruptibleMask": masked("Effect.uninterruptibleMask", (f) =>
      Effect.uninterruptibleMask(f),
    ),
    "effect/Effect:interruptibleMask": masked("Effect.interruptibleMask", (f) =>
      Effect.interruptibleMask(f),
    ),
    // The function is called at once, and given what ends the effect: the effect ends when it is called.
    "effect/Effect:callback": ([register], site) =>
      register
        ? Effect.succeed(
            timed(
              "Effect.callback",
              (timeline) =>
                Timeline.back(
                  timeline,
                  Timeline.waiting(
                    timeline,
                    "waits for an Effect.callback that nothing ends",
                    site,
                    Effect.callback<V, Held>((resume) => {
                      const ending = native("resume", ([given_], at) =>
                        given_?._tag === "Effect"
                          ? Effect.sync(() => {
                              resume(Timeline.real(timeline, given_.run));
                              return Value.undef;
                            })
                          : wrongArguments(at, "resume"),
                      );
                      try {
                        const cleanup = host.atOnce(register, [ending], site);
                        return cleanup._tag === "Effect"
                          ? sure(Timeline.real(timeline, cleanup.run))
                          : undefined;
                      } catch {
                        resume(
                          Timeline.real(
                            timeline,
                            unseen(
                              site,
                              "calls Effect.callback with a function the prover cannot run at once",
                            ),
                          ),
                        );
                        return undefined;
                      }
                    }),
                  ),
                  same,
                ),
              site,
            ),
          )
        : wrongArguments(site, "Effect.callback"),
  };

  // ---- The last few of Fiber, Queue, PubSub, Deferred, Scope, Cache and Pool.

  const id = (v: V | undefined): number | undefined => (v?._tag === "Num" ? v.value : undefined);
  const lastFew: Models = {
    "effect/Fiber:isFiber": ([value]) =>
      Effect.succeed(bool(heldOf<F>("Fiber", value) !== undefined)),
    "effect/Fiber:awaitAll": (args, site) =>
      Effect.map(fibersOf("Fiber.awaitAll", args[0], site), (held) =>
        timed(
          "Fiber.awaitAll",
          (timeline) =>
            Effect.flatMap(
              Timeline.waiting(timeline, FIBER_WAIT, site, Fiber.awaitAll(held)),
              (exits) =>
                Effect.map(
                  Effect.forEach(exits, (exit) => exitOf(timeline, exit)),
                  list,
                ),
            ),
          site,
        ),
      ),
    "effect/Fiber:interruptAs": on<F, void>(
      "Fiber",
      "interruptAs",
      2,
      (held, [by]) => Fiber.interruptAs(held, id(by)),
      none,
    ),
    "effect/Fiber:interruptAllAs": dual("Fiber.interruptAllAs", 2, ([fibers_, by], site) =>
      Effect.map(fibersOf("Fiber.interruptAllAs", fibers_, site), (held) =>
        given("Fiber.interruptAllAs", Fiber.interruptAllAs(held, id(by) ?? 0), none, site),
      ),
    ),
    // The fiber is interrupted when the scope closes: it is the fiber it was.
    "effect/Fiber:runIn": dual("Fiber.runIn", 2, ([self, scope], site) => {
      const fiber = heldOf<F>("Fiber", self);
      const held = heldOf<Scope.Scope>("Scope", scope);
      return self && fiber && held
        ? Effect.sync(() => {
            Fiber.runIn(fiber, held);
            return self;
          })
        : wrongArguments(site, "Fiber.runIn");
    }),
    "effect/Queue:await": on<Q, void>(
      "Queue",
      "await",
      1,
      (held) => Queue.await(held),
      none,
      "waits for a Queue that nothing ends",
    ),
    "effect/Queue:failCauseUnsafe": dual("Queue.failCauseUnsafe", 2, ([self, cause], site) => {
      const held = heldOf<Q>("Queue", self);
      const real = realCause(cause);
      return held && real
        ? Effect.sync(() => bool(Queue.failCauseUnsafe(held, real)))
        : wrongArguments(site, "Queue.failCauseUnsafe");
    }),
    "effect/Deferred:interruptWith": on<D, boolean>(
      "Deferred",
      "interruptWith",
      2,
      (held, [by]) => Deferred.interruptWith(held, id(by) ?? 0),
      bool,
    ),
    "effect/Scope:makeUnsafe": ([given_]) =>
      Effect.sync(() => wrap("Scope", Scope.makeUnsafe(strategy(given_)))),
    "effect/Scope:forkUnsafe": ([scope, given_], site) => {
      const held = heldOf<Scope.Scope>("Scope", scope);
      return held
        ? Effect.sync(() => wrap("Scope", Scope.forkUnsafe(held, strategy(given_))))
        : wrongArguments(site, "Scope.forkUnsafe");
    },
    "effect/Cache:getSuccess": byKey<C, Option.Option<V>>(
      "Cache",
      "getSuccess",
      2,
      (held, key) => Effect.succeed(Cache.getSuccess(held, key)),
      option,
    ),
    "effect/Cache:values": on<C, Iterable<V>>(
      "Cache",
      "values",
      1,
      (held) => Cache.values(held),
      (all) => arr([...all]),
    ),
    "effect/Pool:isPool": ([value]) =>
      Effect.succeed(bool(heldOf<PL>("Pool", value) !== undefined)),
  };

  // ---- Filters: a function of the code that passes a value on, or turns it away.

  type Sorted = NonNullable<ReturnType<typeof Brands.resultOf>>;
  const sortedOf = (name: string, made: V, site: Site): Eval<Sorted> => {
    const read = Brands.resultOf(made);
    return read ? Effect.succeed(read) : wrongArguments(site, name);
  };
  const filteredBy = (
    name: string,
    filter: V | undefined,
    args: ReadonlyArray<V>,
    site: Site,
  ): Eval<Sorted> =>
    filter
      ? Effect.flatMap(host.call(filter, args, site), (made) => sortedOf(name, made, site))
      : wrongArguments(site, name);
  /** The same, of a filter that gives an effect. */
  const filteredByEffect = (
    name: string,
    filter: V | undefined,
    args: ReadonlyArray<V>,
    site: Site,
  ): Eval<Sorted> =>
    filter
      ? Effect.flatMap(ran(filter, args, site), (made) => sortedOf(name, made, site))
      : wrongArguments(site, name);
  /** A failure the code can handle: not a defect, and not what stops the prover. */
  const handled = (stop: Value.Stop): stop is Value.Rejected =>
    stop._tag === "Rejected" && stop.defect !== true;
  const unset = (v: V | undefined): boolean => v === undefined || v._tag === "Undef";
  /** A function of an effect whose last argument may be left out. */
  const optional =
    (name: string, run: (self: Eval<V>, rest: ReadonlyArray<V>, site: Site) => Eval<V>): Model =>
    (args, site) =>
      onEffectPlain(
        name,
        args[0]?._tag === "Effect" ? args.length - 1 : args.length,
        run,
      )(args, site);
  const mapping = (name: string, by: typeof filteredBy, index: boolean, found: boolean): Model =>
    dualBy(
      name,
      (v) => !callable(v),
      ([given_, filter, options_], site) =>
        unset(options_)
          ? Effect.succeed(
              lazy(() =>
                Effect.gen(function* () {
                  const kept: Array<V> = [];
                  const all = yield* items(name, given_, site);
                  for (const [at, item] of all.entries()) {
                    const made = yield* by(name, filter, index ? [item, num(at)] : [item], site);
                    if (made._tag !== "Success") continue;
                    if (found) return Value.some(made.success);
                    kept.push(made.success);
                  }
                  return found ? Value.none : arr(kept);
                }),
              ),
            )
          : wrongArguments(site, name),
    );
  /** The reason an error holds, where the error has the tag the code names. */
  const reasonOf = (stop: Value.Stop, tag: V | undefined): V | undefined =>
    handled(stop) &&
    tag?._tag === "Str" &&
    tagOf(stop.rejection) === tag.value &&
    stop.rejection._tag === "Obj"
      ? stop.rejection.fields.reason
      : undefined;
  const sortedCause = (
    timeline: Timeline.Timeline,
    name: string,
    filter: V | undefined,
    held: V,
    site: Site,
  ): Effect.Effect<Sorted, Held> => Timeline.real(timeline, filteredBy(name, filter, [held], site));
  /** What a function of the code does with a cause a filter passes on: nothing with one it turns away. */
  const onPassed =
    (timeline: Timeline.Timeline, name: string, filter: V | undefined, f: V, site: Site) =>
    (cause: Cause.Cause<unknown>): Effect.Effect<V, Held> =>
      Effect.flatMap(causeTo(timeline, cause), (held) =>
        Effect.flatMap(sortedCause(timeline, name, filter, held, site), (made) =>
          made._tag === "Success"
            ? called(timeline, f, site)(made.success, held)
            : Effect.succeed(Value.undef),
        ),
      );

  const filters: Models = {
    "effect/Effect:filterMap": mapping("Effect.filterMap", filteredBy, false, false),
    "effect/Effect:filterMapEffect": mapping(
      "Effect.filterMapEffect",
      filteredByEffect,
      false,
      false,
    ),
    "effect/Effect:findFirstFilter": mapping(
      "Effect.findFirstFilter",
      filteredByEffect,
      true,
      true,
    ),
    "effect/Effect:filterMapOrElse": onEffectPlain(
      "Effect.filterMapOrElse",
      2,
      (self, [filter, orElse], site) =>
        Effect.flatMap(self, (value) =>
          Effect.flatMap(filteredBy("Effect.filterMapOrElse", filter, [value], site), (made) => {
            if (made._tag === "Success") return Effect.succeed(made.success);
            return orElse
              ? ran(orElse, [made.failure], site)
              : wrongArguments(site, "Effect.filterMapOrElse");
          }),
        ),
    ),
    "effect/Effect:filterMapOrFail": onEffectPlain(
      "Effect.filterMapOrFail",
      1,
      (self, [filter], site) =>
        Effect.flatMap(self, (value) =>
          Effect.flatMap(
            filteredBy("Effect.filterMapOrFail", filter, [value], site),
            (made): Eval<V> =>
              made._tag === "Success"
                ? Effect.succeed(made.success)
                : Effect.fail(
                    new Value.Rejected({ rejection: Value.libraryError("NoSuchElementError") }),
                  ),
          ),
        ),
    ),
    "effect/Effect:head": onEffectPlain("Effect.head", 0, (self, _, site) =>
      Effect.flatMap(self, (value) =>
        Effect.flatMap(items("Effect.head", value, site), (all): Eval<V> =>
          all[0]
            ? Effect.succeed(all[0])
            : Effect.fail(
                new Value.Rejected({ rejection: Value.libraryError("NoSuchElementError") }),
              ),
        ),
      ),
    ),
    // An error the filter turns away is still what the effect fails with, where nothing is given for it.
    "effect/Effect:catchFilter": optional("Effect.catchFilter", (self, [filter, f, orElse], site) =>
      f
        ? Effect.catchIf(self, handled, (stop) =>
            Effect.flatMap(
              filteredBy("Effect.catchFilter", filter, [stop.rejection], site),
              (made): Eval<V> => {
                if (made._tag === "Success") return ran(f, [made.success], site);
                return orElse && !unset(orElse)
                  ? ran(orElse, [made.failure], site)
                  : Effect.fail(stop);
              },
            ),
          )
        : wrongArguments(site, "Effect.catchFilter"),
    ),
    "effect/Effect:catchCauseFilter": onEffect(
      "Effect.catchCauseFilter",
      2,
      (timeline, self, [filter, f], site) =>
        f
          ? Timeline.back(
              timeline,
              Effect.catchCause(self, (cause) =>
                Effect.flatMap(causeTo(timeline, cause), (held) =>
                  Effect.flatMap(
                    sortedCause(timeline, "Effect.catchCauseFilter", filter, held, site),
                    (made): Effect.Effect<V, unknown> =>
                      made._tag === "Success"
                        ? called(timeline, f, site)(made.success, held)
                        : Effect.failCause(realCause(made.failure) ?? cause),
                  ),
                ),
              ),
              same,
            )
          : wrongArguments(site, "Effect.catchCauseFilter"),
    ),
    "effect/Effect:onErrorFilter": onEffect(
      "Effect.onErrorFilter",
      2,
      (timeline, self, [filter, f], site) =>
        f
          ? Timeline.back(
              timeline,
              Effect.onError(self, (cause) => {
                const passed = onPassed(timeline, "Effect.onErrorFilter", filter, f, site);
                return sure(passed(cause));
              }),
              same,
            )
          : wrongArguments(site, "Effect.onErrorFilter"),
    ),
    "effect/Effect:tapCauseFilter": onEffect(
      "Effect.tapCauseFilter",
      2,
      (timeline, self, [filter, f], site) =>
        f
          ? Timeline.back(
              timeline,
              Effect.tapCause(self, onPassed(timeline, "Effect.tapCauseFilter", filter, f, site)),
              same,
            )
          : wrongArguments(site, "Effect.tapCauseFilter"),
    ),
    "effect/Effect:onExitFilter": onEffect(
      "Effect.onExitFilter",
      2,
      (timeline, self, [filter, f], site) =>
        f
          ? Timeline.back(
              timeline,
              Effect.onExit(self, (exit) =>
                Effect.flatMap(Timeline.real(timeline, exitOf(timeline, exit)), (held) =>
                  Effect.flatMap(
                    sortedCause(timeline, "Effect.onExitFilter", filter, held, site),
                    (made) =>
                      made._tag === "Success"
                        ? called(timeline, f, site)(made.success, held)
                        : Effect.succeed(Value.undef),
                  ),
                ),
              ),
              same,
            )
          : wrongArguments(site, "Effect.onExitFilter"),
    ),
    // An error that holds a reason: handled by the reason, where the error has the tag.
    "effect/Effect:catchReason": optional(
      "Effect.catchReason",
      (self, [errorTag, reasonTag, f, orElse], site) =>
        f && reasonTag?._tag === "Str"
          ? Effect.catchIf(
              self,
              (stop): stop is Value.Rejected => reasonOf(stop, errorTag) !== undefined,
              (stop): Eval<V> => {
                const reason = reasonOf(stop, errorTag)!;
                if (tagOf(reason) === reasonTag.value)
                  return ran(f, [reason, stop.rejection], site);
                return orElse && !unset(orElse)
                  ? ran(orElse, [reason, stop.rejection], site)
                  : Effect.fail(stop);
              },
            )
          : wrongArguments(site, "Effect.catchReason"),
    ),
    "effect/Effect:catchReasons": optional(
      "Effect.catchReasons",
      (self, [errorTag, cases, orElse], site) =>
        cases?._tag === "Obj"
          ? Effect.catchIf(
              self,
              (stop): stop is Value.Rejected => reasonOf(stop, errorTag) !== undefined,
              (stop): Eval<V> => {
                const reason = reasonOf(stop, errorTag)!;
                const handler = cases.fields[tagOf(reason) ?? ""];
                if (handler && !unset(handler)) return ran(handler, [reason, stop.rejection], site);
                return orElse && !unset(orElse)
                  ? ran(orElse, [reason, stop.rejection], site)
                  : Effect.fail(stop);
              },
            )
          : wrongArguments(site, "Effect.catchReasons"),
    ),
    "effect/Effect:unwrapReason": onEffectPlain("Effect.unwrapReason", 1, (self, [errorTag]) =>
      Effect.catchIf(
        self,
        (stop): stop is Value.Rejected => reasonOf(stop, errorTag) !== undefined,
        (stop) => Effect.fail(new Value.Rejected({ rejection: reasonOf(stop, errorTag)! })),
      ),
    ),
  };

  const models: Models = {
    ...yetMore,
    ...lastFew,
    ...filters,
    ...turns,
    ...rest,
    ...more,
    ...randoms,
    ...lifetimes,
    ...stores,
    ...requests,
    ...chunks,
    ...shared,
    ...kept,
    ...transactions,
    ...sets,
    ...changes,
    ...pubsubs,
    ...scopes,
    ...deferreds,
    ...queues,
    ...latches,
    ...semaphores,
    ...fibers,
    ...timing,
    ...schedules,
    ...concurrent,
  };

  /** What the models of streams over time are made with. */
  const tools = {
    span,
    written,
    count,
    items,
    together,
    flag,
    called,
    effectOf,
    scheduleOf,
    heldOf,
    wrap,
    exitOf,
    outputOf,
    sure,
    realCause,
    defectOf: (defect: unknown): V | undefined => (isOurDefect(defect) ? defect.defect : undefined),
    plainOf: (v: V | undefined): unknown => {
      const read = plainOf(v);
      return read === NOT_PLAIN ? undefined : read;
    },
  };

  return { models, sited, member, tools, constructs };
};
