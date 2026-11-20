import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { Term } from "./Smt.ts";
import * as Smt from "./Smt.ts";
import type { Eval, OpticStep, Run, Site, V } from "./Value.ts";
import * as Value from "./Value.ts";

/** What the library models need from the interpreter. */
export interface Host {
  readonly current: { run: Run };
  readonly call: (fn: V, args: ReadonlyArray<V>, site: Site) => Eval<V>;
  /** What `yield*` on the value gives. */
  readonly settle: (value: V, site: Site) => Eval<V>;
  /** Whether a value is truthy on this path. */
  readonly decide: (value: V, site: Site) => Eval<boolean>;
  /** Whether two values are `===`, as a value: known, or a condition of the inputs. */
  readonly equal: (a: V, b: V, site: Site) => Eval<V>;
  /** A list with its items, when the value is one. */
  readonly force: (value: V) => V;
  /** An array's method that takes a function, such as `map`. */
  readonly array: (
    name: string,
    items: ReadonlyArray<V>,
    fn: V,
    initial: V | undefined,
    site: Site,
  ) => Eval<V>;
  /** The request contexts provided around the code being run, by tag. */
  readonly provided: Map<unknown, V>;
  /** Models a caller adds, by `module:path`. They come before the prover's own. */
  readonly extra: ReadonlyMap<string, Model>;
}

/** What a library function does to symbolic values. */
export type Model = (args: ReadonlyArray<V>, site: Site) => Eval<V>;

/** Milliseconds in a day. */
const DAY = 86_400_000;

const native = (name: string, call: Model): V => ({ _tag: "Native", name, call });
const effect = (run: Eval<V>): V => ({ _tag: "Effect", run });
const done: V = effect(Effect.succeed(Value.undef));

/**
 * The library functions the prover knows, each written once as what it does
 * to a symbolic value. A call to any other library function is not
 * translated, and the report names the call.
 */
