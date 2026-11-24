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
import * as Rationals from "./Models/Rationals.ts";
import * as Results from "./Models/Results.ts";
import * as Streams from "./Models/Streams.ts";
import * as Strings from "./Models/Strings.ts";
import type { Term } from "./Smt.ts";
import * as Smt from "./Smt.ts";
import * as Symbolic from "./Symbolic.ts";
import type { Eval, OpticStep, Site, V } from "./Value.ts";

export type { Host, Model } from "./Kit.ts";
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

  /** Change the part of `source` an optic focuses on; a focus that misses leaves it as it is. */
  const through = (
    path: ReadonlyArray<OpticStep>,
    source: V,
    change: (focus: V) => Eval<V>,
    site: Site,
  ): Eval<V> => {
    const [step, ...rest] = path;
    if (step === undefined) return change(source);
    if (source._tag !== "Obj")
      return Effect.fail(Value.notTranslated(site, `an optic focuses into a ${source._tag}`));
    if (step._tag === "Tag") {
      const tag = source.fields._tag;
      if (tag?._tag !== "Str")
        return Effect.fail(
          Value.notTranslated(site, "an optic matches a tag the prover cannot see"),
        );
      return tag.value === step.tag ? through(rest, source, change, site) : Effect.succeed(source);
    }
    return Effect.flatMap(host.member(source, step.key, site), (focus) =>
      through(rest, focus, change, site),
    ).pipe(
      Effect.map((changed) => Value.obj({ ...source.fields, [step.key]: changed }, source.brand)),
    );
  };

  /** `modify` and `replace`, data-first (`source, optic, x`) or data-last (`optic, x` then `source`). */
  const update =
    (name: string, change: (x: V, site: Site) => (focus: V) => Eval<V>): Model =>
    (args, site) => {
      const [a, b, c] = args;
      if (args.length === 3 && a && b?._tag === "Optic" && c)
        return through(b.path, a, change(c, site), site);
      if (args.length === 2 && a?._tag === "Optic" && b)
        return Effect.succeed(
          native(name, ([source], at) =>
            source ? through(a.path, source, change(b, at), at) : wrongArguments(at, name),
          ),
        );
      return wrongArguments(site, name);
    };

  const modify = update("Optic.modify", (f, site) => (focus) => host.call(f, [focus], site));
  const replace = update("Optic.replace", (value) => () => Effect.succeed(value));

  /** The methods of an optic value. */
  const opticMember = (optic: V & { readonly _tag: "Optic" }, key: string): V | undefined => {
    const extend = (make: (name: string) => OpticStep) =>
      native(`optic.${key}`, ([name], site) => {
        const value = str(name);
        return value === undefined
          ? wrongArguments(site, `optic.${key}`)
          : Effect.succeed<V>({ _tag: "Optic", path: [...optic.path, make(value)] });
      });
    switch (key) {
      case "tag":
        return extend((tag) => ({ _tag: "Tag", tag }));
      case "key":
        return extend((key) => ({ _tag: "Key", key }));
      case "modify":
        return native("optic.modify", ([f], site) =>
          f ? modify([optic, f], site) : wrongArguments(site, "optic.modify"),
        );
      case "replace":
        return native("optic.replace", ([value, source], site) =>
          value && source
            ? through(optic.path, source, () => Effect.succeed(value), site)
            : wrongArguments(site, "optic.replace"),
        );
      default:
        return undefined;
    }
  };

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
    otherwise: (input: V, site: Site) => Eval<V>,
    wrap: (result: V) => V,
    site: Site,
  ): Eval<V> =>
    Effect.gen(function* () {
      for (const one of state.cases)
        if (yield* one.takes(input, site))
          return wrap(yield* host.call(one.handler, [input], site));
      return yield* otherwise(input, site);
    });

  /** The end of a matcher's pipe: the result for `Match.value`, a function for `Match.type`. */
  const finished = (
    name: string,
    state: Matcher | undefined,
    otherwise: (input: V, site: Site) => Eval<V>,
    wrap: (result: V) => V,
    site: Site,
  ): Eval<V> =>
    !state
      ? wrongArguments(site, name)
      : state.subject
        ? matched(state, state.subject, otherwise, wrap, site)
        : Effect.succeed(
            native(name, ([input], at) =>
              input ? matched(state, input, otherwise, wrap, at) : wrongArguments(at, name),
            ),
          );

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
                (input, from) => host.call(otherwise, [input], from),
                same,
                at,
              ),
            ),
          )
        : wrongArguments(site, "Match.orElse"),
    "effect/Match:option": ([self], site) =>
      finished("Match.option", matcherOf(self), () => Effect.succeed(Value.none), Value.some, site),
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
    "effect/Optic:id": () => Effect.succeed<V>({ _tag: "Optic", path: [] }),
    "effect/Optic:modify": modify,
    "effect/Optic:replace": replace,
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
  const folds = Folds.make(
    kit,
    (key, args, site) => models[key]!(args, site),
    (key) => values[key] ?? Value.undef,
  );
  const rationals = Rationals.make(kit);

  const written: Record<string, Model> = {
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
    ...rationals.models,
    ...folds.models,
  };
  /** Classes of the library other than `effect/Data`'s, each with what a class that extends it is. */
  const extending = new WeakMap<object, (name: string) => V>();
  const asClass = (made: V, extended: (name: string) => V): V => {
    classes.add(made);
    extending.set(made, extended);
    return made;
  };
  const fibers = Fibers.make(kit, { ...written }, asClass);
  Object.assign(written, fibers.models);
  Object.assign(clocks, fibers.sited);
  const flows = Flows.make(kit, { ...written }, fibers.tools);
  Object.assign(written, flows.models);
  Object.assign(clocks, flows.sited);
  const channels = Channels.make(kit, { ...fibers.tools, real: flows.real, flow: flows.flow });
  Object.assign(written, channels.models);
  Object.assign(clocks, channels.sited);

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
    ...folds.constants,
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
    opticMember,
    /** A member of a latch or a semaphore: `latch.open`, `semaphore.withPermits`. */
    waitMember: (value: V, key: string, site: Site): V | undefined =>
      fibers.member(value, key, site) ?? folds.member(value, key),
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
        return typeof fn === "function"
          ? Known.applied(
              fn as (...args: ReadonlyArray<unknown>) => unknown,
              args,
              `${lib.module.replace(/^effect\//, "")}.${lib.path.join(".")}`,
            )
          : undefined;
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
