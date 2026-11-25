import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Brands from "./Brands.ts";
import * as Compare from "./Compare.ts";
import { numeric, promote } from "./Compare.ts";
import type { Host, Model, Whole } from "./Kit.ts";
import * as Kit from "./Kit.ts";
import {
  arr,
  difference,
  done,
  dual,
  effect,
  keyed,
  keysOf,
  native,
  onEffect,
  onOption,
  onRecord,
  ordered,
  picked,
  product,
  str,
  sum,
  termOf,
  valueOfWhole,
  wholeOf,
  wrongArguments,
} from "./Kit.ts";
import * as Known from "./Known.ts";
import { hostOf } from "./Known.ts";
import * as Cells from "./Models/Cells.ts";
import * as Channels from "./Models/Channels.ts";
import * as Collections from "./Models/Collections.ts";
import * as Decimals from "./Models/Decimals.ts";
import * as Effects from "./Models/Effects.ts";
import * as Exits from "./Models/Exits.ts";
import * as Fibers from "./Models/Fibers.ts";
import * as Flows from "./Models/Flows.ts";
import * as Folds from "./Models/Folds.ts";
import * as Hashes from "./Models/Hashes.ts";
import * as Numbers from "./Models/Numbers.ts";
import * as Optics from "./Models/Optics.ts";
import * as Rationals from "./Models/Rationals.ts";
import * as Results from "./Models/Results.ts";
import * as Schemas from "./Models/Schemas.ts";
import * as Sinks from "./Models/Sinks.ts";
import * as Streams from "./Models/Streams.ts";
import * as Strings from "./Models/Strings.ts";
import type { Term } from "./Smt.ts";
import * as Smt from "./Smt.ts";
import * as Symbolic from "./Symbolic.ts";
import type { Eval, Site, V } from "./Value.ts";

export type { Host, Model, Step } from "./Kit.ts";
import * as Value from "./Value.ts";

/** Milliseconds in a day. */
const DAY = 86_400_000;

/** Milliseconds in each unit of `DateTime.add` that is the same length whenever it starts. */
const PARTS: Readonly<Record<string, number>> = {
  milliseconds: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: DAY,
  weeks: 7 * DAY,
};

/**
 * The library functions the prover knows, each written once as what it does
 * to a symbolic value. A call to any other library function is not
 * translated, and the report names the call.
 */