export const make = (host: Host) => {
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
    return through(rest, source.fields[step.key] ?? Value.undef, change, site).pipe(
      Effect.map((changed) => Value.obj({ ...source.fields, [step.key]: changed }, source.brand)),
    );
  };

  const wrongArguments = (site: Site, name: string) =>
    Effect.fail(
      Value.notTranslated(site, `${name} is called in a way the prover has no model for`),
    );

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

  const str = (v: V | undefined): string | undefined => (v?._tag === "Str" ? v.value : undefined);

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

  /** `Effect.fn(body)`, `Effect.fn("name")(body)` and `Effect.fn(options)(body)`. */
  const fn: Model = ([first], site) =>
    first?._tag === "Fn"
      ? Effect.succeed<V>({ ...first, effectful: true })
      : first?._tag === "Str" || first?._tag === "Obj"
        ? Effect.succeed(native("Effect.fn", fn))
        : wrongArguments(site, "Effect.fn");

  const ignored: Model = () => Effect.succeed(done);

  /**
   * A function of an effect, called with the effect first (`f(effect, x)`) or
   * later through `pipe` (`f(x)` then the effect).
   */
  const onEffect =
    (
      name: string,
      extra: number,
      run: (self: Eval<V>, args: ReadonlyArray<V>, site: Site) => Eval<V>,
    ): Model =>
    (args, site) => {
      const [first, ...rest] = args;
      if (args.length === extra + 1 && first?._tag === "Effect")
        return Effect.suspend(() => run(first.run, rest, site)).pipe(effect, Effect.succeed);
      if (args.length === extra)
        return Effect.succeed(
          native(name, ([self], at) =>
            self?._tag === "Effect"
              ? Effect.suspend(() => run(self.run, args, at)).pipe(effect, Effect.succeed)
              : wrongArguments(at, name),
          ),
        );
      return wrongArguments(site, name);
    };

  /** What a step after an effect gives: a function of its value, another effect, or a plain value. */
  const then = (next: V, value: V, site: Site): Eval<V> =>
    next._tag === "Effect"
      ? next.run
      : next._tag === "Fn" || next._tag === "Native" || next._tag === "Lib"
        ? host
            .call(next, [value], site)
            .pipe(
              Effect.flatMap((made) => (made._tag === "Effect" ? made.run : Effect.succeed(made))),
            )
        : Effect.succeed(next);

  const tagsOf = (v: V | undefined): ReadonlyArray<string> | undefined =>
    v?._tag === "Str"
      ? [v.value]
      : v?._tag === "Arr" && v.items.every((item) => item._tag === "Str")
        ? v.items.map((item) => (item as { readonly value: string }).value)
        : undefined;

  const number =
    (
      name: string,
      fold: (a: number, b: number) => number,
      pick: (a: string, b: string) => string,
    ): Model =>
    (args, site) => {
      const [a, b] = args;
      if (args.length !== 2 || !a || !b) return wrongArguments(site, name);
      if (a._tag === "Num" && b._tag === "Num")
        return Effect.succeed(Value.num(fold(a.value, b.value)));
      const left = numeric(a);
      const right = numeric(b);
      if (!left || !right) return wrongArguments(site, name);
      const [x, y] = promote(left, right);
      return Effect.succeed(Value.term(x.sort, pick(x.text, y.text)));
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

  /**
   * A function written both ways: with what it works on first (`f(self, x)`),
   * or without it, to be given it by `pipe` (`f(x)` then `self`).
   */
  const dual =
    (name: string, arity: number, body: Model): Model =>
    (args, site) =>
      args.length >= arity
        ? body(args, site)
        : Effect.succeed(
            native(name, ([self], at) =>
              self ? body([self, ...args], at) : wrongArguments(at, name),
            ),
          );

  /** A function of an `Option`. */
  const onOption = (
    name: string,
    arity: number,
    body: (
      option: NonNullable<ReturnType<typeof Value.optionOf>>,
      rest: ReadonlyArray<V>,
      site: Site,
      self: V,
    ) => Eval<V>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) => {
      const option = Value.optionOf(self);
      return option && self ? body(option, rest, site, self) : wrongArguments(site, name);
    });

  /** `Option.fromNullishOr` and the two like it: what counts as nothing differs. */
  const fromNullable =
    (nothing: ReadonlyArray<V["_tag"]>): Model =>
    ([value]) =>
      Effect.succeed(!value || nothing.includes(value._tag) ? Value.none : Value.some(value));

  /** A function of an array, whose items the prover has to see. */
  const onArray = (
    name: string,
    arity: number,
    body: (items: ReadonlyArray<V>, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) => {
      const list = self ? host.force(self) : undefined;
      return list?._tag === "Arr" ? body(list.items, rest, site) : wrongArguments(site, name);
    });

  const arr = (items: ReadonlyArray<V>): V => ({ _tag: "Arr", items });

  /** An array's own method, as the library's function of the same name. */
  const method = (name: string, as = name): Model =>
    onArray(`Array.${name}`, 2, (items, [fn], site) =>
      fn ? host.array(as, items, fn, undefined, site) : wrongArguments(site, `Array.${name}`),
    );

  /** A function of an object whose keys the prover sees. */
  const onRecord = (
    name: string,
    arity: number,
    body: (fields: Readonly<Record<string, V>>, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) =>
      self?._tag === "Obj" && !self.brand
        ? body(self.fields, rest, site)
        : wrongArguments(site, name),
    );

  /** A key the code names: one the prover cannot see is not translated. */
  const keyed = (name: string, key: V | undefined, site: Site): Eval<string> =>
    key?._tag === "Str" || key?._tag === "Num"
      ? Effect.succeed(String(key.value))
      : Effect.fail(Value.notTranslated(site, `${name} is given a key the prover cannot see`));

  const keysOf = (name: string, keys: V | undefined, site: Site): Eval<ReadonlyArray<string>> =>
    keys?._tag === "Arr"
      ? Effect.forEach(keys.items, (key) => keyed(name, key, site))
      : Effect.fail(Value.notTranslated(site, `${name} is given keys the prover cannot see`));

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
          if (!(yield* takes(part, input.fields[key] ?? Value.undef, site))) return false;
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
        const tag = input.fields[field] ?? Value.undef;
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

  const models: Readonly<Record<string, Model>> = {
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
    "effect/Array:findFirst": onArray("Array.findFirst", 2, (items, [fn], site) =>
      fn
        ? Effect.gen(function* () {
            for (const item of items)
              if (yield* host.decide(yield* host.call(fn, [item], site), site))
                return Value.some(item);
            return Value.none;
          })
        : wrongArguments(site, "Array.findFirst"),
    ),
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
    // A rejection the code turns into a defect stops the path the same way.
    "effect/Effect:orDie": onEffect("Effect.orDie", 0, (self) => self),
    "effect/Effect:catchTag": onEffect("Effect.catchTag", 2, (self, [tag, handler], site) => {
      const tags = tagsOf(tag);
      if (!tags || !handler) return wrongArguments(site, "Effect.catchTag");
      return self.pipe(
        Effect.catchTag("Rejected", (rejected) => {
          const thrown = rejected.rejection;
          const name = thrown._tag === "Obj" ? thrown.fields._tag : undefined;
          return name?._tag === "Str" && tags.includes(name.value)
            ? host
                .call(handler, [thrown], site)
                .pipe(Effect.flatMap((made) => host.settle(made, site)))
            : Effect.fail(rejected);
        }),
      );
    }),
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
    "Math:max": number("Math.max", Math.max, (a, b) => `(ite (>= ${a} ${b}) ${a} ${b})`),
    "Math:min": number("Math.min", Math.min, (a, b) => `(ite (<= ${a} ${b}) ${a} ${b})`),
  };

  /** Library values that are not functions. */
  const values: Readonly<Record<string, V>> = {
    "effect/Effect:void": done,
  };

  const keyOf = (lib: V & { readonly _tag: "Lib" }): string =>
    `${lib.module}:${lib.path.join(".")}`;

  return {
    opticMember,
    valueOf: (lib: V & { readonly _tag: "Lib" }): V | undefined => values[keyOf(lib)],
    call: (lib: V & { readonly _tag: "Lib" }, args: ReadonlyArray<V>, site: Site): Eval<V> => {
      const model = host.extra.get(keyOf(lib)) ?? models[keyOf(lib)];
      if (model) return model(args, site);
      // A schema is built, never run: what it describes is read where it is used.
      if (lib.module === "effect/Schema")
        return Effect.succeed<V>({ _tag: "Opaque", what: "a schema" });
      return Effect.fail(
        Value.notTranslated(
          site,
          `calls ${lib.module.replace(/^effect\//, "")}.${lib.path.join(".")}, which the prover has no model for`,
        ),
      );
    },
  };
};

/** A number as a solver term, or `undefined` when the value is not a number. */
export const numeric = (v: V): Term | undefined =>
  v._tag === "Big"
    ? Smt.big(v.value)
    : v._tag === "Num"
      ? Number.isFinite(v.value)
        ? Number.isInteger(v.value)
          ? Smt.int(v.value)
          : Smt.real(v.value)
        : undefined
      : v._tag === "Term" && (v.term.sort === "Int" || v.term.sort === "Real")
        ? v.term
        : undefined;

const toReal = (term: Term): Term =>
  term.sort === "Int" ? { sort: "Real", text: `(to_real ${term.text})` } : term;

/** Two numbers in one sort: an integer next to a real becomes a real. */
export const promote = (a: Term, b: Term): readonly [Term, Term] =>
  a.sort === b.sort ? [a, b] : [toReal(a), toReal(b)];
