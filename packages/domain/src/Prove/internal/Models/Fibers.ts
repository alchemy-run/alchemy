import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Brands from "../Brands.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, callable, dual, dualBy, lazy, native, wrongArguments } from "../Kit.ts";
import * as Timeline from "../Timeline.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

const REF: Value.Brand = { kind: "Ref", cls: undefined };
/** The field that says which of these a value is, and the one that holds the library's own. */
const IS = "~is";
const HELD = "~held";

type Kind = "Deferred" | "Queue" | "Latch" | "Semaphore" | "Fiber" | "Schedule";

/** How often effects may be run again in one handler before the prover stops reading. */
const MAX_TURNS = 100;

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
export const make = (kit: Kit, base: Models) => {
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

  const count = (name: string, v: V | undefined, site: Site): Eval<number> => {
    const n = whole(v);
    return n === undefined
      ? unseen(site, `calls ${name} without a count the prover can see`)
      : Effect.succeed(n);
  };

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
    if (fields.times !== undefined && fields.times._tag !== "Undef") {
      const times = whole(fields.times);
      if (times === undefined)
        return unseen(site, `calls ${name} without a count of times the prover can see`);
      out.times = times;
    }
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
    return Effect.succeed(out);
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
            unseen(site, `${name} runs an effect again more than ${MAX_TURNS} times`),
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

  /** A member of a latch or a semaphore, as the code reads it: `latch.open`, `semaphore.take`. */
  const member = (value: V, key: string, site: Site): V | undefined => {
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
    "effect/Schedule:forever": () => wrap("Schedule", Schedule.forever),
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

  const models: Models = {
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

  return { models, sited, member };
};