export const make = (host: Host) => {
  const kit = Kit.make(host);
  const { onArray, after: then } = kit;
  const duration = (millis: Whole): V => Brands.duration(valueOfWhole(millis));

  /**
   * `Effect.fn(body)`, `Effect.fn("name")(body)` and `Effect.fn(options)(body)`.
   * Functions after the body are applied to the effect it gives, each with
   * the arguments of the call after it.
   */
  const fn: Model = ([first, ...steps], site) => {
    if (first?._tag === "Str" || (first?._tag === "Obj" && steps.length === 0))
      return Effect.succeed(native("Effect.fn", fn));
    if (first?._tag !== "Fn") return wrongArguments(site, "Effect.fn");
    const body: V = { ...first, effectful: true };
    if (steps.length === 0) return Effect.succeed(body);
    return Effect.succeed(
      native(
        "Effect.fn",
        Effect.fnUntraced(function* (args: ReadonlyArray<V>, at: Site) {
          let made = yield* host.call(body, args, at);
          for (const step of steps) made = yield* host.call(step, [made, ...args], at);
          return made;
        }),
      ),
    );
  };

  const ignored: Model = () => Effect.succeed(done);

  const number =
    (
      name: string,
      fold: (a: number, b: number) => number,
      pick: (a: string, b: string) => string,
    ): Model =>
    (args, site) => {
      // Of any number of numbers, taken two at a time. Of none it is an infinity, which is not read.
      const [first, ...rest] = args;
      if (!first || !numeric(first)) return wrongArguments(site, name);
      let made: V = first;
      for (const next of rest) {
        const left = numeric(made);
        const right = numeric(next);
        if (!left || !right || Value.isBig(next) || Value.isBig(made))
          return wrongArguments(site, name);
        if (made._tag === "Num" && next._tag === "Num") {
          made = Value.num(fold(made.value, next.value));
          continue;
        }
        const [x, y] = promote(left, right);
        made = Value.term(x.sort, pick(x.text, y.text));
      }
      return Effect.succeed(made);
    };

  // The date of a UTC time, as text: `formatIsoDate` and `formatIsoDateUtc` give the same.
  const isoDate: Model = ([time], site) => {
    if (time?._tag !== "Time") return wrongArguments(site, "DateTime.formatIsoDate");
    const run = host.current.run;
    // A function of the day, not of the millisecond: the solver then learns
    // one fact per day it tries, instead of one per instant.
    const day = Smt.symbol(`day of ${time.millis.text.replaceAll("|", "")}`);
    if (!run.declarations.has(day)) {
      run.declarations.set(day, `(declare-const ${day} Int)`);
      run.assume(`(= ${day} (div ${time.millis.text} ${DAY}))`);
    }
    return Effect.succeed<V>({
      _tag: "Term",
      term: run.apply(
        "DateTime.formatIsoDate",
        { sort: "Int", text: day },
        "String",
        (at) => DateTime.formatIsoDate(DateTime.makeUnsafe(at * DAY)),
        // "2026-11-10": true of every day, so no day is ever "".
        (date) => `(= (str.len ${date.text}) 10)`,
        // Two days never share a date: the solver cannot invent a day that
        // reads as another, which it would otherwise try one day at a time.
        true,
      ),
    });
  };

  // Time. A time is its milliseconds since 1970 and a duration is a whole
  // number of milliseconds, so comparing, adding and subtracting them is
  // arithmetic on whole numbers.

  const instant = (v: V | undefined): Term | undefined =>
    v?._tag === "Time" ? v.millis : undefined;
  const time = (millis: Whole): V => ({ _tag: "Time", millis: termOf(millis) });

  /**
   * The milliseconds of what a function takes as a duration: a `Duration`, a
   * number of milliseconds, or text such as `"7 days"`. A duration that is not
   * a whole number of milliseconds is kept in nanoseconds by the library, and
   * is not read.
   */
  const span = (v: V | undefined): Whole | undefined => {
    if (v?._tag === "Obj") return wholeOf(Brands.durationOf(v));
    if (v?._tag !== "Str") return wholeOf(v);
    // Text that is no duration, or one that is not whole milliseconds, is not a whole number.
    const read = Duration.fromInput(v.value as Duration.Input);
    const millis = read._tag === "Some" ? Duration.toMillis(read.value) : Number.NaN;
    return wholeOf(Value.num(millis));
  };

  /** A function of two times, such as `DateTime.isLessThan`. */
  const onTimes = (name: string, body: (self: Term, that: Term) => V): Model =>
    dual(name, 2, ([self, that], site) => {
      const a = instant(self);
      const b = instant(that);
      return a && b ? Effect.succeed(body(a, b)) : wrongArguments(site, name);
    });

  /** A function of two durations, such as `Duration.sum`. */
  const onSpans = (name: string, body: (self: Whole, that: Whole) => V): Model =>
    dual(name, 2, ([self, that], site) => {
      const a = span(self);
      const b = span(that);
      return a !== undefined && b !== undefined
        ? Effect.succeed(body(a, b))
        : wrongArguments(site, name);
    });

  /** `Duration.days` and the like: so many of a unit. */
  const spanOf =
    (name: string, unit: number): Model =>
    ([count], site) => {
      const n = wholeOf(count);
      return n === undefined
        ? wrongArguments(site, name)
        : Effect.succeed(duration(product(n, unit)));
    };

  /** `Duration.toDays` and the like: a duration counted in a unit, which need not be whole. */
  const spanIn =
    (name: string, unit: number): Model =>
    ([self], site) => {
      const millis = span(self);
      if (millis === undefined) return wrongArguments(site, name);
      if (unit === 1) return Effect.succeed(valueOfWhole(millis));
      if (typeof millis === "number") return Effect.succeed(Value.num(millis / unit));
      return Effect.succeed<V>({
        _tag: "Term",
        term: { sort: "Real", text: `(/ (to_real ${millis.text}) ${Smt.real(unit).text})` },
        quotient: { dividend: millis.text, divisor: unit },
      });
    };

  /** `DateTime.addDuration` and `DateTime.subtractDuration`. */
  const shiftedBy = (name: string, sign: 1 | -1): Model =>
    dual(name, 2, ([self, by], site) => {
      const at = instant(self);
      const millis = span(by);
      return at && millis !== undefined
        ? Effect.succeed(time(sign === 1 ? sum(at, millis) : difference(at, millis)))
        : wrongArguments(site, name);
    });

  /**
   * `DateTime.add` and `DateTime.subtract`, in the units that are the same
   * length whenever they start. A month or a year is not: it is not read.
   */
  const shiftedByParts = (name: string, sign: 1 | -1): Model =>
    dual(name, 2, ([self, parts], site) => {
      const at = instant(self);
      if (!at || parts?._tag !== "Obj" || parts.brand) return wrongArguments(site, name);
      let moved: Whole = at;
      for (const [key, value] of Object.entries(parts.fields)) {
        const unit = PARTS[key];
        if (unit === undefined)
          return Effect.fail(
            Value.notTranslated(
              site,
              `${name} moves a time by ${key}, which are not all the same length`,
            ),
          );
        const count = wholeOf(value);
        if (count === undefined) return wrongArguments(site, name);
        const millis = product(count, unit);
        moved = sign === 1 ? sum(moved, millis) : difference(moved, millis);
      }
      return Effect.succeed(time(moved));
    });

  /**
   * What the clock reads: the time the command is handled at, which is what
   * `decide` is given as `now` and what the clock is set to while it runs.
   */
  const clock = (name: string, site: Site, read: (now: Term) => V): V =>
    effect(
      Effect.suspend(() => {
        const now = instant(host.now());
        return now
          ? Effect.succeed(read(now))
          : Effect.fail(
              Value.notTranslated(
                site,
                `reads the clock with ${name} outside decide, where the time is not an input`,
                true,
              ),
            );
      }),
    );

  /** The library's values that read the clock. */
  const clocks: Record<string, (site: Site) => V> = {
    "effect/Clock:currentTimeNanos": (site) =>
      clock("Clock.currentTimeNanos", site, (now) => ({
        _tag: "Term",
        term: { sort: "Int", text: `(* ${now.text} 1000000)` },
        big: true,
      })),
    "effect/Clock:currentTimeMillis": (site) =>
      clock("Clock.currentTimeMillis", site, (now) => ({ _tag: "Term", term: now })),
    "effect/DateTime:now": (site) => clock("DateTime.now", site, time),
  };

  /**
   * The clock a handler is given: what it reads is the time the command is
   * handled at. A monotonic clock is the machine's, and is not on it.
   */
  const clockObject = (site: Site): V => {
    const millis = clocks["effect/Clock:currentTimeMillis"]!(site);
    const nanos = clocks["effect/Clock:currentTimeNanos"]!(site);
    const now = (read: V, name: string): V =>
      native(name, () => (read._tag === "Effect" ? read.run : wrongArguments(site, name)));
    return Value.obj({
      currentTimeMillis: millis,
      currentTimeNanos: nanos,
      currentTimeMillisUnsafe: now(millis, "clock.currentTimeMillisUnsafe"),
      currentTimeNanosUnsafe: now(nanos, "clock.currentTimeNanosUnsafe"),
    });
  };
  /** `Clock.clockWith(f)`: the effect the function makes of the clock. */
  const clockWith: Model = ([f], site) =>
    f
      ? host.call(f, [clockObject(site)], site).pipe(
          Effect.flatMap((made) =>
            made._tag === "Effect" ? made.run : wrongArguments(site, "Clock.clockWith"),
          ),
          effect,
          Effect.succeed,
        )
      : wrongArguments(site, "Clock.clockWith");

  /** `DateTime.isPast` and `DateTime.isFuture`: a time against what the clock reads. */
  const against =
    (name: string, order: "<" | ">"): Model =>
    ([self], site) => {
      const at = instant(self);
      return at
        ? Effect.succeed(clock(name, site, (now) => ordered(order, now, at)))
        : wrongArguments(site, name);
    };

  /** `Option.fromNullishOr` and the two like it: what counts as nothing differs. */
  const fromNullable =
    (nothing: ReadonlyArray<V["_tag"]>): Model =>
    ([value]) =>
      Effect.succeed(!value || nothing.includes(value._tag) ? Value.none : Value.some(value));

  /** An array's own method, as the library's function of the same name. */
  const method = (name: string, as = name): Model =>
    onArray(`Array.${name}`, 2, (items, [fn], site) =>
      fn ? host.array(as, items, fn, undefined, site) : wrongArguments(site, `Array.${name}`),
    );

  /** `Math.floor` and the functions like it: a whole number stays what it is. */
  const whole =
    (
      name: string,
      fold: (n: number) => number,
      /** The result for a number that may not be whole, and for one whole number over another. */
      rounded: (text: string) => string,
      divided: (dividend: string, divisor: number) => string,
    ): Model =>
    ([value], site) => {
      if (value?._tag === "Num") return Effect.succeed(Value.num(fold(value.value)));
      if (value?._tag !== "Term" || value.big === true) return wrongArguments(site, name);
      if (value.term.sort === "Int") return Effect.succeed(value);
      if (value.term.sort !== "Real") return wrongArguments(site, name);
      return Effect.succeed(
        Value.term(
          "Int",
          value.quotient
            ? divided(value.quotient.dividend, value.quotient.divisor)
            : rounded(value.term.text),
        ),
      );
    };

  /** The floor of one whole number over another: the solver's `div`, which rounds down for a divisor above zero. */
  const floorOf = (dividend: string, divisor: number): string =>
    divisor > 0 ? `(div ${dividend} ${divisor})` : `(div (- ${dividend}) ${-divisor})`;
  const ceilOf = (dividend: string, divisor: number): string =>
    `(- ${floorOf(`(- ${dividend})`, divisor)})`;

  /** `pipe(value, f, g)`: each function applied to what the one before gave. */
  const piped: Model = Effect.fnUntraced(function* (args: ReadonlyArray<V>, site: Site) {
    const [first, ...steps] = args;
    if (!first) return yield* wrongArguments(site, "pipe");
    let value = first;
    for (const step of steps) value = yield* host.call(step, [value], site);
    return value;
  });

  /** One case of a matcher: whether it takes a value, and what it gives for one it takes. */
  interface Case {
    readonly takes: (input: V, site: Site) => Eval<boolean>;
    readonly handler: V;
  }
  /** A matcher being built: `Match.value(x)` has the value, `Match.type()` gets it when called. */
  interface Matcher {
    readonly subject: V | undefined;
    readonly cases: ReadonlyArray<Case>;
    /** `Match.fn(select)`: the input is what it gives of the arguments, which each handler is given too. */
    readonly select?: V;
  }
  const matcher = (state: Matcher): V => Value.obj({}, { kind: "Matcher", cls: state });
  const matcherOf = (value: V | undefined): Matcher | undefined =>
    value?._tag === "Obj" && value.brand?.kind === "Matcher"
      ? (value.brand.cls as Matcher)
      : undefined;

  /** Whether a pattern of `Match.when` takes a value: a predicate, a literal, or an object of patterns. */
  const takes = (pattern: V, input: V, site: Site): Eval<boolean> =>
    Effect.gen(function* () {
      if (pattern._tag === "Fn" || pattern._tag === "Native" || pattern._tag === "Lib")
        return yield* host.decide(yield* host.call(pattern, [input], site), site);
      if (pattern._tag === "Obj" && pattern.brand === undefined) {
        if (input._tag !== "Obj") return false;
        for (const [key, part] of Object.entries(pattern.fields))
          if (!(yield* takes(part, yield* host.member(input, key, site), site))) return false;
        return true;
      }
      return yield* host.decide(yield* host.equal(input, pattern, site), site);
    });

  /** Whether the field a matcher discriminates on is one of `values`. */
  const tagged =
    (field: string, values: ReadonlyArray<V>): Case["takes"] =>
    (input, site) =>
      Effect.gen(function* () {
        if (input._tag !== "Obj") return false;
        const tag = yield* host.member(input, field, site);
        for (const value of values)
          if (yield* host.decide(yield* host.equal(tag, value, site), site)) return true;
        return false;
      });

  /** Whether the field a matcher discriminates on is text the code can see, and starts with `prefix`. */
  const starting =
    (field: string, prefix: string): Case["takes"] =>
    (input, site) =>
      Effect.gen(function* () {
        if (input._tag !== "Obj") return false;
        const tag = host.force(yield* host.member(input, field, site));
        if (tag._tag === "Str") return tag.value.startsWith(prefix);
        if (host.kind(tag) !== "string") return false;
        // Text an input decides: asked as `String.startsWith` is.
        const asks = yield* strings.models["effect/String:startsWith"]!([Value.str(prefix)], site);
        return yield* host.decide(yield* host.call(asks, [tag], site), site);
      });
  /** One case for each key of an object of handlers: the value is that text, or that number. */
  const byLiteral = (handlers: V | undefined): ReadonlyArray<Case> | undefined =>
    handlers?._tag === "Obj" && !handlers.brand
      ? Object.entries(handlers.fields)
          .filter(([, handler]) => handler._tag !== "Undef")
          .map(([key, handler]) => ({
            takes: (input: V, site: Site) => {
              const kind = host.kind(input);
              const wanted =
                kind === "string"
                  ? Value.str(key)
                  : kind === "number" && String(Number(key)) === key
                    ? Value.num(Number(key))
                    : undefined;
              return wanted
                ? Effect.flatMap(host.equal(input, wanted, site), (equal) =>
                    host.decide(equal, site),
                  )
                : Effect.succeed(false);
            },
            handler,
          }))
      : undefined;

  /** A step of a matcher's pipe that adds cases: `Match.tag("A", f)` and the like. */
  const adding =
    (
      name: string,
      cases: (args: ReadonlyArray<V>, site: Site) => Eval<ReadonlyArray<Case>>,
    ): Model =>
    (args, site) =>
      cases(args, site).pipe(
        Effect.map((added) =>
          native(name, ([self], at) => {
            const state = matcherOf(self);
            return state
              ? Effect.succeed(matcher({ ...state, cases: [...state.cases, ...added] }))
              : wrongArguments(at, name);
          }),
        ),
      );

  /** The last argument is the handler; the ones before it are what it is for. */
  const handled = (args: ReadonlyArray<V>): readonly [ReadonlyArray<V>, V] | undefined => {
    const handler = args.at(-1);
    return handler && args.length >= 2 ? [args.slice(0, -1), handler] : undefined;
  };

  /** One case for each key of an object of handlers, on the field a matcher discriminates on. */
  const byField = (field: string, handlers: V | undefined): ReadonlyArray<Case> | undefined =>
    handlers?._tag === "Obj"
      ? Object.entries(handlers.fields).map(([tag, handler]) => ({
          takes: tagged(field, [Value.str(tag)]),
          handler,
        }))
      : undefined;

  /** Run a matcher on a value: the first case that takes it, or `otherwise`. */
  const matched = (
    state: Matcher,
    input: V,
    otherwise: (input: V, site: Site, args: ReadonlyArray<V>) => Eval<V>,
    wrap: (result: V) => V,
    site: Site,
    args: ReadonlyArray<V> = [],
  ): Eval<V> =>
    Effect.gen(function* () {
      for (const one of state.cases)
        if (yield* one.takes(input, site))
          return wrap(yield* host.call(one.handler, [input, ...args], site));
      return yield* otherwise(input, site, args);
    });

  /** The end of a matcher's pipe: the result for `Match.value`, a function for `Match.type`. */
  const finished = (
    name: string,
    state: Matcher | undefined,
    otherwise: (input: V, site: Site, args: ReadonlyArray<V>) => Eval<V>,
    wrap: (result: V) => V,
    site: Site,
  ): Eval<V> => {
    if (!state) return wrongArguments(site, name);
    if (state.subject) return matched(state, state.subject, otherwise, wrap, site);
    const select = state.select;
    return Effect.succeed(
      native(name, (args, at) =>
        select
          ? Effect.flatMap(host.call(select, args, at), (input) =>
              matched(state, input, otherwise, wrap, at, args),
            )
          : args[0]
            ? matched(state, args[0], otherwise, wrap, at)
            : wrongArguments(at, name),
      ),
    );
  };

  /** No case takes the value, where the code says one always does. */
  const fellThrough =
    (name: string) =>
    (_: V, site: Site): Eval<V> =>
      Effect.fail(Value.notTranslated(site, `${name} meets a value none of its cases takes`));

  const same = (result: V): V => result;

  /** `Match.tagsExhaustive(handlers)` and the like: cases, and the end of the pipe. */
  const exhaustively =
    (name: string, cases: (args: ReadonlyArray<V>) => ReadonlyArray<Case> | undefined): Model =>
    (args, site) => {
      const added = cases(args);
      return added
        ? Effect.succeed(
            native(name, ([self], at) => {
              const state = matcherOf(self);
              return finished(
                name,
                state && { ...state, cases: [...state.cases, ...added] },
                fellThrough(name),
                same,
                at,
              );
            }),
          )
        : wrongArguments(site, name);
    };

  const matchModels: Readonly<Record<string, Model>> = {
    "effect/Match:value": ([subject], site) =>
      subject
        ? Effect.succeed(matcher({ subject, cases: [] }))
        : wrongArguments(site, "Match.value"),
    "effect/Match:type": () => Effect.succeed(matcher({ subject: undefined, cases: [] })),
    // A matcher of a function's arguments: what `select` gives of them is matched.
    "effect/Match:fn": ([select], site) =>
      select
        ? Effect.succeed(matcher({ subject: undefined, cases: [], select }))
        : wrongArguments(site, "Match.fn"),
    // It only narrows the type of what the cases return.
    "effect/Match:withReturnType": () =>
      Effect.succeed(
        native("Match.withReturnType", ([self], at) =>
          matcherOf(self) && self
            ? Effect.succeed(self)
            : wrongArguments(at, "Match.withReturnType"),
        ),
      ),
    "effect/Match:when": adding("Match.when", ([pattern, handler], site) =>
      pattern && handler
        ? Effect.succeed([{ takes: (input, at) => takes(pattern, input, at), handler }])
        : wrongArguments(site, "Match.when"),
    ),
    "effect/Match:not": adding("Match.not", ([pattern, handler], site) =>
      pattern && handler
        ? Effect.succeed([
            {
              takes: (input, at) => Effect.map(takes(pattern, input, at), (taken) => !taken),
              handler,
            },
          ])
        : wrongArguments(site, "Match.not"),
    ),
    "effect/Match:whenOr": adding("Match.whenOr", (args, site) => {
      const parts = handled(args);
      return parts
        ? Effect.succeed([
            {
              takes: Effect.fnUntraced(function* (input: V, at: Site) {
                for (const pattern of parts[0]) if (yield* takes(pattern, input, at)) return true;
                return false;
              }),
              handler: parts[1],
            },
          ])
        : wrongArguments(site, "Match.whenOr");
    }),
    "effect/Match:whenAnd": adding("Match.whenAnd", (args, site) => {
      const parts = handled(args);
      return parts
        ? Effect.succeed([
            {
              takes: Effect.fnUntraced(function* (input: V, at: Site) {
                for (const pattern of parts[0])
                  if (!(yield* takes(pattern, input, at))) return false;
                return true;
              }),
              handler: parts[1],
            },
          ])
        : wrongArguments(site, "Match.whenAnd");
    }),
    "effect/Match:tag": adding("Match.tag", (args, site) => {
      const parts = handled(args);
      return parts
        ? Effect.succeed([{ takes: tagged("_tag", parts[0]), handler: parts[1] }])
        : wrongArguments(site, "Match.tag");
    }),
    "effect/Match:tags": adding("Match.tags", ([handlers], site) => {
      const cases = byField("_tag", handlers);
      return cases ? Effect.succeed(cases) : wrongArguments(site, "Match.tags");
    }),
    "effect/Match:tagsExhaustive": exhaustively("Match.tagsExhaustive", ([handlers]) =>
      byField("_tag", handlers),
    ),
    // `Match.discriminator("kind")("a", "b", f)`: the same, on a field the code names.
    "effect/Match:discriminator": ([field], site) => {
      const name = str(field);
      return name === undefined
        ? wrongArguments(site, "Match.discriminator")
        : Effect.succeed(
            native(
              "Match.discriminator",
              adding("Match.discriminator", (args, at) => {
                const parts = handled(args);
                return parts
                  ? Effect.succeed([{ takes: tagged(name, parts[0]), handler: parts[1] }])
                  : wrongArguments(at, "Match.discriminator");
              }),
            ),
          );
    },
    "effect/Match:discriminators": ([field], site) => {
      const name = str(field);
      return name === undefined
        ? wrongArguments(site, "Match.discriminators")
        : Effect.succeed(
            native(
              "Match.discriminators",
              adding("Match.discriminators", ([handlers], at) => {
                const cases = byField(name, handlers);
                return cases ? Effect.succeed(cases) : wrongArguments(at, "Match.discriminators");
              }),
            ),
          );
    },
    "effect/Match:discriminatorsExhaustive": ([field], site) => {
      const name = str(field);
      return name === undefined
        ? wrongArguments(site, "Match.discriminatorsExhaustive")
        : Effect.succeed(
            native(
              "Match.discriminatorsExhaustive",
              exhaustively("Match.discriminatorsExhaustive", ([handlers]) =>
                byField(name, handlers),
              ),
            ),
          );
    },
    // `Match.valueTags(value, handlers)`, or `Match.valueTags(handlers)` then the value.
    "effect/Match:valueTags": (args, site) => {
      const [first, second] = args;
      const run = (input: V, handlers: V | undefined, at: Site) => {
        const cases = byField("_tag", handlers);
        return cases
          ? matched({ subject: input, cases }, input, fellThrough("Match.valueTags"), same, at)
          : wrongArguments(at, "Match.valueTags");
      };
      if (args.length >= 2 && first) return run(first, second, site);
      return first
        ? Effect.succeed(
            native("Match.valueTags", ([input], at) =>
              input ? run(input, first, at) : wrongArguments(at, "Match.valueTags"),
            ),
          )
        : wrongArguments(site, "Match.valueTags");
    },
    "effect/Match:typeTags": () =>
      Effect.succeed(
        native("Match.typeTags", ([handlers], site) => {
          const cases = byField("_tag", handlers);
          return cases
            ? Effect.succeed(
                native("Match.typeTags", ([input], at) =>
                  input
                    ? matched(
                        { subject: input, cases },
                        input,
                        fellThrough("Match.typeTags"),
                        same,
                        at,
                      )
                    : wrongArguments(at, "Match.typeTags"),
                ),
              )
            : wrongArguments(site, "Match.typeTags");
        }),
      ),
    // What a pattern can be besides a literal: `Match.when(Match.defined, f)`.
    "effect/Match:any": () => Effect.succeed(Value.bool(true)),
    // What a value is, as a matcher asks: a number, text, and the like.
    ...Object.fromEntries(
      (["number", "string", "boolean", "bigint", "symbol"] as const).map(
        (kind): [string, Model] => [
          `effect/Match:${kind}`,
          ([input], site) => {
            const is = input ? host.kind(input) : undefined;
            return is === undefined
              ? wrongArguments(site, `Match.${kind}`)
              : Effect.succeed(Value.bool(is === kind));
          },
        ],
      ),
    ),
    "effect/Match:null": ([input], site) =>
      input && host.kind(input) !== undefined
        ? Effect.succeed(Value.bool(input._tag === "Null"))
        : wrongArguments(site, "Match.null"),
    "effect/Match:undefined": ([input], site) =>
      input && host.kind(input) !== undefined
        ? Effect.succeed(Value.bool(input._tag === "Undef"))
        : wrongArguments(site, "Match.undefined"),
    "effect/Match:nonEmptyString": ([input], site) => {
      if (!input || host.kind(input) === undefined)
        return wrongArguments(site, "Match.nonEmptyString");
      return host.kind(input) === "string"
        ? Effect.flatMap(host.member(input, "length", site), (length) =>
            host.arithmetic(">", length, Value.num(0), site),
          )
        : Effect.succeed(Value.bool(false));
    },
    // One of the values given: `Match.is("on", "off")`.
    "effect/Match:is": (wanted) =>
      Effect.succeed(
        native("Match.is", ([input], site) =>
          Effect.gen(function* () {
            for (const each of wanted)
              if (yield* host.decide(yield* host.equal(input ?? Value.undef, each, site), site))
                return Value.bool(true);
            return Value.bool(false);
          }),
        ),
      ),
    // `input instanceof cls`, as a predicate of a matcher.
    "effect/Match:instanceOf": ([cls], site) =>
      cls
        ? Effect.succeed(
            native("Match.instanceOf", ([input], at) =>
              host.instanceOf(input ?? Value.undef, cls, at),
            ),
          )
        : wrongArguments(site, "Match.instanceOf"),
    "effect/Match:instanceOfUnsafe": ([cls], site) =>
      cls
        ? Effect.succeed(
            native("Match.instanceOfUnsafe", ([input], at) =>
              host.instanceOf(input ?? Value.undef, cls, at),
            ),
          )
        : wrongArguments(site, "Match.instanceOfUnsafe"),
    // An object that is not an array: what `Predicate.isObject` holds of.
    "effect/Match:record": ([input], site) => {
      const is = input ? host.kind(input) : undefined;
      if (!input || is === undefined) return wrongArguments(site, "Match.record");
      const forced = host.force(input);
      return Effect.succeed(
        Value.bool(
          is === "object" &&
            forced._tag !== "Null" &&
            forced._tag !== "Arr" &&
            forced._tag !== "List",
        ),
      );
    },
    // A `Date`: the prover makes none, so only one a library gave is.
    "effect/Match:date": ([input], site) =>
      input && host.kind(input) !== undefined
        ? Effect.succeed(Value.bool(input._tag === "Host" && input.value instanceof Date))
        : wrongArguments(site, "Match.date"),
    "effect/Match:defined": ([input]) =>
      Effect.succeed(
        Value.bool(input !== undefined && input._tag !== "Null" && input._tag !== "Undef"),
      ),
    "effect/Match:exhaustive": ([self], site) =>
      finished("Match.exhaustive", matcherOf(self), fellThrough("Match.exhaustive"), same, site),
    "effect/Match:orElseAbsurd": ([self], site) =>
      finished(
        "Match.orElseAbsurd",
        matcherOf(self),
        fellThrough("Match.orElseAbsurd"),
        same,
        site,
      ),
    "effect/Match:orElse": ([otherwise], site) =>
      otherwise
        ? Effect.succeed(
            native("Match.orElse", ([self], at) =>
              finished(
                "Match.orElse",
                matcherOf(self),
                (input, from, args) => host.call(otherwise, [input, ...args], from),
                same,
                at,
              ),
            ),
          )
        : wrongArguments(site, "Match.orElse"),
    "effect/Match:option": ([self], site) =>
      finished("Match.option", matcherOf(self), () => Effect.succeed(Value.none), Value.some, site),
    // What the case gives, or the value none of them took.
    "effect/Match:result": ([self], site) =>
      finished(
        "Match.result",
        matcherOf(self),
        (input) => Effect.succeed(Brands.failure(input)),
        Brands.success,
        site,
      ),
    "effect/Match:tagStartsWith": adding("Match.tagStartsWith", ([prefix, handler], site) =>
      prefix?._tag === "Str" && handler
        ? Effect.succeed([{ takes: starting("_tag", prefix.value), handler }])
        : wrongArguments(site, "Match.tagStartsWith"),
    ),
    "effect/Match:discriminatorStartsWith": ([field], site) => {
      const name = str(field);
      return name === undefined
        ? wrongArguments(site, "Match.discriminatorStartsWith")
        : Effect.succeed(
            native(
              "Match.discriminatorStartsWith",
              adding("Match.discriminatorStartsWith", ([prefix, handler], at) =>
                prefix?._tag === "Str" && handler
                  ? Effect.succeed([{ takes: starting(name, prefix.value), handler }])
                  : wrongArguments(at, "Match.discriminatorStartsWith"),
              ),
            ),
          );
    },
    // A handler for each text or number the code writes: `Match.literals({ on: f, off: g })`.
    "effect/Match:literals": adding("Match.literals", ([handlers], site) => {
      const cases = byLiteral(handlers);
      return cases ? Effect.succeed(cases) : wrongArguments(site, "Match.literals");
    }),
    "effect/Match:literalsExhaustive": exhaustively("Match.literalsExhaustive", ([handlers]) =>
      byLiteral(handlers),
    ),
  };

  const own: Readonly<Record<string, Model>> = {
    ...matchModels,
    "effect/pipe:": piped,
    "effect/Function:pipe": piped,
    "effect/Option:some": ([value]) => Effect.succeed(Value.some(value ?? Value.undef)),
    "effect/Option:none": () => Effect.succeed(Value.none),
    "effect/Option:fromNullishOr": fromNullable(["Null", "Undef"]),
    "effect/Option:fromNullOr": fromNullable(["Null"]),
    "effect/Option:fromUndefinedOr": fromNullable(["Undef"]),
    "effect/Option:isSome": onOption("Option.isSome", 1, (option) =>
      Effect.succeed(Value.bool(option._tag === "Some")),
    ),
    "effect/Option:isNone": onOption("Option.isNone", 1, (option) =>
      Effect.succeed(Value.bool(option._tag === "None")),
    ),
    "effect/Option:match": onOption("Option.match", 2, (option, [cases], site) => {
      if (cases?._tag !== "Obj") return wrongArguments(site, "Option.match");
      const handler = cases.fields[option._tag === "Some" ? "onSome" : "onNone"];
      return handler
        ? host.call(handler, option._tag === "Some" ? [option.value] : [], site)
        : wrongArguments(site, "Option.match");
    }),
    "effect/Option:getOrElse": onOption("Option.getOrElse", 2, (option, [orElse], site) =>
      option._tag === "Some"
        ? Effect.succeed(option.value)
        : orElse
          ? host.call(orElse, [], site)
          : wrongArguments(site, "Option.getOrElse"),
    ),
    "effect/Option:getOrUndefined": onOption("Option.getOrUndefined", 1, (option) =>
      Effect.succeed(option._tag === "Some" ? option.value : Value.undef),
    ),
    "effect/Option:getOrNull": onOption("Option.getOrNull", 1, (option) =>
      Effect.succeed(option._tag === "Some" ? option.value : Value.nil),
    ),
    "effect/Option:orElse": onOption("Option.orElse", 2, (option, [orElse], site, self) =>
      option._tag === "Some"
        ? Effect.succeed(self)
        : orElse
          ? host.call(orElse, [], site)
          : wrongArguments(site, "Option.orElse"),
    ),
    "effect/Option:map": onOption("Option.map", 2, (option, [f], site) =>
      option._tag === "None"
        ? Effect.succeed(Value.none)
        : f
          ? host.call(f, [option.value], site).pipe(Effect.map(Value.some))
          : wrongArguments(site, "Option.map"),
    ),
    "effect/Option:flatMap": onOption("Option.flatMap", 2, (option, [f], site) =>
      option._tag === "None"
        ? Effect.succeed(Value.none)
        : f
          ? host.call(f, [option.value], site)
          : wrongArguments(site, "Option.flatMap"),
    ),
    "effect/Option:filter": onOption("Option.filter", 2, (option, [f], site, self) =>
      option._tag === "None"
        ? Effect.succeed(Value.none)
        : f
          ? host.call(f, [option.value], site).pipe(
              Effect.flatMap((kept) => host.decide(kept, site)),
              Effect.map((kept) => (kept ? self : Value.none)),
            )
          : wrongArguments(site, "Option.filter"),
    ),
    "effect/Option:exists": onOption("Option.exists", 2, (option, [f], site) =>
      option._tag === "None"
        ? Effect.succeed(Value.bool(false))
        : f
          ? host.call(f, [option.value], site).pipe(
              Effect.flatMap((held) => host.decide(held, site)),
              Effect.map(Value.bool),
            )
          : wrongArguments(site, "Option.exists"),
    ),
    "effect/Struct:omit": onRecord("Struct.omit", 2, (fields, [keys], site) =>
      keysOf("Struct.omit", keys, site).pipe(
        Effect.map((left) =>
          Value.obj(
            Object.fromEntries(Object.entries(fields).filter(([key]) => !left.includes(key))),
          ),
        ),
      ),
    ),
    "effect/Struct:pick": onRecord("Struct.pick", 2, (fields, [keys], site) =>
      keysOf("Struct.pick", keys, site).pipe(
        Effect.map((kept) =>
          Value.obj(
            Object.fromEntries(Object.entries(fields).filter(([key]) => kept.includes(key))),
          ),
        ),
      ),
    ),
    "effect/Record:get": onRecord("Record.get", 2, (fields, [key], site) =>
      keyed("Record.get", key, site).pipe(
        Effect.map((name) =>
          Object.hasOwn(fields, name) ? Value.some(fields[name]!) : Value.none,
        ),
      ),
    ),
    "effect/Record:has": onRecord("Record.has", 2, (fields, [key], site) =>
      keyed("Record.has", key, site).pipe(
        Effect.map((name) => Value.bool(Object.hasOwn(fields, name))),
      ),
    ),
    "effect/Record:set": onRecord("Record.set", 3, (fields, [key, value], site) =>
      keyed("Record.set", key, site).pipe(
        Effect.map((name) => Value.obj({ ...fields, [name]: value ?? Value.undef })),
      ),
    ),
    "effect/Record:remove": onRecord("Record.remove", 2, (fields, [key], site) =>
      keyed("Record.remove", key, site).pipe(
        Effect.map((name) =>
          Value.obj(Object.fromEntries(Object.entries(fields).filter(([own]) => own !== name))),
        ),
      ),
    ),
    "effect/Record:map": onRecord("Record.map", 2, (fields, [f], site) =>
      f
        ? Effect.forEach(Object.entries(fields), ([key, value]) =>
            host
              .call(f, [value, Value.str(key)], site)
              .pipe(Effect.map((made) => [key, made] as const)),
          ).pipe(Effect.map((entries) => Value.obj(Object.fromEntries(entries))))
        : wrongArguments(site, "Record.map"),
    ),
    "effect/Record:keys": onRecord("Record.keys", 1, (fields) =>
      Effect.succeed(arr(Object.keys(fields).map(Value.str))),
    ),
    "effect/Record:values": onRecord("Record.values", 1, (fields) =>
      Effect.succeed(arr(Object.values(fields))),
    ),
    "effect/Record:size": onRecord("Record.size", 1, (fields) =>
      Effect.succeed(Value.num(Object.keys(fields).length)),
    ),
    "effect/Record:isEmptyRecord": onRecord("Record.isEmptyRecord", 1, (fields) =>
      Effect.succeed(Value.bool(Object.keys(fields).length === 0)),
    ),
    "effect/Record:isEmptyReadonlyRecord": onRecord("Record.isEmptyReadonlyRecord", 1, (fields) =>
      Effect.succeed(Value.bool(Object.keys(fields).length === 0)),
    ),
    // ---- What the language gives by name: conversions, and a few functions of arrays and text.
    "String:": ([value], site) =>
      value === undefined
        ? Effect.succeed(Value.str(""))
        : host.arithmetic("+", Value.str(""), value, site),
    "Number:": ([value], site) => {
      if (value === undefined) return Effect.succeed(Value.num(0));
      if (
        value._tag === "Num" ||
        (value._tag === "Term" &&
          value.term.sort !== "Bool" &&
          value.term.sort !== "String" &&
          value.big !== true)
      )
        return Effect.succeed(value);
      if (value._tag === "Str" || value._tag === "Bool" || value._tag === "Big")
        return Effect.succeed(Value.num(Number(value.value)));
      if (value._tag === "Null") return Effect.succeed(Value.num(0));
      if (value._tag === "Undef") return Effect.succeed(Value.num(Number.NaN));
      if (value._tag === "Term" && value.term.sort === "Bool")
        return Effect.succeed(Value.term("Int", `(ite ${value.term.text} 1 0)`));
      return Effect.fail(
        Value.notTranslated(site, "calls Number on a value the prover cannot see"),
      );
    },
    "Boolean:": ([value], site) =>
      Effect.map(host.truth(value ?? Value.undef, site), Compare.fromTruth),
    "Number:isInteger": ([value]) =>
      Effect.succeed(
        value?._tag === "Num"
          ? Value.bool(Number.isInteger(value.value))
          : value?._tag === "Term" && value.big !== true && value.term.sort === "Int"
            ? Value.bool(true)
            : value?._tag === "Term" && value.big !== true && value.term.sort === "Real"
              ? Compare.fromTruth(`(is_int ${value.term.text})`)
              : Value.bool(false),
      ),
    "Number:isSafeInteger": ([value], site) =>
      value?._tag === "Num"
        ? Effect.succeed(Value.bool(Number.isSafeInteger(value.value)))
        : value?._tag === "Term"
          ? wrongArguments(site, "Number.isSafeInteger")
          : Effect.succeed(Value.bool(false)),
    // A number an input holds is one the prover takes to be a number: never NaN, never without end.
    "Number:isFinite": ([value]) =>
      Effect.succeed(
        Value.bool(
          value?._tag === "Num"
            ? Number.isFinite(value.value)
            : value?._tag === "Term" &&
                value.big !== true &&
                (value.term.sort === "Int" || value.term.sort === "Real"),
        ),
      ),
    "Number:isNaN": ([value]) =>
      Effect.succeed(Value.bool(value?._tag === "Num" && Number.isNaN(value.value))),
    "Number:parseInt": ([text, radix], site) => parsed("Number.parseInt", text, radix, site),
    "Number:parseFloat": ([text], site) => parsed("Number.parseFloat", text, undefined, site),
    "global:parseInt": ([text, radix], site) => parsed("parseInt", text, radix, site),
    "global:parseFloat": ([text], site) => parsed("parseFloat", text, undefined, site),
    "Array:isArray": ([value], site) =>
      value === undefined || value._tag === "Opaque" || value._tag === "Applied"
        ? wrongArguments(site, "Array.isArray")
        : Effect.succeed(Value.bool(value._tag === "Arr" || value._tag === "List")),
    "Array:of": (args) => Effect.succeed(host.fresh(arr(args))),
    "Array:from": ([given, map], site) =>
      Effect.gen(function* () {
        // `Array.from({ length: 3 }, f)`: that many places, each what the function gives.
        const size =
          given?._tag === "Obj" && !given.brand && given.fields.length?._tag === "Num"
            ? given.fields.length.value
            : undefined;
        const items =
          size !== undefined && Number.isInteger(size) && size >= 0 && size <= 1000
            ? Array.from({ length: size }, () => Value.undef)
            : given?._tag === "Str"
              ? // Text the code writes, a letter at a time.
                Array.from(given.value, Value.str)
              : given
                ? yield* kit.iterate(given, site)
                : undefined;
        if (!items) return yield* wrongArguments(site, "Array.from");
        return host.fresh(
          map && map._tag !== "Undef"
            ? yield* host.array("map", items, map, undefined, site)
            : arr(items),
        );
      }),
    "JSON:stringify": ([value, replacer, space], site) => {
      const real = value ? Known.real(value) : { value: undefined };
      const bare =
        (replacer === undefined || replacer._tag === "Null" || replacer._tag === "Undef") &&
        (space === undefined || space._tag === "Undef");
      // A value an input decides, where it is made of whole numbers, booleans and text the code writes.
      if (!real && value && bare)
        return Effect.flatMap(jsonOf(value, site), (text) =>
          text
            ? Effect.succeed(text)
            : Effect.fail(
                Value.notTranslated(site, "calls JSON.stringify on a value the prover cannot see"),
              ),
        );
      if (
        !real ||
        (replacer !== undefined && replacer._tag !== "Null" && replacer._tag !== "Undef")
      )
        return Effect.fail(
          Value.notTranslated(site, "calls JSON.stringify on a value the prover cannot see"),
        );
      const indent = space?._tag === "Num" || space?._tag === "Str" ? space.value : undefined;
      return Effect.try({
        try: () => {
          const text: string | undefined = JSON.stringify(real.value, null, indent);
          return text === undefined ? Value.undef : Value.str(text);
        },
        catch: () => Value.notTranslated(site, "calls JSON.stringify on a value it cannot write"),
      });
    },
    "JSON:parse": ([text], site) => {
      if (text?._tag !== "Str")
        return Effect.fail(
          Value.notTranslated(site, "calls JSON.parse on text the prover cannot see"),
        );
      return Effect.try({
        try: () => Known.known(JSON.parse(text.value) as unknown, "JSON.parse"),
        catch: () =>
          new Value.Rejected({
            rejection: Value.obj({ name: Value.str("SyntaxError") }),
            defect: true,
          }),
      }).pipe(
        Effect.flatMap((made) =>
          made ? Effect.succeed(made) : wrongArguments(site, "JSON.parse"),
        ),
      );
    },
    "global:structuredClone": ([value], site) => {
      const clone = (v: V): V | undefined => {
        if (v._tag === "Arr") {
          const items = v.items.map(clone);
          return items.every((item) => item !== undefined)
            ? host.fresh(arr(items as ReadonlyArray<V>))
            : undefined;
        }
        if (v._tag === "Obj" && !v.brand) {
          const fields: Record<string, V> = {};
          for (const [key, field] of Object.entries(v.fields)) {
            const made = clone(field);
            if (!made) return undefined;
            fields[key] = made;
          }
          return host.fresh(Value.obj(fields));
        }
        return ["Num", "Big", "Str", "Bool", "Null", "Undef", "Term"].includes(v._tag)
          ? v
          : undefined;
      };
      const made = value ? clone(host.force(value)) : Value.undef;
      return made
        ? Effect.succeed(made)
        : Effect.fail(
            Value.notTranslated(site, "calls structuredClone on a value the prover cannot copy"),
          );
    },
    // A symbol is equal only to itself.
    "global:Symbol": ([name]) =>
      Effect.sync((): V => ({
        _tag: "Host",
        value: Symbol(name?._tag === "Str" ? name.value : undefined),
        name: "a symbol",
      })),
    // The fields of each after the first are written into the first, which is what it gives.
    "Object:assign": ([target, ...sources], site) => {
      if (target?._tag !== "Obj" || target.brand) return wrongArguments(site, "Object.assign");
      for (const source of sources) {
        if (source._tag === "Undef" || source._tag === "Null") continue;
        if (source._tag !== "Obj" || source.brand) return wrongArguments(site, "Object.assign");
        Object.assign(target.fields as Record<string, V>, source.fields);
      }
      return Effect.succeed(target);
    },
    "Object:fromEntries": ([entries], site) =>
      Effect.flatMap(entries ? kit.iterate(entries, site) : Effect.succeed(undefined), (items) => {
        const fields: Record<string, V> = {};
        for (const entry of items ?? []) {
          const pair = kit.itemsOf(entry);
          const key = pair?.[0];
          if (!pair || (key?._tag !== "Str" && key?._tag !== "Num"))
            return wrongArguments(site, "Object.fromEntries");
          fields[String(key.value)] = pair[1] ?? Value.undef;
        }
        return items
          ? Effect.succeed(host.fresh(Value.obj(fields)))
          : wrongArguments(site, "Object.fromEntries");
      }),
    "Object:hasOwn": ([object, key], site) =>
      object?._tag === "Obj" && !object.brand && (key?._tag === "Str" || key?._tag === "Num")
        ? Effect.succeed(Value.bool(Object.hasOwn(object.fields, String(key.value))))
        : wrongArguments(site, "Object.hasOwn"),
    "Object:keys": onRecord("Object.keys", 1, (fields) =>
      Effect.succeed(arr(Object.keys(fields).map(Value.str))),
    ),
    "Object:values": onRecord("Object.values", 1, (fields) =>
      Effect.succeed(arr(Object.values(fields))),
    ),
    "Object:entries": onRecord("Object.entries", 1, (fields) =>
      Effect.succeed(
        arr(Object.entries(fields).map(([key, value]) => arr([Value.str(key), value]))),
      ),
    ),
    "effect/Array:map": method("map"),
    "effect/Array:filter": method("filter"),
    "effect/Array:flatMap": method("flatMap"),
    "effect/Array:some": method("some"),
    "effect/Array:every": method("every"),
    "effect/Array:reduce": onArray("Array.reduce", 3, (items, [initial, fn], site) =>
      initial && fn
        ? host.array("reduce", items, fn, initial, site)
        : wrongArguments(site, "Array.reduce"),
    ),
    "effect/Array:append": onArray("Array.append", 2, (items, [last]) =>
      Effect.succeed(arr([...items, last ?? Value.undef])),
    ),
    "effect/Array:prepend": onArray("Array.prepend", 2, (items, [head]) =>
      Effect.succeed(arr([head ?? Value.undef, ...items])),
    ),
    "effect/Array:appendAll": onArray("Array.appendAll", 2, (items, [more], site) => {
      const added = more ? host.force(more) : undefined;
      return added?._tag === "Arr"
        ? Effect.succeed(arr([...items, ...added.items]))
        : wrongArguments(site, "Array.appendAll");
    }),
    "effect/Array:length": onArray("Array.length", 1, (items) =>
      Effect.succeed(Value.num(items.length)),
    ),
    "effect/Array:isArrayEmpty": onArray("Array.isArrayEmpty", 1, (items) =>
      Effect.succeed(Value.bool(items.length === 0)),
    ),
    "effect/Array:isReadonlyArrayEmpty": onArray("Array.isReadonlyArrayEmpty", 1, (items) =>
      Effect.succeed(Value.bool(items.length === 0)),
    ),
    "effect/Array:isArrayNonEmpty": onArray("Array.isArrayNonEmpty", 1, (items) =>
      Effect.succeed(Value.bool(items.length > 0)),
    ),
    "effect/Array:isReadonlyArrayNonEmpty": onArray("Array.isReadonlyArrayNonEmpty", 1, (items) =>
      Effect.succeed(Value.bool(items.length > 0)),
    ),
    "effect/Array:head": onArray("Array.head", 1, (items) =>
      Effect.succeed(items[0] ? Value.some(items[0]) : Value.none),
    ),
    "effect/Array:last": onArray("Array.last", 1, (items) =>
      Effect.succeed(items.length > 0 ? Value.some(items[items.length - 1]!) : Value.none),
    ),
    "effect/Array:get": onArray("Array.get", 2, (items, [index], site) =>
      index?._tag === "Num"
        ? Effect.succeed(items[index.value] ? Value.some(items[index.value]!) : Value.none)
        : wrongArguments(site, "Array.get"),
    ),
    // A power the code writes: that many multiplications.
    "Math:pow": ([base, power], site) => {
      if (base?._tag === "Num" && power?._tag === "Num")
        return Effect.succeed(Value.num(Math.pow(base.value, power.value)));
      const times = power?._tag === "Num" ? power.value : undefined;
      if (!base || times === undefined || !Number.isInteger(times) || times < 0 || times > 16)
        return Effect.fail(
          Value.notTranslated(site, "raises a number to a power the prover cannot see"),
        );
      return Effect.gen(function* () {
        let out: V = Value.num(1);
        for (let turns = 0; turns < times; turns++)
          out = yield* host.arithmetic("*", out, base, site);
        return out;
      });
    },
    "Math:sign": ([value], site) =>
      value?._tag === "Num"
        ? Effect.succeed(Value.num(Math.sign(value.value)))
        : value?._tag === "Term" &&
            value.big !== true &&
            value.term.sort !== "Bool" &&
            value.term.sort !== "String"
          ? Effect.succeed(
              Value.term(
                "Int",
                `(ite (> ${value.term.text} 0) 1 (ite (< ${value.term.text} 0) (- 1) 0))`,
              ),
            )
          : wrongArguments(site, "Math.sign"),
    // The rest of `Math`, of numbers the code writes: the language's own.
    ...Object.fromEntries(
      "sqrt cbrt exp log log2 log10 sin cos tan atan atan2 hypot fround clz32 imul"
        .split(" ")
        .map((name): [string, Model] => [
          `Math:${name}`,
          (args, site) =>
            args.every((arg) => arg._tag === "Num")
              ? Effect.succeed(
                  Value.num(
                    (Math[name as "sqrt"] as (...given: ReadonlyArray<number>) => number)(
                      ...args.map((arg) => (arg._tag === "Num" ? arg.value : Number.NaN)),
                    ),
                  ),
                )
              : Effect.fail(
                  Value.notTranslated(
                    site,
                    `calls Math.${name}, which the prover has no model for`,
                    true,
                  ),
                ),
        ]),
    ),
    // A half goes up, as the language rounds one.
    "Math:round": whole(
      "Math.round",
      Math.round,
      (text) => `(to_int (+ ${text} 0.5))`,
      // Half more than the quotient, as one quotient: the solver divides it exactly.
      (dividend, divisor) =>
        divisor > 0
          ? floorOf(`(+ (* 2 ${dividend}) ${divisor})`, 2 * divisor)
          : floorOf(`(+ (* 2 (- ${dividend})) ${-divisor})`, -2 * divisor),
    ),
    "Math:floor": whole("Math.floor", Math.floor, (text) => `(to_int ${text})`, floorOf),
    "Math:ceil": whole("Math.ceil", Math.ceil, (text) => `(- (to_int (- ${text})))`, ceilOf),
    "Math:trunc": whole(
      "Math.trunc",
      Math.trunc,
      (text) => `(ite (>= ${text} 0.0) (to_int ${text}) (- (to_int (- ${text}))))`,
      (dividend, divisor) =>
        `(ite (>= ${divisor > 0 ? dividend : `(- ${dividend})`} 0) ${floorOf(dividend, divisor)} ${ceilOf(dividend, divisor)})`,
    ),
    "Math:abs": ([value], site) => {
      if (value?._tag === "Num") return Effect.succeed(Value.num(Math.abs(value.value)));
      if (
        value?._tag !== "Term" ||
        value.big === true ||
        value.quotient ||
        (value.term.sort !== "Int" && value.term.sort !== "Real")
      )
        return wrongArguments(site, "Math.abs");
      const zero = value.term.sort === "Int" ? "0" : "0.0";
      return Effect.succeed(
        Value.term(
          value.term.sort,
          `(ite (>= ${value.term.text} ${zero}) ${value.term.text} (- ${value.term.text}))`,
        ),
      );
    },
    "effect/Effect:fn": fn,
    "effect/Effect:fnUntraced": fn,
    "effect/Effect:gen": ([body], site) =>
      body?._tag === "Fn"
        ? Effect.suspend(() => host.call({ ...body, effectful: true }, [], site)).pipe(
            Effect.flatMap((made) => (made._tag === "Effect" ? made.run : Effect.succeed(made))),
            effect,
            Effect.succeed,
          )
        : wrongArguments(site, "Effect.gen"),
    "effect/Effect:succeed": ([value]) =>
      Effect.succeed(value ?? Value.undef).pipe(effect, Effect.succeed),
    "effect/Effect:fail": ([error]) =>
      Effect.fail(new Value.Rejected({ rejection: error ?? Value.undef })).pipe(
        effect,
        Effect.succeed,
      ),
    "effect/Effect:sync": ([thunk], site) =>
      thunk
        ? Effect.suspend(() => host.call(thunk, [], site)).pipe(effect, Effect.succeed)
        : wrongArguments(site, "Effect.sync"),
    "effect/Effect:andThen": onEffect("Effect.andThen", 1, (self, [next], site) =>
      next
        ? self.pipe(Effect.flatMap((value) => then(next, value, site)))
        : wrongArguments(site, "Effect.andThen"),
    ),
    "effect/Effect:flatMap": onEffect("Effect.flatMap", 1, (self, [next], site) =>
      next
        ? self.pipe(Effect.flatMap((value) => then(next, value, site)))
        : wrongArguments(site, "Effect.flatMap"),
    ),
    "effect/Effect:map": onEffect("Effect.map", 1, (self, [f], site) =>
      f
        ? self.pipe(Effect.flatMap((value) => host.call(f, [value], site)))
        : wrongArguments(site, "Effect.map"),
    ),
    "effect/Effect:tap": onEffect("Effect.tap", 1, (self, [next], site) =>
      next
        ? self.pipe(Effect.tap((value) => then(next, value, site)))
        : wrongArguments(site, "Effect.tap"),
    ),
    "effect/Effect:asVoid": onEffect("Effect.asVoid", 0, (self) =>
      self.pipe(Effect.as(Value.undef)),
    ),
    // A rejection the code turns into a defect stops the path, and nothing after handles it.
    "effect/Effect:orDie": onEffect("Effect.orDie", 0, (self) =>
      Kit.onFailure(self, (error) =>
        Effect.fail(new Value.Rejected({ rejection: error, defect: true })),
      ),
    ),
    "effect/Effect:provideService": onEffect(
      "Effect.provideService",
      2,
      (self, [tag, value], site) => {
        if (tag?._tag !== "Host" || !value) return wrongArguments(site, "Effect.provideService");
        const before = host.provided.get(tag.value);
        host.provided.set(tag.value, value);
        return self.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (before) host.provided.set(tag.value, before);
              else host.provided.delete(tag.value);
            }),
          ),
        );
      },
    ),
    "effect/Effect:annotateCurrentSpan": ignored,
    "effect/Effect:log": ignored,
    "effect/Effect:logDebug": ignored,
    "effect/Effect:logInfo": ignored,
    "effect/Effect:logWarning": ignored,
    "effect/Effect:logError": ignored,
    "effect/DateTime:formatIsoDate": isoDate,
    "effect/DateTime:formatIsoDateUtc": isoDate,
    "effect/DateTime:toEpochMillis": ([time], site) =>
      time?._tag === "Time"
        ? Effect.succeed<V>({ _tag: "Term", term: time.millis })
        : wrongArguments(site, "DateTime.toEpochMillis"),
    "effect/DateTime:isLessThan": onTimes("DateTime.isLessThan", (a, b) => ordered("<", a, b)),
    "effect/DateTime:isLessThanOrEqualTo": onTimes("DateTime.isLessThanOrEqualTo", (a, b) =>
      ordered("<=", a, b),
    ),
    "effect/DateTime:isGreaterThan": onTimes("DateTime.isGreaterThan", (a, b) =>
      ordered(">", a, b),
    ),
    "effect/DateTime:isGreaterThanOrEqualTo": onTimes("DateTime.isGreaterThanOrEqualTo", (a, b) =>
      ordered(">=", a, b),
    ),
    "effect/DateTime:between": dual("DateTime.between", 2, ([self, bounds], site) => {
      const at = instant(self);
      const minimum = bounds?._tag === "Obj" ? instant(bounds.fields.minimum) : undefined;
      const maximum = bounds?._tag === "Obj" ? instant(bounds.fields.maximum) : undefined;
      return at && minimum && maximum
        ? Effect.succeed(
            Value.term(
              "Bool",
              `(and (<= ${minimum.text} ${at.text}) (<= ${at.text} ${maximum.text}))`,
            ),
          )
        : wrongArguments(site, "DateTime.between");
    }),
    "effect/DateTime:min": onTimes("DateTime.min", (a, b) => time(picked("<=", a, b))),
    "effect/DateTime:max": onTimes("DateTime.max", (a, b) => time(picked(">=", a, b))),
    // From the first time to the second: negative when the second is the earlier.
    "effect/DateTime:distance": onTimes("DateTime.distance", (a, b) => duration(difference(b, a))),
    "effect/DateTime:addDuration": shiftedBy("DateTime.addDuration", 1),
    "effect/DateTime:subtractDuration": shiftedBy("DateTime.subtractDuration", -1),
    "effect/DateTime:add": shiftedByParts("DateTime.add", 1),
    "effect/DateTime:subtract": shiftedByParts("DateTime.subtract", -1),
    "effect/DateTime:isPast": against("DateTime.isPast", ">"),
    "effect/DateTime:isFuture": against("DateTime.isFuture", "<"),
    "effect/Duration:millis": spanOf("Duration.millis", 1),
    "effect/Duration:seconds": spanOf("Duration.seconds", 1_000),
    "effect/Duration:minutes": spanOf("Duration.minutes", 60_000),
    "effect/Duration:hours": spanOf("Duration.hours", 3_600_000),
    "effect/Duration:days": spanOf("Duration.days", DAY),
    "effect/Duration:weeks": spanOf("Duration.weeks", 7 * DAY),
    "effect/Duration:toMillis": spanIn("Duration.toMillis", 1),
    "effect/Duration:toSeconds": spanIn("Duration.toSeconds", 1_000),
    "effect/Duration:toMinutes": spanIn("Duration.toMinutes", 60_000),
    "effect/Duration:toHours": spanIn("Duration.toHours", 3_600_000),
    "effect/Duration:toDays": spanIn("Duration.toDays", DAY),
    "effect/Duration:toWeeks": spanIn("Duration.toWeeks", 7 * DAY),
    "effect/Duration:sum": onSpans("Duration.sum", (a, b) => duration(sum(a, b))),
    "effect/Duration:subtract": onSpans("Duration.subtract", (a, b) => duration(difference(a, b))),
    "effect/Duration:min": onSpans("Duration.min", (a, b) => duration(picked("<=", a, b))),
    "effect/Duration:max": onSpans("Duration.max", (a, b) => duration(picked(">=", a, b))),
    "effect/Duration:equals": onSpans("Duration.equals", (a, b) => ordered("=", a, b)),
    "effect/Duration:isLessThan": onSpans("Duration.isLessThan", (a, b) => ordered("<", a, b)),
    "effect/Duration:isLessThanOrEqualTo": onSpans("Duration.isLessThanOrEqualTo", (a, b) =>
      ordered("<=", a, b),
    ),
    "effect/Duration:isGreaterThan": onSpans("Duration.isGreaterThan", (a, b) =>
      ordered(">", a, b),
    ),
    "effect/Duration:isGreaterThanOrEqualTo": onSpans("Duration.isGreaterThanOrEqualTo", (a, b) =>
      ordered(">=", a, b),
    ),
    "Math:max": number("Math.max", Math.max, (a, b) => `(ite (>= ${a} ${b}) ${a} ${b})`),
    "Math:min": number("Math.min", Math.min, (a, b) => `(ite (<= ${a} ${b}) ${a} ${b})`),
  };

  /** `Duration.between` and `Duration.clamp`: the two ends, as milliseconds. */
  const ends = (options: V | undefined): readonly [Whole, Whole] | undefined => {
    const fields = options?._tag === "Obj" && !options.brand ? options.fields : undefined;
    const minimum = span(fields?.minimum);
    const maximum = span(fields?.maximum);
    return minimum !== undefined && maximum !== undefined ? [minimum, maximum] : undefined;
  };

  /** A function of one duration. */
  const onSpan =
    (name: string, body: (self: Whole) => V): Model =>
    ([self], site) => {
      const millis = span(self);
      return millis === undefined ? wrongArguments(site, name) : Effect.succeed(body(millis));
    };

  /** A time from what the code gives: milliseconds since 1970, or a date written as text. */
  const made = (input: V | undefined): V | undefined => {
    if (input?._tag === "Time") return input;
    const millis = wholeOf(input);
    if (millis !== undefined) return time(millis);
    const parsed = input?._tag === "Str" ? DateTime.make(input.value) : undefined;
    return parsed?._tag === "Some" ? time(parsed.value.pipe(DateTime.toEpochMillis)) : undefined;
  };

  const timeModels: Readonly<Record<string, Model>> = {
    "effect/DateTime:makeUnsafe": ([input], site) => {
      const at = made(input);
      return at ? Effect.succeed(at) : wrongArguments(site, "DateTime.makeUnsafe");
    },
    "effect/DateTime:make": ([input], site) => {
      const at = made(input);
      return at
        ? Effect.succeed(Value.some(at))
        : input?._tag === "Str"
          ? Effect.succeed(Value.none)
          : wrongArguments(site, "DateTime.make");
    },
    "effect/Duration:times": dual("Duration.times", 2, ([self, times], site) => {
      const millis = span(self);
      const count = wholeOf(times);
      return millis !== undefined && count !== undefined
        ? Effect.succeed(duration(product(millis, count)))
        : wrongArguments(site, "Duration.times");
    }),
    "effect/Duration:isZero": onSpan("Duration.isZero", (millis) => ordered("=", millis, 0)),
    "effect/Duration:isNegative": onSpan("Duration.isNegative", (millis) =>
      ordered("<", millis, 0),
    ),
    "effect/Duration:isPositive": onSpan("Duration.isPositive", (millis) =>
      ordered(">", millis, 0),
    ),
    // Only a duration of a whole number of milliseconds is read, and every one of those ends.
    "effect/Duration:isFinite": onSpan("Duration.isFinite", () => Value.bool(true)),
    "effect/Duration:negate": onSpan("Duration.negate", (millis) =>
      duration(difference(0, millis)),
    ),
    "effect/Duration:abs": onSpan("Duration.abs", (millis) =>
      duration(picked(">=", millis, difference(0, millis))),
    ),
    "effect/Duration:between": dual("Duration.between", 2, ([self, options], site) => {
      const millis = span(self);
      const bounds = ends(options);
      if (millis === undefined || !bounds) return wrongArguments(site, "Duration.between");
      const above = ordered("<=", bounds[0], millis);
      const below = ordered("<=", millis, bounds[1]);
      return Effect.flatMap(
        Effect.all([host.truth(above, site), host.truth(below, site)]),
        (parts) =>
          kit.known(Compare.all(parts), site, "compares durations the prover does not model"),
      );
    }),
    "effect/Duration:clamp": dual("Duration.clamp", 2, ([self, options], site) => {
      const millis = span(self);
      const bounds = ends(options);
      return millis !== undefined && bounds
        ? Effect.succeed(duration(picked("<=", picked(">=", millis, bounds[0]), bounds[1])))
        : wrongArguments(site, "Duration.clamp");
    }),
  };

  /** A test of two values by a number each one is: a time's milliseconds, a duration's. */
  const by =
    (name: string, read: (v: V) => Whole | undefined, order: "<" | "=") =>
    (a: V, b: V, site: Site): Eval<V> => {
      const x = read(a);
      const y = read(b);
      return x !== undefined && y !== undefined
        ? Effect.succeed(ordered(order, x, y))
        : wrongArguments(site, name);
    };

  // The classes of `effect/Data`, for a class a file keeps to itself: one it
  // exports is the class Node loaded.
  const classes = new WeakSet<object>();

  /** A class whose instances are their fields, with a tag when it gives one. */
  const dataClass = (name: string, tag: string | undefined, error: boolean): V => {
    const brand: Value.Brand = { kind: "Data", cls: { name, error } };
    const made = native(name, ([fields], site) =>
      fields === undefined || fields._tag === "Undef" || (fields._tag === "Obj" && !fields.brand)
        ? Effect.succeed(
            Value.obj(
              {
                ...(fields?._tag === "Obj" ? fields.fields : {}),
                ...(tag === undefined ? {} : { _tag: Value.str(tag) }),
              },
              brand,
            ),
          )
        : wrongArguments(site, name),
    );
    classes.add(made);
    bases.set(made, { tag, error });
    return made;
  };
  const bases = new WeakMap<
    object,
    { readonly tag: string | undefined; readonly error: boolean }
  >();

  const dataModels: Readonly<Record<string, Model>> = {
    "effect/Data:TaggedError": ([tag], site) => {
      const name = str(tag);
      return name === undefined
        ? wrongArguments(site, "Data.TaggedError")
        : Effect.succeed(dataClass(name, name, true));
    },
    "effect/Data:TaggedClass": ([tag], site) => {
      const name = str(tag);
      return name === undefined
        ? wrongArguments(site, "Data.TaggedClass")
        : Effect.succeed(dataClass(name, name, false));
    },
  };
  const plainClass = dataClass("Data.Class", undefined, false);
  const plainError = dataClass("Data.Error", undefined, true);

  // `Data.taggedEnum()`: a constructor for each tag, `$is` and `$match`.
  const ENUM = ["taggedEnum", "()"] as const;
  const isEnum = (lib: V & { readonly _tag: "Lib" }): boolean =>
    lib.module === "effect/Data" && lib.path[0] === "taggedEnum" && lib.path.length <= 3;

  const taggedEnum = (
    lib: V & { readonly _tag: "Lib" },
    args: ReadonlyArray<V>,
    site: Site,
  ): Eval<V> => {
    const name = lib.path[2];
    if (lib.path.length === 1)
      return Effect.succeed<V>({ _tag: "Lib", module: "effect/Data", path: [...ENUM] });
    if (name === undefined) return wrongArguments(site, "Data.taggedEnum");
    if (name === "$is") {
      const tag = str(args[0]);
      return tag === undefined
        ? wrongArguments(site, "$is")
        : Effect.succeed(
            native("$is", ([value]) => Effect.succeed(Value.bool(Kit.tagOf(value) === tag))),
          );
    }
    if (name === "$match") {
      const matching = (value: V | undefined, cases: V | undefined, at: Site): Eval<V> => {
        const handler = cases?._tag === "Obj" ? cases.fields[Kit.tagOf(value) ?? ""] : undefined;
        return value && handler ? host.call(handler, [value], at) : wrongArguments(at, "$match");
      };
      return args.length >= 2
        ? matching(args[0], args[1], site)
        : Effect.succeed(native("$match", ([value], at) => matching(value, args[0], at)));
    }
    const fields = args[0];
    return fields === undefined ||
      fields._tag === "Undef" ||
      (fields._tag === "Obj" && !fields.brand)
      ? Effect.succeed(
          Value.obj({ ...(fields?._tag === "Obj" ? fields.fields : {}), _tag: Value.str(name) }),
        )
      : wrongArguments(site, name);
  };

  const effects = Effects.make(kit);
  const results = Results.make(kit);
  const collections = Collections.make(kit);
  const numbers = Numbers.make(kit);
  const strings = Strings.make(kit);
  const decimals = Decimals.make(kit);
  const hashes = Hashes.make(kit);
  const streams = Streams.make(kit);
  const cells = Cells.make(kit, (key, args, site) => models[key]!(args, site));
  const exits = Exits.make(kit);
  const optics = Optics.make(kit);
  const folds = Folds.make(
    kit,
    (key, args, site) => models[key]!(args, site),
    (key) => values[key] ?? Value.undef,
  );
  const rationals = Rationals.make(kit);

  /**
   * A value as JSON, where the prover can write it: a whole number an input
   * holds as its digits, a boolean as `true` or `false`. Text an input holds
   * is not written, since what it holds may need a backslash.
   */
  const jsonOf = (value: V, site: Site): Eval<V | undefined> =>
    Effect.gen(function* () {
      const joined = (parts: ReadonlyArray<V>): Eval<V> =>
        Effect.gen(function* () {
          let out: V = Value.str("");
          for (const part of parts) out = yield* host.arithmetic("+", out, part, site);
          return out;
        });
      const v = host.force(value);
      const known = Known.real(v);
      if (known) {
        const text: string | undefined = JSON.stringify(known.value);
        return text === undefined ? undefined : Value.str(text);
      }
      if (v._tag === "Term" && v.big !== true && v.term.sort === "Int")
        return yield* host.arithmetic("+", Value.str(""), v, site);
      if (v._tag === "Term" && v.term.sort === "Bool")
        return Value.term("String", `(ite ${v.term.text} "true" "false")`);
      if (v._tag === "Arr") {
        const parts: Array<V> = [Value.str("[")];
        for (const [index, item] of v.items.entries()) {
          const text = item._tag === "Undef" ? Value.str("null") : yield* jsonOf(item, site);
          if (!text) return undefined;
          parts.push(Value.str(index === 0 ? "" : ","), text);
        }
        return yield* joined([...parts, Value.str("]")]);
      }
      if (v._tag === "Obj" && !v.brand) {
        const parts: Array<V> = [Value.str("{")];
        let first = true;
        for (const [key, field] of Object.entries(v.fields)) {
          if (field._tag === "Undef") continue;
          if (field._tag === "Pending") return undefined;
          const text = yield* jsonOf(field, site);
          if (!text) return undefined;
          parts.push(Value.str(`${first ? "" : ","}${JSON.stringify(key)}:`), text);
          first = false;
        }
        return yield* joined([...parts, Value.str("}")]);
      }
      return undefined;
    });

  // ---- Services provided to an effect: a layer and a context are the values they provide.

  /** What a layer or a context provides, by service, in the order it was put together. */
  type Provided = ReadonlyArray<readonly [service: unknown, value: V]>;
  const builders = new WeakMap<object, (site: Site) => Eval<Provided>>();
  const contexts = new WeakMap<object, Provided>();
  const layerOf = (build: (site: Site) => Eval<Provided>): V => {
    const made = Value.obj({ "~layer": Value.bool(true) });
    builders.set(made, build);
    return made;
  };
  const contextOf = (provided: Provided): V => {
    const made = Value.obj({ "~context": Value.bool(true) });
    contexts.set(made, provided);
    return made;
  };
  const serviceOf = (name: string, tag: V | undefined, site: Site): Eval<unknown> =>
    tag?._tag === "Host" ? Effect.succeed(tag.value) : wrongArguments(site, name);
  /** The service the code has read under a key the code gives. */
  const keyedService = (key: V | undefined): unknown =>
    key?._tag === "Str" ? host.services.get(key.value) : undefined;
  const unkeyed = (site: Site, name: string): Eval<never> =>
    Effect.fail(
      Value.notTranslated(site, `calls ${name} with a key of no service the code has read`),
    );
  /** An effect with services provided around it: it reads them, and nothing after it does. */
  const providing = <A>(provided: Provided, self: Eval<A>): Eval<A> =>
    Effect.suspend(() => {
      const before = provided.map(([service]) => [service, host.provided.get(service)] as const);
      for (const [service, value] of provided) host.provided.set(service, value);
      return self.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const [service, value] of before.toReversed())
              if (value) host.provided.set(service, value);
              else host.provided.delete(service);
          }),
        ),
      );
    });
  /** An effect with only these services provided while it runs: the ones before come back after. */
  const replacing = <A>(provided: Provided, self: Eval<A>): Eval<A> =>
    Effect.suspend(() => {
      const before = [...host.provided.entries()];
      host.provided.clear();
      for (const [service, value] of provided) host.provided.set(service, value);
      return self.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            host.provided.clear();
            for (const [service, value] of before) host.provided.set(service, value);
          }),
        ),
      );
    });
  /** What a layer, a context or a list of layers provides, built now. */
  const built = (name: string, given: V | undefined, site: Site): Eval<Provided> => {
    const build = given ? builders.get(given) : undefined;
    if (build) return build(site);
    const context = given ? contexts.get(given) : undefined;
    if (context) return Effect.succeed(context);
    const several = kit.itemsOf(given);
    if (!several) return wrongArguments(site, name);
    return Effect.gen(function* () {
      const all: Array<readonly [unknown, V]> = [];
      for (const each of several) all.push(...(yield* built(name, each, site)));
      return all;
    });
  };
  const merged = (name: string, given: ReadonlyArray<V>): V =>
    layerOf((site) =>
      Effect.gen(function* () {
        const all: Array<readonly [unknown, V]> = [];
        for (const each of given) all.push(...(yield* built(name, each, site)));
        return all;
      }),
    );
  /** A layer of one service, made by an effect that reads what is provided around it. */
  const one =
    (name: string, value: (given: V | undefined, site: Site) => Eval<V>): Model =>
    (args) => {
      const made = (tag: V | undefined, given: V | undefined): V =>
        layerOf((at) =>
          Effect.flatMap(serviceOf(name, tag, at), (service) =>
            Effect.map(value(given, at), (held) => [[service, held] as const]),
          ),
        );
      // `Layer.succeed(Db, db)` and `Layer.succeed(Db)(db)`.
      return Effect.succeed(
        args.length >= 2
          ? made(args[0], args[1])
          : native(name, ([given]) => Effect.succeed(made(args[0], given))),
      );
    };
  const lookup = (held: Provided, service: unknown): V | undefined =>
    held.find(([each]) => each === service)?.[1];
  /** A function of a context and a service. */
  const heldBy = (
    name: string,
    self: V | undefined,
    tag: V | undefined,
    site: Site,
    use: (held: Provided, service: unknown) => Eval<V>,
  ): Eval<V> => {
    const held = self ? contexts.get(self) : undefined;
    return held
      ? Effect.flatMap(serviceOf(name, tag, site), (service) => use(held, service))
      : wrongArguments(site, name);
  };
  const getting = (name: string): Model =>
    dual(name, 2, ([self, tag], site) =>
      heldBy(name, self, tag, site, (held, service) => {
        const found = lookup(held, service);
        return found ? Effect.succeed(found) : wrongArguments(site, name);
      }),
    );
  /** `Context.pick(A, B)(context)` and `Context.omit(A)(context)`. */
  const keeping =
    (name: string, picked: boolean): Model =>
    (tags, site) =>
      tags.every((tag) => tag._tag === "Host")
        ? Effect.succeed(
            native(name, ([self], at) => {
              const held = self ? contexts.get(self) : undefined;
              const services = tags.map((tag) => (tag._tag === "Host" ? tag.value : undefined));
              return held
                ? Effect.succeed(
                    contextOf(held.filter(([each]) => services.includes(each) === picked)),
                  )
                : wrongArguments(at, name);
            }),
          )
        : wrongArguments(site, name);
  /** What a context the code gives holds. */
  const holding = (name: string, given: V, site: Site): Eval<Provided> => {
    const held = contexts.get(given);
    return held ? Effect.succeed(held) : wrongArguments(site, name);
  };
  /** The effect a function of the code gives, run. */
  const ranBy = (name: string, f: V, args: ReadonlyArray<V>, site: Site): Eval<V> =>
    Effect.flatMap(host.call(f, args, site), (made) =>
      made._tag === "Effect" ? made.run : wrongArguments(site, name),
    );
  /** A failure the code can handle: not a defect, and not what stops the prover. */
  const failure = (stop: Value.Stop): stop is Value.Rejected =>
    stop._tag === "Rejected" && stop.defect !== true;
  /** A failure or a defect of the code: what a cause holds. */
  const rejection = (stop: Value.Stop): stop is Value.Rejected => stop._tag === "Rejected";
  /** A failure or a defect, as the cause the code reads. */
  const causeOf = (stop: Value.Rejected, site: Site): Eval<V> =>
    exits.models[stop.defect === true ? "effect/Cause:die" : "effect/Cause:fail"]!(
      [stop.rejection],
      site,
    );
  /** A function that is its argument: `Layer.satisfiesSuccessType<Db>()(layer)`. */
  const itself =
    (name: string): Model =>
    () =>
      Effect.succeed(native(name, ([self]) => Effect.succeed(self ?? Value.undef)));
  const wiring: Record<string, Model> = {
    "effect/Layer:succeed": one("Layer.succeed", (given) => Effect.succeed(given ?? Value.undef)),
    "effect/Layer:sync": one("Layer.sync", (given, site) =>
      given ? host.call(given, [], site) : wrongArguments(site, "Layer.sync"),
    ),
    "effect/Layer:effect": one("Layer.effect", (given, site) =>
      given?._tag === "Effect" ? given.run : wrongArguments(site, "Layer.effect"),
    ),
    "effect/Layer:effectDiscard": ([given], site) =>
      given?._tag === "Effect"
        ? Effect.succeed(layerOf(() => Effect.as(given.run, [])))
        : wrongArguments(site, "Layer.effectDiscard"),
    "effect/Layer:succeedContext": ([given], site) => {
      const context = given ? contexts.get(given) : undefined;
      return context
        ? Effect.succeed(layerOf(() => Effect.succeed(context)))
        : wrongArguments(site, "Layer.succeedContext");
    },
    "effect/Layer:merge": dual("Layer.merge", 2, ([self, that]) =>
      Effect.succeed(merged("Layer.merge", [self!, that ?? Value.undef])),
    ),
    "effect/Layer:mergeAll": (args) => Effect.succeed(merged("Layer.mergeAll", args)),
    // What the second provides is there while the first is built, and is not what the result provides.
    "effect/Layer:provide": dual("Layer.provide", 2, ([self, needs]) =>
      Effect.succeed(
        layerOf((site) =>
          Effect.flatMap(built("Layer.provide", needs, site), (provided) =>
            providing(provided, built("Layer.provide", self, site)),
          ),
        ),
      ),
    ),
    "effect/Layer:provideMerge": dual("Layer.provideMerge", 2, ([self, needs]) =>
      Effect.succeed(
        layerOf((site) =>
          Effect.flatMap(built("Layer.provideMerge", needs, site), (provided) =>
            Effect.map(providing(provided, built("Layer.provideMerge", self, site)), (own) => [
              ...provided,
              ...own,
            ]),
          ),
        ),
      ),
    ),
    "effect/Layer:fresh": ([self]) => Effect.succeed(self ?? Value.undef),
    "effect/Layer:isLayer": ([value]) =>
      Effect.succeed(Value.bool(value !== undefined && builders.has(value))),
    "effect/Effect:provide": onEffect("Effect.provide", 1, (self, [given], site) =>
      Effect.flatMap(built("Effect.provide", given, site), (provided) => providing(provided, self)),
    ),
    "effect/Context:empty": () => Effect.succeed(contextOf([])),
    "effect/Context:make": ([tag, value], site) =>
      Effect.map(serviceOf("Context.make", tag, site), (service) =>
        contextOf([[service, value ?? Value.undef]]),
      ),
    // A context of keys, as the library keys one: each key is the key of a service the code has read.
    "effect/Context:addUnsafe": ([self, key, value], site) => {
      const held = self ? contexts.get(self) : undefined;
      const service = keyedService(key);
      if (!held || key?._tag !== "Str") return wrongArguments(site, "Context.addUnsafe");
      if (service === undefined) return unkeyed(site, "Context.addUnsafe");
      return Effect.succeed(
        contextOf([...held.filter(([each]) => each !== service), [service, value ?? Value.undef]]),
      );
    },
    "effect/Context:makeUnsafe": ([map, options], site) => {
      const found = map ? host.keptOf(map) : undefined;
      if (
        !found ||
        found.kind !== "Map" ||
        (options !== undefined && options._tag !== "Undef" && options._tag !== "Obj")
      )
        return wrongArguments(site, "Context.makeUnsafe");
      const provided: Array<readonly [unknown, V]> = [];
      for (const [key, value] of found.entries) {
        const service = keyedService(key);
        if (key._tag !== "Str") return wrongArguments(site, "Context.makeUnsafe");
        if (service === undefined) return unkeyed(site, "Context.makeUnsafe");
        provided.push([service, value]);
      }
      return Effect.succeed(contextOf(provided));
    },
    "effect/Context:add": dual("Context.add", 3, ([self, tag, value], site) => {
      const held = self ? contexts.get(self) : undefined;
      return held
        ? Effect.map(serviceOf("Context.add", tag, site), (service) =>
            contextOf([
              ...held.filter(([each]) => each !== service),
              [service, value ?? Value.undef],
            ]),
          )
        : wrongArguments(site, "Context.add");
    }),
    "effect/Context:merge": dual("Context.merge", 2, ([self, that], site) => {
      const [a, b] = [self ? contexts.get(self) : undefined, that ? contexts.get(that) : undefined];
      return a && b
        ? Effect.succeed(
            contextOf([...a.filter(([each]) => !b.some(([other]) => other === each)), ...b]),
          )
        : wrongArguments(site, "Context.merge");
    }),
    "effect/Context:getOption": dual("Context.getOption", 2, ([self, tag], site) => {
      const held = self ? contexts.get(self) : undefined;
      return held
        ? Effect.map(serviceOf("Context.getOption", tag, site), (service) => {
            const found = held.find(([each]) => each === service);
            return found ? Value.some(found[1]) : Value.none;
          })
        : wrongArguments(site, "Context.getOption");
    }),
    "effect/Context:isContext": ([value]) =>
      Effect.succeed(Value.bool(value !== undefined && contexts.has(value))),

    // ---- The rest of `Context`: a context is what it holds, by service.
    "effect/Context:get": getting("Context.get"),
    "effect/Context:getUnsafe": getting("Context.getUnsafe"),
    "effect/Context:getOrUndefined": dual("Context.getOrUndefined", 2, ([self, tag], site) =>
      heldBy("Context.getOrUndefined", self, tag, site, (held, service) =>
        Effect.succeed(lookup(held, service) ?? Value.undef),
      ),
    ),
    "effect/Context:getOrElse": dual("Context.getOrElse", 3, ([self, tag, orElse], site) =>
      heldBy("Context.getOrElse", self, tag, site, (held, service) => {
        const found = lookup(held, service);
        if (found) return Effect.succeed(found);
        return orElse ? host.call(orElse, [], site) : wrongArguments(site, "Context.getOrElse");
      }),
    ),
    "effect/Context:addOrOmit": dual("Context.addOrOmit", 3, ([self, tag, given], site) =>
      heldBy("Context.addOrOmit", self, tag, site, (held, service) => {
        const option = Value.optionOf(given);
        const rest = held.filter(([each]) => each !== service);
        return option
          ? Effect.succeed(
              contextOf(option._tag === "Some" ? [...rest, [service, option.value]] : rest),
            )
          : wrongArguments(site, "Context.addOrOmit");
      }),
    ),
    "effect/Context:mergeAll": (args, site) => {
      const all = args.map((each) => contexts.get(each));
      return all.every((each) => each !== undefined)
        ? Effect.succeed(
            contextOf(
              all.reduce<Provided>(
                (a, b) => [...a.filter(([each]) => !b.some(([other]) => other === each)), ...b],
                [],
              ),
            ),
          )
        : wrongArguments(site, "Context.mergeAll");
    },
    "effect/Context:omit": keeping("Context.omit", false),
    "effect/Context:pick": keeping("Context.pick", true),
    "effect/Context:isKey": ([value]) =>
      Effect.succeed(Value.bool(value?._tag === "Host" && Context.isKey(value.value))),
    "effect/Context:isReference": ([value]) =>
      Effect.succeed(
        Value.bool(
          value?._tag === "Host" && Context.isKey(value.value) && Context.isReference(value.value),
        ),
      ),

    // ---- The rest of `Layer`.
    "effect/Layer:suspend": ([f], site) =>
      f
        ? Effect.succeed(
            layerOf((at) =>
              Effect.flatMap(host.call(f, [], at), (made) => built("Layer.suspend", made, at)),
            ),
          )
        : wrongArguments(site, "Layer.suspend"),
    "effect/Layer:unwrap": ([given], site) =>
      given?._tag === "Effect"
        ? Effect.succeed(
            layerOf((at) => Effect.flatMap(given.run, (made) => built("Layer.unwrap", made, at))),
          )
        : wrongArguments(site, "Layer.unwrap"),
    "effect/Layer:effectContext": ([given], site) =>
      given?._tag === "Effect"
        ? Effect.succeed(
            layerOf((at) =>
              Effect.flatMap(given.run, (made) => holding("Layer.effectContext", made, at)),
            ),
          )
        : wrongArguments(site, "Layer.effectContext"),
    "effect/Layer:syncContext": ([f], site) =>
      f
        ? Effect.succeed(
            layerOf((at) =>
              Effect.flatMap(host.call(f, [], at), (made) =>
                holding("Layer.syncContext", made, at),
              ),
            ),
          )
        : wrongArguments(site, "Layer.syncContext"),
    // What the first provides is given to the function: the layer it gives is what is provided.
    "effect/Layer:flatMap": dual("Layer.flatMap", 2, ([self, f], site) =>
      f
        ? Effect.succeed(
            layerOf((at) =>
              Effect.flatMap(built("Layer.flatMap", self, at), (provided) =>
                Effect.flatMap(host.call(f, [contextOf(provided)], at), (made) =>
                  built("Layer.flatMap", made, at),
                ),
              ),
            ),
          )
        : wrongArguments(site, "Layer.flatMap"),
    ),
    "effect/Layer:tap": dual("Layer.tap", 2, ([self, f], site) =>
      f
        ? Effect.succeed(
            layerOf((at) =>
              Effect.tap(built("Layer.tap", self, at), (provided) =>
                ranBy("Layer.tap", f, [contextOf(provided)], at),
              ),
            ),
          )
        : wrongArguments(site, "Layer.tap"),
    ),
    "effect/Layer:tapError": dual("Layer.tapError", 2, ([self, f], site) =>
      f
        ? Effect.succeed(
            layerOf((at) =>
              Effect.catchIf(built("Layer.tapError", self, at), failure, (stop) =>
                Effect.andThen(ranBy("Layer.tapError", f, [stop.rejection], at), Effect.fail(stop)),
              ),
            ),
          )
        : wrongArguments(site, "Layer.tapError"),
    ),
    "effect/Layer:catch": dual("Layer.catch", 2, ([self, f], site) =>
      f
        ? Effect.succeed(
            layerOf((at) =>
              Effect.catchIf(built("Layer.catch", self, at), failure, (stop) =>
                Effect.flatMap(host.call(f, [stop.rejection], at), (made) =>
                  built("Layer.catch", made, at),
                ),
              ),
            ),
          )
        : wrongArguments(site, "Layer.catch"),
    ),
    "effect/Layer:catchTag": dual("Layer.catchTag", 3, ([self, tags, f], site) => {
      const wanted = (kit.itemsOf(tags) ?? (tags ? [tags] : [])).map((each) =>
        each._tag === "Str" ? each.value : undefined,
      );
      return f && wanted.length > 0 && wanted.every((each) => each !== undefined)
        ? Effect.succeed(
            layerOf((at) =>
              Effect.catchIf(
                built("Layer.catchTag", self, at),
                (stop): stop is Value.Rejected => {
                  const tag = failure(stop) ? Kit.tagOf(stop.rejection) : undefined;
                  return tag !== undefined && wanted.includes(tag);
                },
                (stop) =>
                  Effect.flatMap(host.call(f, [stop.rejection], at), (made) =>
                    built("Layer.catchTag", made, at),
                  ),
              ),
            ),
          )
        : wrongArguments(site, "Layer.catchTag");
    }),
    // What the layer failed with, as a cause the code reads.
    "effect/Layer:catchCause": dual("Layer.catchCause", 2, ([self, f], site) =>
      f
        ? Effect.succeed(
            layerOf((at) =>
              Effect.catchIf(built("Layer.catchCause", self, at), rejection, (stop) =>
                Effect.flatMap(causeOf(stop, at), (cause) =>
                  Effect.flatMap(host.call(f, [cause], at), (made) =>
                    built("Layer.catchCause", made, at),
                  ),
                ),
              ),
            ),
          )
        : wrongArguments(site, "Layer.catchCause"),
    ),
    "effect/Layer:tapCause": dual("Layer.tapCause", 2, ([self, f], site) =>
      f
        ? Effect.succeed(
            layerOf((at) =>
              Effect.catchIf(built("Layer.tapCause", self, at), rejection, (stop) =>
                Effect.flatMap(causeOf(stop, at), (cause) =>
                  Effect.andThen(ranBy("Layer.tapCause", f, [cause], at), Effect.fail(stop)),
                ),
              ),
            ),
          )
        : wrongArguments(site, "Layer.tapCause"),
    ),
    "effect/Layer:orDie": ([self]) =>
      Effect.succeed(
        layerOf((at) =>
          Effect.mapError(built("Layer.orDie", self, at), (stop) =>
            failure(stop) ? new Value.Rejected({ rejection: stop.rejection, defect: true }) : stop,
          ),
        ),
      ),
    "effect/Layer:mock": one("Layer.mock", (given) => Effect.succeed(given ?? Value.undef)),
    // The service is another value while the layer is built.
    "effect/Layer:updateService": dual("Layer.updateService", 3, ([self, tag, f], site) =>
      f
        ? Effect.succeed(
            layerOf((at) =>
              Effect.flatMap(serviceOf("Layer.updateService", tag, at), (service) => {
                const before = host.provided.get(service);
                return before
                  ? Effect.flatMap(host.call(f, [before], at), (next) =>
                      providing([[service, next]], built("Layer.updateService", self, at)),
                    )
                  : Effect.fail(
                      Value.notTranslated(
                        at,
                        "calls Layer.updateService of a service that nothing provides",
                      ),
                    );
              }),
            ),
          )
        : wrongArguments(site, "Layer.updateService"),
    ),
    "effect/Layer:satisfiesSuccessType": itself("Layer.satisfiesSuccessType"),
    "effect/Layer:satisfiesErrorType": itself("Layer.satisfiesErrorType"),
    "effect/Layer:satisfiesServicesType": itself("Layer.satisfiesServicesType"),
    // A span says how the layer is watched: it is the layer it was.
    "effect/Layer:withSpan": ([first]) =>
      Effect.succeed(
        first && builders.has(first)
          ? first
          : native("Layer.withSpan", ([self]) => Effect.succeed(self ?? Value.undef)),
      ),
    "effect/Layer:build": ([self], site) =>
      Effect.succeed(Kit.lazy(() => Effect.map(built("Layer.build", self, site), contextOf))),
    "effect/Layer:buildWithScope": dual("Layer.buildWithScope", 2, ([self], site) =>
      Effect.succeed(
        Kit.lazy(() => Effect.map(built("Layer.buildWithScope", self, site), contextOf)),
      ),
    ),
    // The effect runs with these services and no others.
    "effect/Effect:setContext": onEffect("Effect.setContext", 1, (self, [given], site) =>
      Effect.flatMap(holding("Effect.setContext", given ?? Value.undef, site), (provided) =>
        replacing(provided, self),
      ),
    ),
    // The services the function makes of the ones provided where the effect runs.
    "effect/Effect:updateContext": onEffect("Effect.updateContext", 1, (self, [f], site) =>
      f
        ? Effect.flatMap(host.call(f, [contextOf([...host.provided.entries()])], site), (made) =>
            Effect.flatMap(holding("Effect.updateContext", made, site), (provided) =>
              replacing(provided, self),
            ),
          )
        : wrongArguments(site, "Effect.updateContext"),
    ),
    // Every service that is provided where the effect runs.
    "effect/Effect:context": () =>
      Effect.succeed(Kit.lazy(() => Effect.sync(() => contextOf([...host.provided.entries()])))),
    "effect/Effect:contextWith": ([f], site) =>
      f
        ? Effect.succeed(
            Kit.lazy(() =>
              ranBy("Effect.contextWith", f, [contextOf([...host.provided.entries()])], site),
            ),
          )
        : wrongArguments(site, "Effect.contextWith"),
  };

  /** `parseInt` and `parseFloat`, of text the code writes. */
  const parsed = (name: string, text: V | undefined, radix: V | undefined, site: Site): Eval<V> =>
    text?._tag === "Str" && (radix === undefined || radix._tag === "Undef" || radix._tag === "Num")
      ? Effect.succeed(
          Value.num(
            name.endsWith("parseFloat")
              ? Number.parseFloat(text.value)
              : Number.parseInt(text.value, radix?._tag === "Num" ? radix.value : undefined),
          ),
        )
      : Effect.fail(Value.notTranslated(site, `calls ${name} on text the prover cannot see`));

  const written: Record<string, Model> = {
    "effect/Clock:clockWith": clockWith,
    "effect/Effect:clockWith": clockWith,
    ...own,
    ...timeModels,
    ...dataModels,
    ...effects.models,
    ...results.models,
    ...collections.models,
    ...numbers.models,
    ...strings.models,
    ...decimals.models,
    ...hashes.models,
    ...streams.models,
    ...cells.models,
    ...exits.models,
    ...optics.models,
    ...rationals.models,
    ...folds.models,
    ...Schemas.make(kit).models,
  };
  /** Classes of the library other than `effect/Data`'s, each with what a class that extends it is. */
  const extending = new WeakMap<object, (name: string) => V>();
  const asClass = (made: V, extended: (name: string) => V): V => {
    classes.add(made);
    extending.set(made, extended);
    return made;
  };
  Object.assign(written, wiring);
  const fibers = Fibers.make(kit, { ...written }, asClass);
  Object.assign(written, fibers.models);
  Object.assign(clocks, fibers.sited);
  const contextNow = (): V => contextOf([...host.provided.entries()]);
  const flows = Flows.make(kit, { ...written }, fibers.tools, {
    providing,
    provides: built,
    replacing,
    context: contextNow,
  });
  Object.assign(written, flows.models);
  Object.assign(clocks, flows.sited);
  const channels = Channels.make(kit, {
    ...fibers.tools,
    real: flows.real,
    flow: flows.flow,
    provides: built,
    context: contextNow,
  });
  Object.assign(written, channels.models);
  Object.assign(clocks, channels.sited);
  const sinks = Sinks.make(
    kit,
    { ...written },
    streams.values,
    { ...fibers.tools, provides: built },
    {
      ...flows.lifts,
      read: streams.isSink,
      channel: channels.channel,
      chanOf: channels.chanOf,
    },
  );
  Object.assign(written, sinks.models);

  // A `Chunk` and an `Iterable` are read as the array of their items: the
  // functions the three modules share do the same to one.
  const models: Record<string, Model> = { ...written };
  for (const [key, model] of Object.entries(written)) {
    if (!key.startsWith("effect/Array:")) continue;
    const name = key.slice("effect/Array:".length);
    if (CHUNK.has(name)) models[`effect/Chunk:${name}`] = model;
    if (ITERABLE.has(name)) models[`effect/Iterable:${name}`] = model;
  }
  // `Iterable.makeBy(f, { length })` takes the function first, and gives as many items as it is told to.
  models["effect/Iterable:makeBy"] = ([f, options], site) => {
    const length = options?._tag === "Obj" ? options.fields.length : undefined;
    return f && length?._tag === "Num" && Number.isInteger(length.value)
      ? Effect.forEach(
          Array.from({ length: Math.max(1, Math.floor(length.value)) }, (_, i) => i),
          (i) => host.call(f, [Value.num(i)], site),
        ).pipe(Effect.map(arr))
      : Effect.fail(
          Value.notTranslated(
            site,
            "Iterable.makeBy is given no length the prover can see: it then gives items without end",
          ),
        );
  };
  const identity: Model = ([self], site) =>
    kit.itemsOf(self) ? Effect.succeed(arr(kit.itemsOf(self)!)) : wrongArguments(site, "Chunk");
  for (const name of ["toArray", "toReadonlyArray", "fromArrayUnsafe", "fromNonEmptyArrayUnsafe"])
    models[`effect/Chunk:${name}`] = identity;
  models["effect/Chunk:size"] = models["effect/Array:length"]!;
  models["effect/Iterable:size"] = models["effect/Array:length"]!;
  models["effect/Chunk:isEmpty"] = models["effect/Array:isArrayEmpty"]!;
  models["effect/Iterable:isEmpty"] = models["effect/Array:isArrayEmpty"]!;
  models["effect/Chunk:isNonEmpty"] = models["effect/Array:isArrayNonEmpty"]!;

  const timeOrder = kit.order(
    "DateTime.Order",
    by("DateTime.Order", (v) => instant(v), "<"),
  );
  const spanOrder = kit.order("Duration.Order", by("Duration.Order", span, "<"));

  /** Library values that are not functions. */
  const values: Record<string, V> = {
    "effect/Effect:void": done,
    "effect/Duration:zero": duration(0),
    "effect/Data:Class": plainClass,
    "effect/Data:Error": plainError,
    "effect/DateTime:Order": timeOrder,
    "effect/Duration:Order": spanOrder,
    "effect/DateTime:Equivalence": native("DateTime.Equivalence", ([a, b], site) =>
      a && b
        ? by("DateTime.Equivalence", (v) => instant(v), "=")(a, b, site)
        : wrongArguments(site, "DateTime.Equivalence"),
    ),
    "effect/Duration:Equivalence": native("Duration.Equivalence", ([a, b], site) =>
      a && b
        ? by("Duration.Equivalence", span, "=")(a, b, site)
        : wrongArguments(site, "Duration.Equivalence"),
    ),
    ...effects.values,
    ...results.values,
    ...numbers.values,
    ...strings.values,
    ...decimals.values,
    ...rationals.values,
    ...streams.values,
    ...sinks.values,
    ...folds.constants,
    "effect/Layer:empty": layerOf(() => Effect.succeed([])),
    "effect/Console:clear": done,
    "Number:MAX_SAFE_INTEGER": Value.num(Number.MAX_SAFE_INTEGER),
    "Number:MIN_SAFE_INTEGER": Value.num(Number.MIN_SAFE_INTEGER),
    ...exits.values,
  };
  // The reducers the modules give are made of the orders and the zeros above.
  Object.assign(values, folds.values());

  const keyOf = (lib: V & { readonly _tag: "Lib" }): string =>
    `${lib.module}:${lib.path.join(".")}`;

  /** A tagged union of `effect/Schema`: its tag's name, and the schema of each case. */
  const unionOf = (
    schema: unknown,
  ): { readonly tag: string; readonly cases: Readonly<Record<string, unknown>> } | undefined => {
    const union = schema as { readonly tag?: unknown; readonly cases?: unknown; guards?: unknown };
    return Schema.isSchema(schema) &&
      typeof union.tag === "string" &&
      typeof union.cases === "object" &&
      union.cases !== null &&
      typeof union.guards === "object"
      ? { tag: union.tag, cases: union.cases as Readonly<Record<string, unknown>> }
      : undefined;
  };

  /**
   * What a function of `effect/Schema` makes. A tagged union built from values
   * the prover knows is the schema itself, as the file would have made it;
   * any other schema is one the prover does not look inside.
   */
  const schemaOf = (lib: V & { readonly _tag: "Lib" }, args: ReadonlyArray<V>): V => {
    const unseen = (): V => ({ _tag: "Opaque", what: "a schema" });
    const fn = lib.host ?? Known.schemaOf(lib.module, lib.path);
    if (typeof fn !== "function") return unseen();
    const given: Array<unknown> = [];
    for (const arg of args) {
      const made = Known.real(arg);
      if (!made) return unseen();
      given.push(made.value);
    }
    try {
      // `Schema.Int.check(...)` is a method of the schema it is called on.
      const self = Known.schemaOf(lib.module, lib.path.slice(0, -1));
      const made: unknown = (fn as (...args: ReadonlyArray<unknown>) => unknown).apply(self, given);
      // A tagged union is kept: its helpers are functions the code calls on values.
      if (unionOf(made)) return { _tag: "Host", value: made, name: `Schema.${lib.path.join(".")}` };
      // Any other schema is not looked inside, and stands for the real one where a schema is built from it.
      const kept = unseen();
      if ((typeof made === "object" || typeof made === "function") && made !== null)
        Known.schemas.set(kept, made);
      return kept;
    } catch {
      return unseen();
    }
  };

  /**
   * `Status.guards`, `Status.isAnyOf`, `Status.match` and `Status.matchOrElse`
   * of a tagged union: each reads the value's tag, and a guard also asks that
   * the value is one its case allows.
   */
  const unionMember = (schema: unknown, key: string, name: string): V | undefined => {
    const union = unionOf(schema);
    if (!union) return undefined;
    const seen = (value: V | undefined): value is V =>
      value !== undefined && value._tag !== "Opaque" && value._tag !== "Applied";
    /** Whether the value's tag is the one named, known or as a formula. */
    const tagged = (value: V, tag: string, site: Site): Eval<boolean | string> =>
      value._tag !== "Obj" || (value.brand !== undefined && Brands.SEALED.has(value.brand.kind))
        ? Effect.succeed(false)
        : host
            .equal(value.fields[union.tag] ?? Value.undef, Value.str(tag), site)
            .pipe(Effect.flatMap((equal) => host.truth(equal, site)));
    /** The case's handler, called with the value: the first case whose tag the value has. */
    const matching = (
      value: V | undefined,
      cases: V | undefined,
      orElse: V | undefined,
      what: string,
      site: Site,
    ): Eval<V> =>
      Effect.gen(function* () {
        if (!seen(value) || cases?._tag !== "Obj") return yield* wrongArguments(site, what);
        for (const tag of Object.keys(union.cases)) {
          const is = yield* tagged(value, tag, site);
          if (typeof is === "boolean" ? !is : !(yield* host.branch(is))) continue;
          const handler = cases.fields[tag] ?? orElse;
          return handler
            ? yield* host.call(handler, [value], site)
            : yield* wrongArguments(site, what);
        }
        return orElse ? yield* host.call(orElse, [value], site) : yield* wrongArguments(site, what);
      });
    switch (key) {
      case "guards":
        return Value.obj(
          Object.fromEntries(
            Object.entries(union.cases).map(([tag, member]) => [
              tag,
              native(`${name}.guards.${tag}`, ([value], site) => {
                const ast = Symbolic.typeOf(member);
                return seen(value) && ast
                  ? Effect.succeed(Compare.fromTruth(Symbolic.fits(value, ast, host.current.run)))
                  : wrongArguments(site, `${name}.guards.${tag}`);
              }),
            ]),
          ),
        );
      case "isAnyOf":
        return native(`${name}.isAnyOf`, ([tags], site) => {
          const names = Kit.tagsOf(tags);
          return names === undefined
            ? wrongArguments(site, `${name}.isAnyOf`)
            : Effect.succeed(
                native(`${name}.isAnyOf`, ([value], at) =>
                  seen(value)
                    ? Effect.forEach(names, (tag) => tagged(value, tag, at)).pipe(
                        Effect.map((parts) => Compare.fromTruth(Compare.any(parts) ?? false)),
                      )
                    : wrongArguments(at, `${name}.isAnyOf`),
                ),
              );
        });
      case "match":
        return native(`${name}.match`, (args, site) =>
          args.length >= 2
            ? matching(args[0], args[1], undefined, `${name}.match`, site)
            : Effect.succeed(
                native(`${name}.match`, ([value], at) =>
                  matching(value, args[0], undefined, `${name}.match`, at),
                ),
              ),
        );
      case "matchOrElse":
        return native(`${name}.matchOrElse`, (args, site) =>
          args.length >= 3
            ? matching(args[0], args[1], args[2], `${name}.matchOrElse`, site)
            : Effect.succeed(
                native(`${name}.matchOrElse`, ([value], at) =>
                  matching(value, args[0], args[1], `${name}.matchOrElse`, at),
                ),
              ),
        );
      default:
        return undefined;
    }
  };

  return {
    /**
     * Every library function and value the prover has a model for, as
     * `module:path`, and every method of a string it reads.
     */
    surface: {
      library: [...Object.keys(models), ...Object.keys(values), ...Object.keys(clocks)].sort(),
      strings: [...strings.names].sort(),
    },
    opticMember: optics.member,
    /** A member of a latch or a semaphore: `latch.open`, `semaphore.withPermits`. */
    waitMember: (value: V, key: string, site: Site): V | undefined =>
      fibers.member(value, key, site) ?? folds.member(value, key),
    /** A sink: `Sink.count.pipe(Sink.map(f))` gives it to each function in turn. */
    piped: sinks.isSink,
    /** An instance of a class of the library that a file exports, other than one of `effect/Data`'s. */
    constructHost: fibers.constructs,
    /** A helper of a tagged union of `effect/Schema`, as a value the code calls. */
    unionMember,
    /** A method of a string, as a value the code calls. */
    stringMember: strings.member,
    /** What `yield*` gives inside `Option.gen` and `Result.gen`. */
    yielded: results.yielded,
    /** What a loop or a spread goes over. */
    iterate: kit.iterate,
    /** Whether a value is a class of `effect/Data`, which `new` makes an instance of. */
    isClass: (value: V): boolean => classes.has(value),
    /** A class of the library the code makes an instance of with `new`: its model is what makes it. */
    constructed: (module: string, path: ReadonlyArray<string>): boolean =>
      module === "effect/Cause" && path.length === 1 && path[0]!.endsWith("Error"),
    /** A class a file declares by extending one of `effect/Data`'s: its own class, with the same fields. */
    subclass: (base: V, name: string): V | undefined => {
      const extended = extending.get(base);
      if (extended) return extended(name);
      const kind = bases.get(base);
      return kind && dataClass(name, kind.tag, kind.error);
    },
    valueOf: (lib: V & { readonly _tag: "Lib" }, site: Site): V | undefined =>
      values[keyOf(lib)] ?? clocks[keyOf(lib)]?.(site),
    /**
     * Whether a package is one the prover knows by its models, and never
     * reads the code of: Effect, and Alchemy's own.
     */
    known: (specifier: string): boolean =>
      /^(effect|alchemy|@effect\/[^/]+|@alchemy\.run\/[^/]+)(\/|$)/.test(specifier) ||
      [...host.extra.keys(), ...Object.keys(models)].some((key) => key.startsWith(`${specifier}:`)),
    /** Whether the prover has a model for a library function. */
    models: (lib: V & { readonly _tag: "Lib" }): boolean =>
      host.extra.has(keyOf(lib)) || Object.hasOwn(models, keyOf(lib)) || isEnum(lib),
    call: (lib: V & { readonly _tag: "Lib" }, args: ReadonlyArray<V>, site: Site): Eval<V> => {
      // A pure function is run as it is, where the prover knows every argument.
      const computed = () => {
        const fn = hostOf(lib.module, lib.path);
        if (typeof fn !== "function") return undefined;
        // A function of the code the library is given is run where the library calls it.
        const before = Known.calling.run;
        Known.calling.run = (given, with_) => host.atOnce(given, with_, site);
        try {
          return Known.applied(
            fn as (...args: ReadonlyArray<unknown>) => unknown,
            args,
            `${lib.module.replace(/^effect\//, "")}.${lib.path.join(".")}`,
          );
        } finally {
          Known.calling.run = before;
        }
      };
      const model = host.extra.get(keyOf(lib)) ?? models[keyOf(lib)];
      // A model that has no reading of a call gives way to the function itself.
      if (model)
        return model(args, site).pipe(
          Effect.catchTag("NotTranslated", (stop) => {
            const made = stop.reaches ? undefined : computed();
            return made ? Effect.succeed(made) : Effect.fail(stop);
          }),
        );
      if (isEnum(lib)) return taggedEnum(lib, args, site);
      const made = computed();
      if (made) return Effect.succeed(made);
      // A schema is built, never run: what it describes is read where it is used.
      if (lib.module === "effect/Schema") return Effect.succeed(schemaOf(lib, args));
      return Effect.fail(
        Value.notTranslated(
          site,
          `calls ${[lib.module.replace(/^effect\//, ""), ...lib.path].join(".")}, which the prover has no model for`,
          true,
        ),
      );
    },
  };
};

