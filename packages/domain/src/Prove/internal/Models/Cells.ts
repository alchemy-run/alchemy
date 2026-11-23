import * as Effect from "effect/Effect";
import type { Kit, Model, Models } from "../Kit.ts";
import { dual, lazy, wrongArguments } from "../Kit.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

const REF: Value.Brand = { kind: "Ref", cls: undefined };

/**
 * `Ref`, `Ordering` and `UndefinedOr`. A `Ref` a handler makes is a cell only
 * it holds: what it reads is what it last wrote, so it is read as a local
 * variable is.
 */
export const make = (kit: Kit) => {
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

  const changed = (name: string, fn: V | undefined, fields: Record<string, V>, site: Site) =>
    fn ? host.call(fn, [held(fields)], site) : wrongArguments(site, name);

  const handlerOf = (cases: V | undefined, key: string): V | undefined =>
    cases?._tag === "Obj" ? cases.fields[key] : undefined;

  const models: Models = {
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
                rejection: Value.obj({ _tag: Value.str("NoSuchElementError") }),
                defect: true,
              }),
            )
          : Effect.succeed(self),
    // A newtype is a name for a type: its value is what it was made from.
    "effect/Newtype:value": ([self]) => Effect.succeed(self ?? Value.undef),
  };

  return { models };
};
