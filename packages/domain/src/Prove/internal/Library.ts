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

  const models: Readonly<Record<string, Model>> = {
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