/** The functions of `effect/Array` that `effect/Chunk` has under the same name, doing the same. */
const CHUNK: ReadonlySet<string> = new Set([
  "append",
  "appendAll",
  "prepend",
  "prependAll",
  "map",
  "filter",
  "flatMap",
  "flatten",
  "some",
  "every",
  "findFirst",
  "findLast",
  "findFirstIndex",
  "findLastIndex",
  "reduce",
  "reduceRight",
  "contains",
  "take",
  "takeRight",
  "takeWhile",
  "drop",
  "dropRight",
  "dropWhile",
  "reverse",
  "zip",
  "zipWith",
  "unzip",
  "dedupe",
  "union",
  "intersection",
  "difference",
  "join",
  "head",
  "last",
  "get",
  "make",
  "of",
  "empty",
  "range",
  "makeBy",
  "sort",
  "sortWith",
  "partition",
  "filterMap",
  "separate",
  "forEach",
  "headNonEmpty",
  "lastNonEmpty",
  "tailNonEmpty",
  "fromIterable",
  "chunksOf",
  "splitAt",
  "mapAccum",
  "modify",
  "replace",
  "remove",
]);

/** The functions of `effect/Array` that `effect/Iterable` has under the same name, doing the same. */
const ITERABLE: ReadonlySet<string> = new Set([
  "append",
  "appendAll",
  "prepend",
  "prependAll",
  "map",
  "filter",
  "flatMap",
  "flatten",
  "some",
  "findFirst",
  "findLast",
  "reduce",
  "contains",
  "take",
  "takeWhile",
  "drop",
  "head",
  "zip",
  "zipWith",
  "of",
  "empty",
  "range",
  "makeBy",
  "forEach",
  "countBy",
  "groupBy",
  "intersperse",
  "scan",
  "getSomes",
  "getSuccesses",
  "getFailures",
  "filterMap",
  "fromRecord",
  "cartesian",
  "cartesianWith",
  "chunksOf",
]);
