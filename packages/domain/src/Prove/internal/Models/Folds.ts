import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Metric from "effect/Metric";
import * as MutableList from "effect/MutableList";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, callable, done, dual, native, wrongArguments } from "../Kit.ts";
import * as Known from "../Known.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

const REF: Value.Brand = { kind: "Ref", cls: undefined };
/** What marks a cell as a `MutableList`. */
const LIST = "~list";

type Combine = (a: V, b: V, site: Site) => Eval<V>;

/**
 * `Combiner` and `Reducer`, the ones the library's modules give, and
 * `MutableList`. A combiner is the function it is made of, so it is read by
 * calling that function. A mutable list a handler makes is one only it
 * holds, so it is read as a local variable is.
 */
export const make = (
  kit: Kit,
  /** Another model of the library, by its `module:path`. */
  call: (key: string, args: ReadonlyArray<V>, site: Site) => Eval<V>,
  /** A value of the library that is not a function, by its `module:path`. */
  valueOf: (key: string) => V,
) => {
  const { host } = kit;

  const combineOf = (name: string, held: V | undefined, site: Site): Eval<V> => {
    const combine = held?._tag === "Obj" ? held.fields.combine : undefined;
    return combine && callable(combine) ? Effect.succeed(combine) : wrongArguments(site, name);
  };

  /** `combiner.combine(a, b)`, for a combiner the code gives. */
  const applied =
    (name: string, held: V | undefined): Combine =>
    (a, b, site) =>
      Effect.flatMap(combineOf(name, held, site), (combine) => host.call(combine, [a, b], site));

  const fn = (name: string, combine: Combine): V =>
    native(`${name}.combine`, ([a, b], site) =>
      a && b ? combine(a, b, site) : wrongArguments(site, name),
    );

  const combiner = (name: string, combine: Combine): V => Value.obj({ combine: fn(name, combine) });

  /** One after another from the first value, as `Reducer.make` folds when it is given no fold. */
  const folded =
    (name: string, combine: Combine, initial: V): Model =>
    ([collection], site) =>
      Effect.gen(function* () {
        const items = collection ? yield* kit.iterate(collection, site) : undefined;
        if (!items) return yield* wrongArguments(site, name);
        let out = initial;
        for (const item of items) out = yield* combine(out, item, site);
        return out;
      });

  const reducer = (name: string, combine: Combine, initial: V, all?: Model): V =>
    Value.obj({
      combine: fn(name, combine),
      initialValue: initial,
      combineAll: native(`${name}.combineAll`, all ?? folded(name, combine, initial)),
    });

  const initialOf = (name: string, held: V | undefined, site: Site): Eval<V> =>
    held?._tag === "Obj" && held.fields.initialValue
      ? Effect.succeed(held.fields.initialValue)
      : wrongArguments(site, name);

  const arithmetic =
    (operator: string): Combine =>
    (a, b, site) =>
      host.arithmetic(operator, a, b, site);
  const calling =
    (key: string): Combine =>
    (a, b, site) =>
      call(key, [a, b], site);

  const isNone = (v: V, site: Site): Eval<boolean> =>
    Effect.flatMap(host.member(v, "_tag", site), (tag) =>
      Effect.flatMap(host.equal(tag, Value.str("None"), site), (none) => host.decide(none, site)),
    );
  const isUndefined = (v: V, site: Site): Eval<boolean> =>
    Effect.flatMap(host.equal(v, Value.undef, site), (missing) => host.decide(missing, site));
  const valueIn = (v: V, site: Site): Eval<V> => host.member(v, "value", site);

  /** Both, or the one there is: `Option.makeReducer` and `UndefinedOr.makeReducer`. */
  const either =
    (
      missing: (v: V, site: Site) => Eval<boolean>,
      open: (v: V, site: Site) => Eval<V>,
      close: (v: V) => V,
      combine: Combine,
    ): Combine =>
    (a, b, site) =>
      Effect.gen(function* () {
        if (yield* missing(a, site)) return b;
        if (yield* missing(b, site)) return a;
        return close(yield* combine(yield* open(a, site), yield* open(b, site), site));
      });

  /** Both, or nothing when one is missing: the fail-fast ones. */
  const both =
    (
      missing: (v: V, site: Site) => Eval<boolean>,
      open: (v: V, site: Site) => Eval<V>,
      close: (v: V) => V,
      nothing: V,
      combine: Combine,
    ): Combine =>
    (a, b, site) =>
      Effect.gen(function* () {
        if ((yield* missing(a, site)) || (yield* missing(b, site))) return nothing;
        return close(yield* combine(yield* open(a, site), yield* open(b, site), site));
      });

  /** A fold that stops at the first value that is missing. */
  const failFast =
    (
      name: string,
      missing: (v: V, site: Site) => Eval<boolean>,
      combine: Combine,
      initial: V,
    ): Model =>
    ([collection], site) =>
      Effect.gen(function* () {
        const items = collection ? yield* kit.iterate(collection, site) : undefined;
        if (!items) return yield* wrongArguments(site, name);
        let out = initial;
        for (const item of items) {
          out = yield* combine(out, item, site);
          if (yield* missing(out, site)) return out;
        }
        return out;
      });

  const same = (v: V): V => v;
  const plain = (v: V): Eval<V> => Effect.succeed(v);

  /** The parts of a struct or a tuple of combiners, by key. */
  const partsOf = (
    name: string,
    held: V | undefined,
    site: Site,
  ): Eval<ReadonlyArray<readonly [key: string, part: V]>> => {
    if (held?._tag === "Obj" && !held.brand) return Effect.succeed(Object.entries(held.fields));
    const items = kit.itemsOf(held);
    return items
      ? Effect.succeed(items.map((item, index) => [String(index), item] as const))
      : wrongArguments(site, name);
  };

  /** A struct of what each key's combiner gives of the two, less the keys `omitKeyWhen` drops. */
  const struct =
    (name: string, combiners: V | undefined, omit: V | undefined): Combine =>
    (a, b, site) =>
      Effect.gen(function* () {
        const parts = yield* partsOf(name, combiners, site);
        const out: Record<string, V> = {};
        for (const [key, part] of parts) {
          const merged = yield* applied(name, part)(
            yield* host.member(a, key, site),
            yield* host.member(b, key, site),
            site,
          );
          if (omit && (yield* host.decide(yield* host.call(omit, [merged], site), site))) continue;
          out[key] = merged;
        }
        return Value.obj(out);
      });

  const tuple =
    (name: string, combiners: V | undefined): Combine =>
    (a, b, site) =>
      Effect.gen(function* () {
        const parts = yield* partsOf(name, combiners, site);
        const out: Array<V> = [];
        for (const [key, part] of parts)
          out.push(
            yield* applied(name, part)(
              yield* host.member(a, key, site),
              yield* host.member(b, key, site),
              site,
            ),
          );
        return arr(out);
      });

  const omitOf = (options: V | undefined): V | undefined => {
    const omit = options?._tag === "Obj" ? options.fields.omitKeyWhen : undefined;
    return omit && callable(omit) ? omit : undefined;
  };

  const models: Models = {
    "effect/Combiner:make": ([combine], site) =>
      combine && callable(combine)
        ? Effect.succeed(Value.obj({ combine }))
        : wrongArguments(site, "Combiner.make"),
    "effect/Combiner:flip": ([held]) =>
      Effect.succeed(
        combiner("Combiner.flip", (a, b, site) => applied("Combiner.flip", held)(b, a, site)),
      ),
    "effect/Combiner:min": ([order], site) =>
      order
        ? Effect.succeed(
            combiner("Combiner.min", (a, b, at) =>
              Effect.map(kit.before(order, a, b, at), (less) => (less ? a : b)),
            ),
          )
        : wrongArguments(site, "Combiner.min"),
    "effect/Combiner:max": ([order], site) =>
      order
        ? Effect.succeed(
            combiner("Combiner.max", (a, b, at) =>
              Effect.map(kit.before(order, b, a, at), (more) => (more ? a : b)),
            ),
          )
        : wrongArguments(site, "Combiner.max"),
    "effect/Combiner:first": () => Effect.succeed(combiner("Combiner.first", plain)),
    "effect/Combiner:last": () => Effect.succeed(combiner("Combiner.last", (_, b) => plain(b))),
    "effect/Combiner:constant": ([value]) =>
      Effect.succeed(combiner("Combiner.constant", () => plain(value ?? Value.undef))),
    "effect/Combiner:intercalate": ([middle]) =>
      Effect.succeed(
        native("Combiner.intercalate", ([held]) =>
          Effect.succeed(
            combiner("Combiner.intercalate", (a, b, site) => {
              const combine = applied("Combiner.intercalate", held);
              return Effect.flatMap(combine(middle ?? Value.undef, b, site), (rest) =>
                combine(a, rest, site),
              );
            }),
          ),
        ),
      ),
    "effect/Reducer:make": ([combine, initial, all], site) =>
      combine && callable(combine)
        ? Effect.succeed(
            Value.obj({
              combine,
              initialValue: initial ?? Value.undef,
              combineAll:
                all && callable(all)
                  ? all
                  : native(
                      "Reducer.combineAll",
                      folded(
                        "Reducer.make",
                        (a, b, at) => host.call(combine, [a, b], at),
                        initial ?? Value.undef,
                      ),
                    ),
            }),
          )
        : wrongArguments(site, "Reducer.make"),
    "effect/Reducer:flip": ([held], site) =>
      Effect.map(initialOf("Reducer.flip", held, site), (initial) =>
        reducer("Reducer.flip", (a, b, at) => applied("Reducer.flip", held)(b, a, at), initial),
      ),
    "effect/Newtype:makeCombiner": ([held]) => Effect.succeed(held ?? Value.undef),
    "effect/Newtype:makeReducer": ([held]) => Effect.succeed(held ?? Value.undef),
    "effect/Array:makeReducerConcat": () =>
      Effect.succeed(
        reducer("Array.makeReducerConcat", calling("effect/Array:appendAll"), arr([])),
      ),
    "effect/Array:getReadonlyReducerConcat": () =>
      Effect.succeed(
        reducer("Array.getReadonlyReducerConcat", calling("effect/Array:appendAll"), arr([])),
      ),
    "effect/Option:makeReducer": ([held]) =>
      Effect.succeed(
        reducer(
          "Option.makeReducer",
          either(isNone, valueIn, Value.some, applied("Option.makeReducer", held)),
          Value.none,
        ),
      ),
    "effect/Option:makeCombinerFailFast": ([held]) =>
      Effect.succeed(
        combiner(
          "Option.makeCombinerFailFast",
          both(
            isNone,
            valueIn,
            Value.some,
            Value.none,
            applied("Option.makeCombinerFailFast", held),
          ),
        ),
      ),
    "effect/Option:makeReducerFailFast": ([held], site) =>
      Effect.map(initialOf("Option.makeReducerFailFast", held, site), (initial) => {
        const name = "Option.makeReducerFailFast";
        const combine = both(isNone, valueIn, Value.some, Value.none, applied(name, held));
        return reducer(
          name,
          combine,
          Value.some(initial),
          failFast(name, isNone, combine, Value.some(initial)),
        );
      }),
    "effect/UndefinedOr:makeReducer": ([held]) =>
      Effect.succeed(
        reducer(
          "UndefinedOr.makeReducer",
          either(isUndefined, plain, same, applied("UndefinedOr.makeReducer", held)),
          Value.undef,
        ),
      ),
    "effect/UndefinedOr:makeCombinerFailFast": ([held]) =>
      Effect.succeed(
        combiner(
          "UndefinedOr.makeCombinerFailFast",
          both(
            isUndefined,
            plain,
            same,
            Value.undef,
            applied("UndefinedOr.makeCombinerFailFast", held),
          ),
        ),
      ),
    "effect/UndefinedOr:makeReducerFailFast": ([held], site) =>
      Effect.map(initialOf("UndefinedOr.makeReducerFailFast", held, site), (initial) => {
        const name = "UndefinedOr.makeReducerFailFast";
        const combine = both(isUndefined, plain, same, Value.undef, applied(name, held));
        return reducer(name, combine, initial, failFast(name, isUndefined, combine, initial));
      }),
    "effect/Record:makeReducerUnion": ([held], site) =>
      Effect.map(combineOf("Record.makeReducerUnion", held, site), (combine) =>
        reducer(
          "Record.makeReducerUnion",
          (a, b, at) => call("effect/Record:union", [a, b, combine], at),
          Value.obj({}),
        ),
      ),
    "effect/Record:makeReducerIntersection": ([held], site) =>
      Effect.map(combineOf("Record.makeReducerIntersection", held, site), (combine) =>
        reducer(
          "Record.makeReducerIntersection",
          (a, b, at) => call("effect/Record:intersection", [a, b, combine], at),
          Value.obj({}),
        ),
      ),
    "effect/Tuple:makeCombiner": ([combiners]) =>
      Effect.succeed(combiner("Tuple.makeCombiner", tuple("Tuple.makeCombiner", combiners))),
    "effect/Tuple:makeReducer": ([reducers], site) =>
      Effect.gen(function* () {
        const parts = yield* partsOf("Tuple.makeReducer", reducers, site);
        const initial: Array<V> = [];
        for (const [, part] of parts)
          initial.push(yield* initialOf("Tuple.makeReducer", part, site));
        return reducer("Tuple.makeReducer", tuple("Tuple.makeReducer", reducers), arr(initial));
      }),
    "effect/Struct:makeCombiner": ([combiners, options]) =>
      Effect.succeed(
        combiner("Struct.makeCombiner", struct("Struct.makeCombiner", combiners, omitOf(options))),
      ),
    "effect/Struct:makeReducer": ([reducers, options], site) =>
      Effect.gen(function* () {
        const omit = omitOf(options);
        const parts = yield* partsOf("Struct.makeReducer", reducers, site);
        const initial: Record<string, V> = {};
        for (const [key, part] of parts) {
          const first = yield* initialOf("Struct.makeReducer", part, site);
          if (omit && (yield* host.decide(yield* host.call(omit, [first], site), site))) continue;
          initial[key] = first;
        }
        return reducer(
          "Struct.makeReducer",
          struct("Struct.makeReducer", reducers, omit),
          Value.obj(initial),
        );
      }),
  };

  const big = (value: bigint): V => ({ _tag: "Big", value });
  const and: Combine = (a, b, site) => Effect.map(host.decide(a, site), (held) => (held ? b : a));
  const or: Combine = (a, b, site) => Effect.map(host.decide(a, site), (held) => (held ? a : b));
  const lesser = (order: string): Combine => {
    const held = valueOf(order);
    return (a, b, site) => Effect.map(kit.before(held, a, b, site), (less) => (less ? a : b));
  };
  const greater = (order: string): Combine => {
    const held = valueOf(order);
    return (a, b, site) => Effect.map(kit.before(held, b, a, site), (more) => (more ? a : b));
  };

  /** The greater or the lesser of two numbers, where the first value is one no number is beyond. */
  const bounded =
    (key: string, bound: number): Combine =>
    (a, b, site) => {
      if (a._tag === "Num" && a.value === bound) return Effect.succeed(b);
      if (b._tag === "Num" && b.value === bound) return Effect.succeed(a);
      return call(key, [a, b], site);
    };

  /** The reducers and combiners the library's modules give. */
  const values = (): Record<string, V> => ({
    "effect/Number:ReducerSum": reducer("Number.ReducerSum", arithmetic("+"), Value.num(0)),
    "effect/Number:ReducerMultiply": reducer(
      "Number.ReducerMultiply",
      arithmetic("*"),
      Value.num(1),
    ),
    "effect/Number:ReducerMax": reducer(
      "Number.ReducerMax",
      bounded("effect/Number:max", -Infinity),
      Value.num(-Infinity),
    ),
    "effect/Number:ReducerMin": reducer(
      "Number.ReducerMin",
      bounded("effect/Number:min", Infinity),
      Value.num(Infinity),
    ),
    "effect/BigInt:ReducerSum": reducer("BigInt.ReducerSum", arithmetic("+"), big(0n)),
    "effect/BigInt:ReducerMultiply": reducer("BigInt.ReducerMultiply", arithmetic("*"), big(1n)),
    "effect/BigInt:CombinerMax": combiner("BigInt.CombinerMax", calling("effect/BigInt:max")),
    "effect/BigInt:CombinerMin": combiner("BigInt.CombinerMin", calling("effect/BigInt:min")),
    "effect/Boolean:ReducerAnd": reducer("Boolean.ReducerAnd", and, Value.bool(true)),
    "effect/Boolean:ReducerOr": reducer("Boolean.ReducerOr", or, Value.bool(false)),
    "effect/String:ReducerConcat": reducer("String.ReducerConcat", arithmetic("+"), Value.str("")),
    "effect/Duration:ReducerSum": reducer(
      "Duration.ReducerSum",
      calling("effect/Duration:sum"),
      valueOf("effect/Duration:zero"),
    ),
    "effect/Duration:CombinerMax": combiner(
      "Duration.CombinerMax",
      greater("effect/Duration:Order"),
    ),
    "effect/Duration:CombinerMin": combiner(
      "Duration.CombinerMin",
      lesser("effect/Duration:Order"),
    ),
  });

  // ---- A mutable list.

  /** The symbol `MutableList.take` gives of an empty list: the library's own, equal only to itself. */
  const EMPTY: V = { _tag: "Host", value: MutableList.Empty, name: "MutableList.Empty" };

  const listOf = (v: V | undefined): Record<string, V> | undefined =>
    v?._tag === "Obj" && v.brand?.kind === "Ref" && v.fields[LIST]
      ? (v.fields as Record<string, V>)
      : undefined;
  const itemsIn = (fields: Record<string, V>): ReadonlyArray<V> => kit.itemsOf(fields.value) ?? [];
  const keep = (fields: Record<string, V>, items: ReadonlyArray<V>): void => {
    fields.value = arr(items);
    fields.length = Value.num(items.length);
  };

  /** A function of a mutable list: it reads the items, and may leave others. */
  const onList =
    (
      name: string,
      run: (
        items: ReadonlyArray<V>,
        rest: ReadonlyArray<V>,
        site: Site,
      ) => Eval<{ readonly after?: ReadonlyArray<V>; readonly gives?: V }>,
    ): Model =>
    ([self, ...rest], site) => {
      const fields = listOf(self);
      return fields
        ? Effect.map(run(itemsIn(fields), rest, site), (made) => {
            if (made.after) keep(fields, made.after);
            return made.gives ?? Value.undef;
          })
        : wrongArguments(site, name);
    };

  const iterated = (name: string, given: V | undefined, site: Site): Eval<ReadonlyArray<V>> =>
    Effect.flatMap(given ? kit.iterate(given, site) : Effect.succeed(undefined), (items) =>
      items ? Effect.succeed(items) : wrongArguments(site, name),
    );

  /** How many items a count the code writes takes: none for a count below one. */
  const upTo = (name: string, n: V | undefined, site: Site): Eval<number> =>
    n?._tag === "Num" && Number.isInteger(n.value)
      ? Effect.succeed(Math.max(0, n.value))
      : Effect.fail(Value.notTranslated(site, `calls ${name} without a count the prover can see`));

  const kept = (
    name: string,
    items: ReadonlyArray<V>,
    test: (item: V, index: number) => Eval<V>,
    site: Site,
  ): Eval<ReadonlyArray<V>> =>
    Effect.gen(function* () {
      void name;
      const out: Array<V> = [];
      for (const [index, item] of items.entries())
        if (yield* host.decide(yield* test(item, index), site)) out.push(item);
      return out;
    });

  const lists: Models = {
    "effect/MutableList:make": () =>
      Effect.sync(() =>
        Value.obj({ [LIST]: Value.bool(true), value: arr([]), length: Value.num(0) }, REF),
      ),
    "effect/MutableList:append": onList("MutableList.append", (items, [item]) =>
      Effect.succeed({ after: [...items, item ?? Value.undef] }),
    ),
    "effect/MutableList:prepend": onList("MutableList.prepend", (items, [item]) =>
      Effect.succeed({ after: [item ?? Value.undef, ...items] }),
    ),
    "effect/MutableList:appendAll": onList("MutableList.appendAll", (items, [given], site) =>
      Effect.map(iterated("MutableList.appendAll", given, site), (more) => ({
        after: [...items, ...more],
        gives: Value.num(more.length),
      })),
    ),
    "effect/MutableList:prependAll": onList("MutableList.prependAll", (items, [given], site) =>
      Effect.map(iterated("MutableList.prependAll", given, site), (more) => ({
        after: [...more, ...items],
      })),
    ),
    "effect/MutableList:appendAllUnsafe": onList(
      "MutableList.appendAllUnsafe",
      (items, [given], site) =>
        Effect.map(iterated("MutableList.appendAllUnsafe", given, site), (more) => ({
          after: [...items, ...more],
          gives: Value.num(more.length),
        })),
    ),
    "effect/MutableList:prependAllUnsafe": onList(
      "MutableList.prependAllUnsafe",
      (items, [given], site) =>
        Effect.map(iterated("MutableList.prependAllUnsafe", given, site), (more) => ({
          after: [...more, ...items],
        })),
    ),
    "effect/MutableList:clear": onList("MutableList.clear", () => Effect.succeed({ after: [] })),
    "effect/MutableList:take": onList("MutableList.take", (items) =>
      Effect.succeed(
        items.length === 0 ? { gives: EMPTY } : { after: items.slice(1), gives: items[0]! },
      ),
    ),
    "effect/MutableList:takeN": onList("MutableList.takeN", (items, [n], site) =>
      Effect.map(upTo("MutableList.takeN", n, site), (count) => ({
        after: items.slice(count),
        gives: arr(items.slice(0, count)),
      })),
    ),
    "effect/MutableList:takeNVoid": onList("MutableList.takeNVoid", (items, [n], site) =>
      Effect.map(upTo("MutableList.takeNVoid", n, site), (count) => ({
        after: items.slice(count),
      })),
    ),
    "effect/MutableList:takeAll": onList("MutableList.takeAll", (items) =>
      Effect.succeed({ after: [], gives: arr(items) }),
    ),
    "effect/MutableList:toArray": onList("MutableList.toArray", (items) =>
      Effect.succeed({ gives: arr(items) }),
    ),
    "effect/MutableList:toArrayN": onList("MutableList.toArrayN", (items, [n], site) =>
      Effect.map(upTo("MutableList.toArrayN", n, site), (count) => ({
        gives: arr(items.slice(0, count)),
      })),
    ),
    "effect/MutableList:filter": onList("MutableList.filter", (items, [test], site) =>
      test && callable(test)
        ? Effect.map(
            kept(
              "MutableList.filter",
              items,
              (item, index) => host.call(test, [item, Value.num(index)], site),
              site,
            ),
            (after) => ({ after }),
          )
        : wrongArguments(site, "MutableList.filter"),
    ),
    "effect/MutableList:remove": onList("MutableList.remove", (items, [value], site) =>
      Effect.map(
        kept(
          "MutableList.remove",
          items,
          (item) =>
            Effect.flatMap(host.equal(item, value ?? Value.undef, site), (equal) =>
              Effect.map(host.decide(equal, site), (held) => Value.bool(!held)),
            ),
          site,
        ),
        (after) => ({ after }),
      ),
    ),
  };

  // ---- A metric: what a handler writes to one decides nothing, so it is read as doing nothing.

  /** What marks a value as a metric. */
  const METRIC = "~metric";
  const metric = (): Eval<V> => Effect.succeed(Value.obj({ [METRIC]: Value.bool(true) }, REF));
  const isMetric = (v: V | undefined): boolean =>
    v?._tag === "Obj" && v.brand?.kind === "Ref" && v.fields[METRIC] !== undefined;
  const onMetric = (name: string, gives: (self: V) => V): Model =>
    dual(name, 2, ([self], site) =>
      self && isMetric(self) ? Effect.succeed(gives(self)) : wrongArguments(site, name),
    );
  /** The bounds of a histogram, worked out by the library from numbers the code writes. */
  const bounds =
    (name: string, make_: (given: never) => ReadonlyArray<number>): Model =>
    ([given], site) => {
      const real = given ? Known.real(given) : undefined;
      return real
        ? Effect.try({
            try: () => arr(make_(real.value as never).map(Value.num)),
            catch: () => Value.notTranslated(site, `calls ${name} with bounds it does not take`),
          })
        : wrongArguments(site, name);
    };

  const metrics: Models = {
    "effect/Metric:counter": metric,
    "effect/Metric:gauge": metric,
    "effect/Metric:frequency": metric,
    "effect/Metric:histogram": metric,
    "effect/Metric:summary": metric,
    "effect/Metric:summaryWithTimestamp": metric,
    "effect/Metric:timer": metric,
    "effect/Metric:isMetric": ([value]) => Effect.succeed(Value.bool(isMetric(value))),
    "effect/Metric:update": onMetric("Metric.update", () => done),
    "effect/Metric:modify": onMetric("Metric.modify", () => done),
    "effect/Metric:withAttributes": onMetric("Metric.withAttributes", (self) => self),
    "effect/Metric:mapInput": onMetric("Metric.mapInput", (self) => self),
    "effect/Metric:withConstantInput": onMetric("Metric.withConstantInput", (self) => self),
    "effect/Metric:linearBoundaries": bounds("Metric.linearBoundaries", Metric.linearBoundaries),
    "effect/Metric:exponentialBoundaries": bounds(
      "Metric.exponentialBoundaries",
      Metric.exponentialBoundaries,
    ),
    "effect/Metric:boundariesFromIterable": bounds(
      "Metric.boundariesFromIterable",
      Metric.boundariesFromIterable,
    ),
    "effect/Metric:value": (_, site) =>
      Effect.fail(
        Value.notTranslated(
          site,
          "calls Metric.value, which reads a metric: what one holds is not what a handler decides by",
        ),
      ),
  };

  // ---- A hash of a value the code writes: the library's own.

  /** A number, text, a boolean or nothing, as the library hashes one. */
  const hashed =
    (name: string, hash: (value: never) => number, plain: boolean): Model =>
    ([value], site) => {
      const real =
        value &&
        (plain
          ? ["Num", "Str", "Bool", "Null", "Undef", "Big"].includes(value._tag)
          : value._tag === "Arr" || (value._tag === "Obj" && !value.brand))
          ? Known.real(value)
          : undefined;
      return real
        ? Effect.sync(() => Value.num(hash(real.value as never)))
        : Effect.fail(Value.notTranslated(site, `calls ${name} on a value the prover cannot hash`));
    };

  const hashes: Models = {
    "effect/Hash:hash": hashed("Hash.hash", Hash.hash, true),
    "effect/Hash:number": hashed("Hash.number", Hash.number, true),
    "effect/Hash:string": hashed("Hash.string", Hash.string, true),
    "effect/Hash:optimize": hashed("Hash.optimize", Hash.optimize, true),
    "effect/Hash:array": hashed("Hash.array", Hash.array, false),
    "effect/Hash:structure": hashed("Hash.structure", Hash.structure, false),
    "effect/Hash:combine": dual("Hash.combine", 2, ([self, that], site) =>
      self?._tag === "Num" && that?._tag === "Num"
        ? Effect.sync(() => Value.num(Hash.combine(self.value, that.value)))
        : Effect.fail(
            Value.notTranslated(site, "calls Hash.combine on a value the prover cannot hash"),
          ),
    ),
    "effect/Hash:isHash": ([value], site) =>
      value && ["Num", "Str", "Bool", "Null", "Undef", "Big", "Arr"].includes(value._tag)
        ? Effect.succeed(Value.bool(false))
        : wrongArguments(site, "Hash.isHash"),
  };

  /** `list.length`: how many items a mutable list holds. */
  const member = (value: V, key: string): V | undefined =>
    key === "length" ? listOf(value)?.length : undefined;

  return {
    member,
    models: { ...models, ...lists, ...metrics, ...hashes },
    values,
    constants: { "effect/MutableList:Empty": EMPTY } as Readonly<Record<string, V>>,
  };
};
