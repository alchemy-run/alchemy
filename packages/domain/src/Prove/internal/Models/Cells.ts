import * as Effect from "effect/Effect";
import * as Brands from "../Brands.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { callable, done, dual, lazy, native, str, tagOf, wrongArguments } from "../Kit.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

const REF: Value.Brand = { kind: "Ref", cls: undefined };
/** The functions of a `Ref` that a `SynchronizedRef` and a `SubscriptionRef` have too. */
const SHARED =
  "make get getUnsafe set setAndGet getAndSet update updateAndGet getAndUpdate modify".split(" ");
/** The field of a `SubscriptionRef` that holds how its readers are told of a value. */
export const CHANGES = "~changes";
const REDACTED: Value.Brand = { kind: "Redacted", cls: undefined };

/**
 * `Ref` and the `Mutable` cells, `Redacted`, `Filter`, `Ordering`,
 * `UndefinedOr` and `Console`. A cell a handler makes is one only it holds:
 * what it reads is what it last wrote, so it is read as a local variable is.
 * `call` runs another model of the library, by its `module:path`.
 */
export const make = (
  kit: Kit,
  call: (key: string, args: ReadonlyArray<V>, site: Site) => Eval<V>,
) => {
  const { host } = kit;

  const cellOf = (v: V | undefined): Record<string, V> | undefined =>
    v?._tag === "Obj" && v.brand?.kind === "Ref" ? (v.fields as Record<string, V>) : undefined;

  const cell = (value: V): V => Value.obj({ value }, REF);

  /** A function of a `Ref` that gives an effect: the cell is read and written when the effect runs. */
  const onRef = (
    name: string,
    arity: number,
    run: (cell: Record<string, V>, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) => {
      const fields = cellOf(self);
      return fields
        ? Effect.succeed(lazy(() => run(fields, rest, site)))
        : wrongArguments(site, name);
    });

  const held = (fields: Record<string, V>): V => fields.value ?? Value.undef;

  /** What a function gives of what a cell holds, where it gives a new value: nothing where it gives none. */
  const some = (
    name: string,
    fn: V | undefined,
    fields: Record<string, V>,
    site: Site,
  ): Eval<V | undefined> =>
    fn
      ? Effect.flatMap(host.call(fn, [held(fields)], site), (made) => {
          const option = Value.optionOf(made);
          return option
            ? Effect.succeed(option._tag === "Some" ? option.value : undefined)
            : wrongArguments(site, name);
        })
      : wrongArguments(site, name);

  /** A function of an effect that only says how it is written out: the effect is what it was. */
  const watched =
    (name: string): Model =>
    (args) => {
      const first = args[0];
      return first?._tag === "Effect"
        ? Effect.succeed(first)
        : Effect.succeed(
            native(name, ([self], at) =>
              self?._tag === "Effect" ? Effect.succeed(self) : wrongArguments(at, name),
            ),
          );
    };

  const changed = (name: string, fn: V | undefined, fields: Record<string, V>, site: Site) =>
    fn ? host.call(fn, [held(fields)], site) : wrongArguments(site, name);

  const handlerOf = (cases: V | undefined, key: string): V | undefined =>
    cases?._tag === "Obj" ? cases.fields[key] : undefined;

  /** A function of a mutable cell, which changes it where it stands and gives the cell back. */
  const mutating = (
    name: string,
    arity: number,
    run: (before: V, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) => {
      const fields = cellOf(self);
      return fields && self
        ? Effect.map(run(held(fields), rest, site), (after) => {
            fields.value = after;
            return self;
          })
        : wrongArguments(site, name);
    });

  /** A function of a mutable cell that reads it, and may give what it read after a change. */
  const reading = (
    name: string,
    arity: number,
    run: (
      before: V,
      rest: ReadonlyArray<V>,
      site: Site,
    ) => Eval<{ readonly after?: V; readonly gives: V }>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) => {
      const fields = cellOf(self);
      return fields
        ? Effect.map(run(held(fields), rest, site), (made) => {
            if (made.after) fields.value = made.after;
            return made.gives;
          })
        : wrongArguments(site, name);
    });

  const one = (before: V): V => (Value.isBig(before) ? { _tag: "Big", value: 1n } : Value.num(1));

  const stepped =
    (operator: "+" | "-", gives: "self" | "after" | "before"): Model =>
    ([self], site) => {
      const fields = cellOf(self);
      if (!fields || !self) return wrongArguments(site, "MutableRef");
      const before = held(fields);
      return Effect.map(host.arithmetic(operator, before, one(before), site), (after) => {
        fields.value = after;
        return gives === "self" ? self : gives === "after" ? after : before;
      });
    };

  /** A function of a mutable hash set or hash map: the same function of the one it holds. */
  const delegated = (name: string, key: string, arity: number, keeps: boolean): Model =>
    dual(name, arity, ([self, ...rest], site) => {
      const fields = cellOf(self);
      return fields && self
        ? Effect.map(call(key, [held(fields), ...rest], site), (made) => {
            if (!keeps) return made;
            fields.value = made;
            return self;
          })
        : wrongArguments(site, name);
    });

  /** A mutable hash set or hash map, made as the one it holds is. */
  const holding =
    (key: string): Model =>
    (args, site) =>
      Effect.map(call(key, args, site), cell);

  const filter = (name: string, test: (input: V, site: Site) => Eval<V>): V =>
    native(name, ([input], site) => test(input ?? Value.undef, site));

  const result = (held: boolean, input: V): V =>
    held ? Brands.success(input) : Brands.failure(input);

  /** What the function gives for what the cell holds, where it gives an effect. */
  const changedBy = (name: string, fn: V | undefined, fields: Record<string, V>, site: Site) =>
    Effect.flatMap(changed(name, fn, fields, site), (made) =>
      made._tag === "Effect" ? made.run : wrongArguments(site, name),
    );

  /**
   * A `Ref` whose changes may be effects. A handler is the only one that
   * holds it and nothing runs beside a handler, so it is the same cell: a
   * change that fails leaves it as it was.
   */
  /**
   * A `SubscriptionRef` tells whoever reads its changes of every value it is
   * given. The cell does so wherever it is written: {@link CHANGES} holds
   * what is told, once a stream of its changes was asked for.
   */
  const published = (made: V): V => {
    const fields = cellOf(made);
    if (!fields) return made;
    let value = fields.value ?? Value.undef;
    Object.defineProperty(fields, "value", {
      enumerable: true,
      get: () => value,
      set: (next: V) => {
        value = next;
        const told = fields[CHANGES];
        if (told?._tag === "Host") (told.value as (value: V) => void)(next);
      },
    });
    return made;
  };

  const synchronized = (module: string): Models => ({
    ...Object.fromEntries(
      SHARED.concat(module === "SynchronizedRef" ? ["makeUnsafe"] : []).map(
        (name): [string, Model] => [
          `effect/${module}:${name}`,
          (args, site) =>
            Effect.map(call(`effect/Ref:${name}`, args, site), (made) =>
              module === "SubscriptionRef" && name === "make" && made._tag === "Effect"
                ? lazy(() => Effect.map(made.run, published))
                : made,
            ),
        ],
      ),
    ),
    [`effect/${module}:updateEffect`]: onRef(`${module}.updateEffect`, 2, (fields, [fn], site) =>
      Effect.map(changedBy(`${module}.updateEffect`, fn, fields, site), (after) => {
        fields.value = after;
        return Value.undef;
      }),
    ),
    [`effect/${module}:updateAndGetEffect`]: onRef(
      `${module}.updateAndGetEffect`,
      2,
      (fields, [fn], site) =>
        Effect.map(changedBy(`${module}.updateAndGetEffect`, fn, fields, site), (after) => {
          fields.value = after;
          return after;
        }),
    ),
    [`effect/${module}:getAndUpdateEffect`]: onRef(
      `${module}.getAndUpdateEffect`,
      2,
      (fields, [fn], site) => {
        const before = held(fields);
        return Effect.map(changedBy(`${module}.getAndUpdateEffect`, fn, fields, site), (after) => {
          fields.value = after;
          return before;
        });
      },
    ),
    [`effect/${module}:modifyEffect`]: onRef(`${module}.modifyEffect`, 2, (fields, [fn], site) =>
      Effect.flatMap(changedBy(`${module}.modifyEffect`, fn, fields, site), (made) => {
        const pair = kit.itemsOf(made);
        if (!pair || pair.length !== 2) return wrongArguments(site, `${module}.modifyEffect`);
        fields.value = pair[1]!;
        return Effect.succeed(pair[0]!);
      }),
    ),
  });

  const models: Models = {
    "effect/MutableRef:make": ([value]) => Effect.succeed(cell(value ?? Value.undef)),
    "effect/MutableRef:get": reading("MutableRef.get", 1, (before) =>
      Effect.succeed({ gives: before }),
    ),
    "effect/MutableRef:set": mutating("MutableRef.set", 2, (_, [value]) =>
      Effect.succeed(value ?? Value.undef),
    ),
    "effect/MutableRef:setAndGet": reading("MutableRef.setAndGet", 2, (_, [value]) =>
      Effect.succeed({ after: value ?? Value.undef, gives: value ?? Value.undef }),
    ),
    "effect/MutableRef:getAndSet": reading("MutableRef.getAndSet", 2, (before, [value]) =>
      Effect.succeed({ after: value ?? Value.undef, gives: before }),
    ),
    "effect/MutableRef:update": mutating("MutableRef.update", 2, (before, [fn], site) =>
      fn ? host.call(fn, [before], site) : wrongArguments(site, "MutableRef.update"),
    ),
    "effect/MutableRef:updateAndGet": reading("MutableRef.updateAndGet", 2, (before, [fn], site) =>
      fn
        ? Effect.map(host.call(fn, [before], site), (after) => ({ after, gives: after }))
        : wrongArguments(site, "MutableRef.updateAndGet"),
    ),
    "effect/MutableRef:getAndUpdate": reading("MutableRef.getAndUpdate", 2, (before, [fn], site) =>
      fn
        ? Effect.map(host.call(fn, [before], site), (after) => ({ after, gives: before }))
        : wrongArguments(site, "MutableRef.getAndUpdate"),
    ),
    "effect/MutableRef:increment": stepped("+", "self"),
    "effect/MutableRef:decrement": stepped("-", "self"),
    "effect/MutableRef:incrementAndGet": stepped("+", "after"),
    "effect/MutableRef:decrementAndGet": stepped("-", "after"),
    "effect/MutableRef:getAndIncrement": stepped("+", "before"),
    "effect/MutableRef:getAndDecrement": stepped("-", "before"),
    "effect/MutableRef:toggle": mutating("MutableRef.toggle", 1, (before, _, site) =>
      Effect.map(host.decide(before, site), (on) => Value.bool(!on)),
    ),
    "effect/MutableHashSet:empty": holding("effect/HashSet:empty"),
    "effect/MutableHashSet:make": holding("effect/HashSet:make"),
    "effect/MutableHashSet:fromIterable": holding("effect/HashSet:fromIterable"),
    "effect/MutableHashSet:add": delegated("MutableHashSet.add", "effect/HashSet:add", 2, true),
    "effect/MutableHashSet:remove": delegated(
      "MutableHashSet.remove",
      "effect/HashSet:remove",
      2,
      true,
    ),
    "effect/MutableHashSet:has": delegated("MutableHashSet.has", "effect/HashSet:has", 2, false),
    "effect/MutableHashSet:size": delegated("MutableHashSet.size", "effect/HashSet:size", 1, false),
    "effect/MutableHashSet:clear": mutating("MutableHashSet.clear", 1, (_, __, site) =>
      call("effect/HashSet:empty", [], site),
    ),
    "effect/MutableHashMap:empty": holding("effect/HashMap:empty"),
    "effect/MutableHashMap:make": holding("effect/HashMap:make"),
    "effect/MutableHashMap:fromIterable": holding("effect/HashMap:fromIterable"),
    "effect/MutableHashMap:get": delegated("MutableHashMap.get", "effect/HashMap:get", 2, false),
    "effect/MutableHashMap:has": delegated("MutableHashMap.has", "effect/HashMap:has", 2, false),
    "effect/MutableHashMap:set": delegated("MutableHashMap.set", "effect/HashMap:set", 3, true),
    "effect/MutableHashMap:remove": delegated(
      "MutableHashMap.remove",
      "effect/HashMap:remove",
      2,
      true,
    ),
    "effect/MutableHashMap:modify": delegated(
      "MutableHashMap.modify",
      "effect/HashMap:modify",
      3,
      true,
    ),
    "effect/MutableHashMap:modifyAt": delegated(
      "MutableHashMap.modifyAt",
      "effect/HashMap:modifyAt",
      3,
      true,
    ),
    "effect/MutableHashMap:size": delegated("MutableHashMap.size", "effect/HashMap:size", 1, false),
    "effect/MutableHashMap:isEmpty": delegated(
      "MutableHashMap.isEmpty",
      "effect/HashMap:isEmpty",
      1,
      false,
    ),
    "effect/MutableHashMap:keys": delegated("MutableHashMap.keys", "effect/HashMap:keys", 1, false),
    "effect/MutableHashMap:values": delegated(
      "MutableHashMap.values",
      "effect/HashMap:values",
      1,
      false,
    ),
    "effect/MutableHashMap:clear": mutating("MutableHashMap.clear", 1, (_, __, site) =>
      call("effect/HashMap:empty", [], site),
    ),
    // What is hidden from a log is still the value the code has.
    "effect/Redacted:make": ([value]) =>
      Effect.succeed(Value.obj({ value: value ?? Value.undef }, REDACTED)),
    "effect/Redacted:value": ([self], site) =>
      self?._tag === "Obj" && self.brand?.kind === "Redacted"
        ? Effect.succeed(self.fields.value ?? Value.undef)
        : wrongArguments(site, "Redacted.value"),
    "effect/Redacted:isRedacted": ([value]) =>
      Effect.succeed(Value.bool(value?._tag === "Obj" && value.brand?.kind === "Redacted")),
    // A filter is a function that gives a `Result`: what passed, or what did not.
    "effect/Filter:make": ([f], site) =>
      callable(f) ? Effect.succeed(f) : wrongArguments(site, "Filter.make"),
    "effect/Filter:fromPredicate": ([predicate], site) =>
      callable(predicate)
        ? Effect.succeed(
            filter("Filter.fromPredicate", (input, at) =>
              Effect.map(kit.holds(predicate, [input], at), (passed) => result(passed, input)),
            ),
          )
        : wrongArguments(site, "Filter.fromPredicate"),
    "effect/Filter:tagged": ([tag], site) => {
      const name = str(tag);
      return name === undefined
        ? wrongArguments(site, "Filter.tagged")
        : Effect.succeed(
            filter("Filter.tagged", (input) =>
              Effect.succeed(result(tagOf(input) === name, input)),
            ),
          );
    },
    "effect/Filter:equals": ([value], site) =>
      value
        ? Effect.succeed(
            filter("Filter.equals", (input, at) =>
              Effect.flatMap(kit.equals(input, value, at), (equal) =>
                Effect.map(host.decide(equal, at), (passed) =>
                  passed ? Brands.success(value) : Brands.failure(input),
                ),
              ),
            ),
          )
        : wrongArguments(site, "Filter.equals"),
    "effect/Filter:toPredicate": ([self], site) =>
      callable(self)
        ? Effect.succeed(
            filter("Filter.toPredicate", (input, at) =>
              Effect.map(host.call(self, [input], at), (made) =>
                Value.bool(Brands.resultOf(made)?._tag !== "Failure"),
              ),
            ),
          )
        : wrongArguments(site, "Filter.toPredicate"),
    "effect/Filter:toOption": ([self], site) =>
      callable(self)
        ? Effect.succeed(
            filter("Filter.toOption", (input, at) =>
              Effect.flatMap(host.call(self, [input], at), (made) => {
                const read = Brands.resultOf(made);
                return read
                  ? Effect.succeed(read._tag === "Success" ? Value.some(read.success) : Value.none)
                  : wrongArguments(at, "Filter.toOption");
              }),
            ),
          )
        : wrongArguments(site, "Filter.toOption"),
    "effect/Filter:toResult": ([self], site) =>
      callable(self) ? Effect.succeed(self) : wrongArguments(site, "Filter.toResult"),
    // Output: nothing a handler decides depends on it.
    "effect/Console:log": () => Effect.succeed(done),
    "effect/Console:error": () => Effect.succeed(done),
    "effect/Console:warn": () => Effect.succeed(done),
    "effect/Console:info": () => Effect.succeed(done),
    "effect/Console:debug": () => Effect.succeed(done),
    ...Object.fromEntries(
      "assert count countReset dir dirxml group table time timeLog trace"
        .split(" ")
        .map((name): [string, Model] => [`effect/Console:${name}`, () => Effect.succeed(done)]),
    ),
    // The effect, written under a heading or timed: what it gives is what it gave.
    "effect/Console:withGroup": watched("Console.withGroup"),
    "effect/Console:withTime": watched("Console.withTime"),
    // A change that is made only where the function gives one.
    "effect/Ref:updateSome": onRef("Ref.updateSome", 2, (fields, [fn], site) =>
      Effect.map(some("Ref.updateSome", fn, fields, site), (next) => {
        if (next) fields.value = next;
        return Value.undef;
      }),
    ),
    "effect/Ref:updateSomeAndGet": onRef("Ref.updateSomeAndGet", 2, (fields, [fn], site) =>
      Effect.map(some("Ref.updateSomeAndGet", fn, fields, site), (next) => {
        if (next) fields.value = next;
        return held(fields);
      }),
    ),
    "effect/Ref:getAndUpdateSome": onRef("Ref.getAndUpdateSome", 2, (fields, [fn], site) =>
      Effect.map(some("Ref.getAndUpdateSome", fn, fields, site), (next) => {
        const before = held(fields);
        if (next) fields.value = next;
        return before;
      }),
    ),
    "effect/Ref:make": ([value]) =>
      Effect.succeed(lazy(() => Effect.sync(() => cell(value ?? Value.undef)))),
    "effect/Ref:makeUnsafe": ([value]) => Effect.succeed(cell(value ?? Value.undef)),
    "effect/Ref:get": onRef("Ref.get", 1, (fields) => Effect.succeed(held(fields))),
    "effect/Ref:getUnsafe": ([self], site) => {
      const fields = cellOf(self);
      return fields ? Effect.succeed(held(fields)) : wrongArguments(site, "Ref.getUnsafe");
    },
    "effect/Ref:set": onRef("Ref.set", 2, (fields, [value]) =>
      Effect.sync(() => {
        fields.value = value ?? Value.undef;
        return Value.undef;
      }),
    ),
    "effect/Ref:setAndGet": onRef("Ref.setAndGet", 2, (fields, [value]) =>
      Effect.sync(() => {
        fields.value = value ?? Value.undef;
        return held(fields);
      }),
    ),
    "effect/Ref:getAndSet": onRef("Ref.getAndSet", 2, (fields, [value]) =>
      Effect.sync(() => {
        const before = held(fields);
        fields.value = value ?? Value.undef;
        return before;
      }),
    ),
    "effect/Ref:update": onRef("Ref.update", 2, (fields, [fn], site) =>
      Effect.map(changed("Ref.update", fn, fields, site), (after) => {
        fields.value = after;
        return Value.undef;
      }),
    ),
    "effect/Ref:updateAndGet": onRef("Ref.updateAndGet", 2, (fields, [fn], site) =>
      Effect.map(changed("Ref.updateAndGet", fn, fields, site), (after) => {
        fields.value = after;
        return after;
      }),
    ),
    "effect/Ref:getAndUpdate": onRef("Ref.getAndUpdate", 2, (fields, [fn], site) => {
      const before = held(fields);
      return Effect.map(changed("Ref.getAndUpdate", fn, fields, site), (after) => {
        fields.value = after;
        return before;
      });
    }),
    // The function gives what to return and what to keep.
    "effect/Ref:modify": onRef("Ref.modify", 2, (fields, [fn], site) =>
      Effect.flatMap(changed("Ref.modify", fn, fields, site), (made) => {
        const pair = kit.itemsOf(made);
        if (!pair || pair.length !== 2) return wrongArguments(site, "Ref.modify");
        fields.value = pair[1]!;
        return Effect.succeed(pair[0]!);
      }),
    ),
    ...synchronized("SynchronizedRef"),
    ...synchronized("SubscriptionRef"),
    "effect/Ordering:reverse": ([ordering], site) =>
      ordering
        ? host.arithmetic("-", Value.num(0), ordering, site)
        : wrongArguments(site, "Ordering.reverse"),
    "effect/Ordering:match": dual("Ordering.match", 2, ([ordering, cases], site) =>
      ordering
        ? Effect.gen(function* () {
            const less = yield* host.decide(
              yield* host.arithmetic("<", ordering, Value.num(0), site),
              site,
            );
            const key = less
              ? "onLessThan"
              : (yield* host.decide(
                    yield* host.arithmetic(">", ordering, Value.num(0), site),
                    site,
                  ))
                ? "onGreaterThan"
                : "onEqual";
            const handler = handlerOf(cases, key);
            return handler
              ? yield* host.call(handler, [], site)
              : yield* wrongArguments(site, "Ordering.match");
          })
        : wrongArguments(site, "Ordering.match"),
    ),
    "effect/UndefinedOr:map": dual("UndefinedOr.map", 2, ([self, fn], site) =>
      !self || self._tag === "Undef"
        ? Effect.succeed(Value.undef)
        : self._tag === "Opaque" || self._tag === "Applied" || !fn
          ? wrongArguments(site, "UndefinedOr.map")
          : host.call(fn, [self], site),
    ),
    "effect/UndefinedOr:match": dual("UndefinedOr.match", 2, ([self, cases], site) => {
      if (self?._tag === "Opaque" || self?._tag === "Applied")
        return wrongArguments(site, "UndefinedOr.match");
      const defined = self !== undefined && self._tag !== "Undef";
      const handler = handlerOf(cases, defined ? "onDefined" : "onUndefined");
      return handler
        ? host.call(handler, defined ? [self] : [], site)
        : wrongArguments(site, "UndefinedOr.match");
    }),
    "effect/UndefinedOr:getOrThrow": ([self], site) =>
      self?._tag === "Opaque" || self?._tag === "Applied"
        ? wrongArguments(site, "UndefinedOr.getOrThrow")
        : self === undefined || self._tag === "Undef"
          ? Effect.fail(
              new Value.Rejected({
                rejection: Value.libraryError("NoSuchElementError"),
                defect: true,
              }),
            )
          : Effect.succeed(self),
    // A newtype is a name for a type: its value is what it was made from.
    "effect/Newtype:value": ([self]) => Effect.succeed(self ?? Value.undef),
  };

  return { models };
};
