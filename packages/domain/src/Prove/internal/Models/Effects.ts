import * as Effect from "effect/Effect";
import * as Brands from "../Brands.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import {
  arr,
  callable,
  done,
  dualBy,
  lazy,
  native,
  onEffect,
  onFailure,
  str,
  tagOf,
  tagsOf,
  wrongArguments,
} from "../Kit.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

/** What `Effect.fromOption` and the like fail with when there is nothing. */
export const noSuchElement: V = Value.obj({ _tag: Value.str("NoSuchElementError") });

const rejected = (rejection: V, defect = false) =>
  Effect.fail(new Value.Rejected(defect ? { rejection, defect } : { rejection }));

const isEffect = (v: V): boolean => v._tag === "Effect";

/**
 * `Effect`: what a handler written as an effect is made of. An effect here
 * succeeds, fails with an error the code can handle, or dies; nothing runs at
 * the same time as anything else, so the options that say how many do are
 * left as they are.
 */
export const make = (kit: Kit): { readonly models: Models; readonly values: Record<string, V> } => {
  const { host, ran } = kit;

  /** What an effect gives, for a value the code may write as an effect or as it is. */
  const settled = (v: V): Eval<V> => (v._tag === "Effect" ? v.run : Effect.succeed(v));

  /** A function of an effect that takes any number of other arguments. */
  const over = (
    name: string,
    run: (self: Eval<V>, args: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
    dualBy(name, isEffect, ([self, ...rest], site) =>
      self?._tag === "Effect"
        ? Effect.succeed(lazy(() => Effect.suspend(() => run(self.run, rest, site))))
        : wrongArguments(site, name),
    );

  /**
   * A function of two effects, written `f(self, that, ...)` or `f(that, ...)`
   * then `self`: it is given both only when its second argument is an effect.
   */
  const pairing =
    (
      name: string,
      run: (self: Eval<V>, that: Eval<V>, rest: ReadonlyArray<V>, site: Site) => Eval<V>,
    ): Model =>
    (args, site) => {
      const [first, second, ...rest] = args;
      if (first?._tag === "Effect" && second?._tag === "Effect")
        return Effect.succeed(
          lazy(() => Effect.suspend(() => run(first.run, second.run, rest, site))),
        );
      if (first?._tag !== "Effect") return wrongArguments(site, name);
      return Effect.succeed(
        native(name, ([self], at) =>
          self?._tag === "Effect"
            ? Effect.succeed(
                lazy(() => Effect.suspend(() => run(self.run, first.run, args.slice(1), at))),
              )
            : wrongArguments(at, name),
        ),
      );
    };

  /** A function that leaves an effect as it is: a span, an annotation. */
  const transparent = (name: string): Model =>
    dualBy(name, isEffect, ([self], site) =>
      self ? Effect.succeed(self) : wrongArguments(site, name),
    );

  /** The items a function goes over, in order. */
  const each = (name: string, items: V | undefined, site: Site): Eval<ReadonlyArray<V>> =>
    items
      ? kit
          .iterate(items, site)
          .pipe(
            Effect.flatMap((found) => (found ? Effect.succeed(found) : wrongArguments(site, name))),
          )
      : wrongArguments(site, name);

  /** A function of a collection and a function, written with the collection first or last. */
  const overItems = (
    name: string,
    run: (items: ReadonlyArray<V>, args: ReadonlyArray<V>, site: Site) => Eval<V>,
  ): Model =>
    dualBy(
      name,
      (v) => !callable(v),
      ([items, ...rest], site) =>
        Effect.succeed(
          lazy(() =>
            Effect.suspend(() =>
              each(name, items, site).pipe(Effect.flatMap((found) => run(found, rest, site))),
            ),
          ),
        ),
    );

  /** Whether the options ask for something other than one after another, which is all the prover reads. */
  const plain = (options: V | undefined, ...allowed: ReadonlyArray<string>): boolean =>
    options === undefined ||
    options._tag === "Undef" ||
    (options._tag === "Obj" &&
      Object.keys(options.fields).every((key) => key === "concurrency" || allowed.includes(key)));

  const flag = (options: V | undefined, key: string): boolean => {
    const value = options?._tag === "Obj" ? options.fields[key] : undefined;
    return value?._tag === "Bool" && value.value;
  };

  /** What an effect did, as a `Result`: its value, or the error it failed with. */
  const attempt = (self: Eval<V>): Eval<V> =>
    onFailure(Effect.map(self, Brands.success), (error) => Effect.succeed(Brands.failure(error)));

  const handlerOf = (cases: V | undefined, key: string): V | undefined =>
    cases?._tag === "Obj" ? cases.fields[key] : undefined;

  const all: Model = ([given, options], site) => {
    if (!given || !plain(options, "discard")) return wrongArguments(site, "Effect.all");
    const discard = flag(options, "discard");
    if (given._tag === "Obj" && !given.brand) {
      const entries = Object.entries(given.fields);
      if (!entries.every(([, value]) => value._tag === "Effect"))
        return wrongArguments(site, "Effect.all");
      return Effect.succeed(
        lazy(() =>
          Effect.gen(function* () {
            const out: Record<string, V> = {};
            for (const [key, value] of entries) out[key] = yield* settled(value);
            return discard ? Value.undef : Value.obj(out);
          }),
        ),
      );
    }
    return Effect.succeed(
      lazy(() =>
        Effect.gen(function* () {
          const items = yield* each("Effect.all", given, site);
          const out: Array<V> = [];
          for (const item of items) {
            if (item._tag !== "Effect") return yield* wrongArguments(site, "Effect.all");
            out.push(yield* item.run);
          }
          return discard ? Value.undef : arr(out);
        }),
      ),
    );
  };

  const models: Models = {
    "effect/Effect:as": onEffect("Effect.as", 1, (self, [value]) =>
      Effect.as(self, value ?? Value.undef),
    ),
    "effect/Effect:asSome": onEffect("Effect.asSome", 0, (self) => Effect.map(self, Value.some)),
    "effect/Effect:succeedSome": ([value]) =>
      Effect.succeed(lazy(() => Effect.succeed(Value.some(value ?? Value.undef)))),
    "effect/Effect:failSync": ([thunk], site) =>
      thunk
        ? Effect.succeed(
            lazy(() =>
              Effect.suspend(() => host.call(thunk, [], site)).pipe(Effect.flatMap(rejected)),
            ),
          )
        : wrongArguments(site, "Effect.failSync"),
    // A defect: the effect stops, and nothing that handles a failure handles it.
    "effect/Effect:die": ([defect]) =>
      Effect.succeed(lazy(() => rejected(defect ?? Value.undef, true))),
    "effect/Effect:suspend": ([thunk], site) =>
      thunk
        ? Effect.succeed(lazy(() => Effect.suspend(() => ran(thunk, [], site))))
        : wrongArguments(site, "Effect.suspend"),
    "effect/Effect:flatten": onEffect("Effect.flatten", 0, (self, _, site) =>
      Effect.flatMap(self, (inner) =>
        inner._tag === "Effect" ? inner.run : wrongArguments(site, "Effect.flatten"),
      ),
    ),
    "effect/Effect:flip": onEffect("Effect.flip", 0, (self) =>
      Effect.flatMap(attempt(self), (result) => {
        const read = Brands.resultOf(result)!;
        return read._tag === "Success" ? rejected(read.success) : Effect.succeed(read.failure);
      }),
    ),
    "effect/Effect:zip": pairing("Effect.zip", (self, that, [options], site) =>
      plain(options, "concurrent")
        ? Effect.flatMap(self, (a) => Effect.map(that, (b) => arr([a, b])))
        : wrongArguments(site, "Effect.zip"),
    ),
    "effect/Effect:zipWith": pairing("Effect.zipWith", (self, that, [f, options], site) =>
      f && plain(options, "concurrent")
        ? Effect.flatMap(self, (a) => Effect.flatMap(that, (b) => host.call(f, [a, b], site)))
        : wrongArguments(site, "Effect.zipWith"),
    ),
    "effect/Effect:all": all,
    "effect/Effect:forEach": overItems("Effect.forEach", (items, [f, options], site) =>
      f && plain(options, "discard")
        ? Effect.gen(function* () {
            const out: Array<V> = [];
            for (const [index, item] of items.entries())
              out.push(yield* ran(f, [item, Value.num(index)], site));
            return flag(options, "discard") ? Value.undef : arr(out);
          })
        : wrongArguments(site, "Effect.forEach"),
    ),
    "effect/Effect:reduce": overItems("Effect.reduce", (items, [zero, f], site) =>
      zero && f
        ? Effect.gen(function* () {
            let total = yield* host.call(zero, [], site);
            for (const [index, item] of items.entries())
              total = yield* ran(f, [total, item, Value.num(index)], site);
            return total;
          })
        : wrongArguments(site, "Effect.reduce"),
    ),
    "effect/Effect:filter": overItems("Effect.filter", (items, [predicate, options], site) =>
      predicate && plain(options)
        ? Effect.gen(function* () {
            const kept: Array<V> = [];
            for (const [index, item] of items.entries())
              if (
                yield* host.decide(
                  yield* kit.either(predicate, [item, Value.num(index)], site),
                  site,
                )
              )
                kept.push(item);
            return arr(kept);
          })
        : wrongArguments(site, "Effect.filter"),
    ),
    "effect/Effect:findFirst": overItems("Effect.findFirst", (items, [predicate], site) =>
      predicate
        ? Effect.gen(function* () {
            for (const [index, item] of items.entries())
              if (yield* host.decide(yield* ran(predicate, [item, Value.num(index)], site), site))
                return Value.some(item);
            return Value.none;
          })
        : wrongArguments(site, "Effect.findFirst"),
    ),
    // Every item is tried: what was given on one side, the failures on the other.
    "effect/Effect:partition": overItems("Effect.partition", (items, [f, options], site) =>
      f && plain(options)
        ? Effect.gen(function* () {
            const failed: Array<V> = [];
            const given: Array<V> = [];
            for (const [index, item] of items.entries())
              yield* onFailure(
                Effect.map(ran(f, [item, Value.num(index)], site), (value) => {
                  given.push(value);
                }),
                (error) => Effect.sync(() => void failed.push(error)),
              );
            return arr([arr(given), arr(failed)]);
          })
        : wrongArguments(site, "Effect.partition"),
    ),
    "effect/Effect:catch": onEffect("Effect.catch", 1, (self, [handler], site) =>
      handler
        ? onFailure(self, (error) => ran(handler, [error], site))
        : wrongArguments(site, "Effect.catch"),
    ),
    "effect/Effect:catchTag": over("Effect.catchTag", (self, [tag, handler, orElse], site) => {
      const tags = tagsOf(tag);
      if (!tags || !handler) return wrongArguments(site, "Effect.catchTag");
      return onFailure(self, (error) => {
        const name = tagOf(error);
        return name !== undefined && tags.includes(name)
          ? ran(handler, [error], site)
          : orElse && orElse._tag !== "Undef"
            ? ran(orElse, [error], site)
            : rejected(error);
      });
    }),
    "effect/Effect:catchTags": over("Effect.catchTags", (self, [cases, orElse], site) =>
      cases?._tag === "Obj"
        ? onFailure(self, (error) => {
            const handler = cases.fields[tagOf(error) ?? ""];
            return handler
              ? ran(handler, [error], site)
              : orElse && orElse._tag !== "Undef"
                ? ran(orElse, [error], site)
                : rejected(error);
          })
        : wrongArguments(site, "Effect.catchTags"),
    ),
    "effect/Effect:catchIf": over("Effect.catchIf", (self, [predicate, handler, orElse], site) =>
      predicate && handler
        ? onFailure(self, (error) =>
            Effect.flatMap(kit.holds(predicate, [error], site), (held) =>
              held
                ? ran(handler, [error], site)
                : orElse && orElse._tag !== "Undef"
                  ? ran(orElse, [error], site)
                  : rejected(error),
            ),
          )
        : wrongArguments(site, "Effect.catchIf"),
    ),
    "effect/Effect:catchNoSuchElement": onEffect("Effect.catchNoSuchElement", 0, (self) =>
      onFailure(Effect.map(self, Value.some), (error) =>
        tagOf(error) === "NoSuchElementError" ? Effect.succeed(Value.none) : rejected(error),
      ),
    ),
    "effect/Effect:mapError": onEffect("Effect.mapError", 1, (self, [f], site) =>
      f
        ? onFailure(self, (error) => Effect.flatMap(host.call(f, [error], site), rejected))
        : wrongArguments(site, "Effect.mapError"),
    ),
    "effect/Effect:mapBoth": onEffect("Effect.mapBoth", 1, (self, [cases], site) => {
      const failed = handlerOf(cases, "onFailure");
      const succeeded = handlerOf(cases, "onSuccess");
      return failed && succeeded
        ? onFailure(
            Effect.flatMap(self, (value) => host.call(succeeded, [value], site)),
            (error) => Effect.flatMap(host.call(failed, [error], site), rejected),
          )
        : wrongArguments(site, "Effect.mapBoth");
    }),
    "effect/Effect:orElseSucceed": onEffect("Effect.orElseSucceed", 1, (self, [f], site) =>
      f
        ? onFailure(self, (error) => host.call(f, [error], site))
        : wrongArguments(site, "Effect.orElseSucceed"),
    ),
    "effect/Effect:tapError": onEffect("Effect.tapError", 1, (self, [f], site) =>
      f
        ? onFailure(self, (error) => Effect.flatMap(ran(f, [error], site), () => rejected(error)))
        : wrongArguments(site, "Effect.tapError"),
    ),
    "effect/Effect:tapErrorTag": onEffect("Effect.tapErrorTag", 2, (self, [tag, f], site) => {
      const tags = tagsOf(tag);
      return tags && f
        ? onFailure(self, (error) =>
            tags.includes(tagOf(error) ?? "")
              ? Effect.flatMap(ran(f, [error], site), () => rejected(error))
              : rejected(error),
          )
        : wrongArguments(site, "Effect.tapErrorTag");
    }),
    // `Effect.ignore(effect)`, or `Effect.ignore(options)` then the effect.
    "effect/Effect:ignore": (args) => {
      const ignoring = (self: V & { readonly _tag: "Effect" }) =>
        lazy(() => onFailure(Effect.as(self.run, Value.undef), () => Effect.succeed(Value.undef)));
      const [first] = args;
      if (first?._tag === "Effect") return Effect.succeed(ignoring(first));
      return Effect.succeed(
        native("Effect.ignore", ([self], at) =>
          self?._tag === "Effect"
            ? Effect.succeed(ignoring(self))
            : wrongArguments(at, "Effect.ignore"),
        ),
      );
    },
    "effect/Effect:match": onEffect("Effect.match", 1, (self, [cases], site) => {
      const failed = handlerOf(cases, "onFailure");
      const succeeded = handlerOf(cases, "onSuccess");
      return failed && succeeded
        ? onFailure(
            Effect.flatMap(self, (value) => host.call(succeeded, [value], site)),
            (error) => host.call(failed, [error], site),
          )
        : wrongArguments(site, "Effect.match");
    }),
    "effect/Effect:matchEffect": onEffect("Effect.matchEffect", 1, (self, [cases], site) => {
      const failed = handlerOf(cases, "onFailure");
      const succeeded = handlerOf(cases, "onSuccess");
      if (!failed || !succeeded) return wrongArguments(site, "Effect.matchEffect");
      // A failure of `onSuccess` is not one `onFailure` handles.
      return Effect.flatMap(attempt(self), (result) => {
        const read = Brands.resultOf(result)!;
        return read._tag === "Success"
          ? ran(succeeded, [read.success], site)
          : ran(failed, [read.failure], site);
      });
    }),
    "effect/Effect:result": onEffect("Effect.result", 0, attempt),
    "effect/Effect:option": onEffect("Effect.option", 0, (self) =>
      onFailure(Effect.map(self, Value.some), () => Effect.succeed(Value.none)),
    ),
    "effect/Effect:isSuccess": onEffect("Effect.isSuccess", 0, (self) =>
      onFailure(Effect.as(self, Value.bool(true)), () => Effect.succeed(Value.bool(false))),
    ),
    "effect/Effect:isFailure": onEffect("Effect.isFailure", 0, (self) =>
      onFailure(Effect.as(self, Value.bool(false)), () => Effect.succeed(Value.bool(true))),
    ),
    "effect/Effect:filterOrFail": over("Effect.filterOrFail", (self, [predicate, orFail], site) =>
      predicate
        ? Effect.flatMap(self, (value) =>
            Effect.flatMap(kit.holds(predicate, [value], site), (held) =>
              held
                ? Effect.succeed(value)
                : orFail && orFail._tag !== "Undef"
                  ? Effect.flatMap(host.call(orFail, [value], site), rejected)
                  : rejected(noSuchElement),
            ),
          )
        : wrongArguments(site, "Effect.filterOrFail"),
    ),
    "effect/Effect:filterOrElse": onEffect(
      "Effect.filterOrElse",
      2,
      (self, [predicate, orElse], site) =>
        predicate && orElse
          ? Effect.flatMap(self, (value) =>
              Effect.flatMap(kit.holds(predicate, [value], site), (held) =>
                held ? Effect.succeed(value) : ran(orElse, [value], site),
              ),
            )
          : wrongArguments(site, "Effect.filterOrElse"),
    ),
    // The effect runs when the condition holds, and gives its value in an `Option`.
    "effect/Effect:when": onEffect("Effect.when", 1, (self, [condition], site) =>
      condition
        ? Effect.flatMap(
            condition._tag === "Effect"
              ? condition.run
              : callable(condition)
                ? kit.either(condition, [], site)
                : Effect.succeed(condition),
            (held) =>
              Effect.flatMap(host.decide(held, site), (runs) =>
                runs ? Effect.map(self, Value.some) : Effect.succeed(Value.none),
              ),
          )
        : wrongArguments(site, "Effect.when"),
    ),
    "effect/Effect:fromOption": ([option], site) => {
      const read = Value.optionOf(option);
      return read
        ? Effect.succeed(
            lazy(() =>
              read._tag === "Some" ? Effect.succeed(read.value) : rejected(noSuchElement),
            ),
          )
        : wrongArguments(site, "Effect.fromOption");
    },
    "effect/Effect:fromNullishOr": ([value]) =>
      Effect.succeed(
        lazy(() =>
          !value || value._tag === "Null" || value._tag === "Undef"
            ? rejected(noSuchElement)
            : Effect.succeed(value),
        ),
      ),
    "effect/Effect:fromResult": ([result], site) => {
      const read = Brands.resultOf(result);
      return read
        ? Effect.succeed(
            lazy(() =>
              read._tag === "Success" ? Effect.succeed(read.success) : rejected(read.failure),
            ),
          )
        : wrongArguments(site, "Effect.fromResult");
    },
    // The finalizer runs after the effect, whether it gave a value or failed.
    "effect/Effect:ensuring": onEffect("Effect.ensuring", 1, (self, [finalizer], site) =>
      finalizer?._tag === "Effect"
        ? Effect.matchEffect(self, {
            onSuccess: (value) => Effect.as(finalizer.run, value),
            onFailure: (stop) =>
              stop._tag === "Rejected"
                ? Effect.flatMap(finalizer.run, () => Effect.fail(stop))
                : Effect.fail(stop),
          })
        : wrongArguments(site, "Effect.ensuring"),
    ),
    "effect/Effect:bind": onEffect("Effect.bind", 2, (self, [name, f], site) => {
      const key = str(name);
      return key !== undefined && f
        ? Effect.flatMap(self, (scope) =>
            scope._tag === "Obj"
              ? Effect.map(ran(f, [scope], site), (value) =>
                  Value.obj({ ...scope.fields, [key]: value }),
                )
              : wrongArguments(site, "Effect.bind"),
          )
        : wrongArguments(site, "Effect.bind");
    }),
    "effect/Effect:let": onEffect("Effect.let", 2, (self, [name, f], site) => {
      const key = str(name);
      return key !== undefined && f
        ? Effect.flatMap(self, (scope) =>
            scope._tag === "Obj"
              ? Effect.map(host.call(f, [scope], site), (value) =>
                  Value.obj({ ...scope.fields, [key]: value }),
                )
              : wrongArguments(site, "Effect.let"),
          )
        : wrongArguments(site, "Effect.let");
    }),
    "effect/Effect:bindTo": onEffect("Effect.bindTo", 1, (self, [name], site) => {
      const key = str(name);
      return key !== undefined
        ? Effect.map(self, (value) => Value.obj({ [key]: value }))
        : wrongArguments(site, "Effect.bindTo");
    }),
    // A request context's value, as `yield*` on its tag gives it.
    "effect/Effect:service": ([tag], site) =>
      tag
        ? Effect.succeed(lazy(() => Effect.suspend(() => host.settle(tag, site))))
        : wrongArguments(site, "Effect.service"),
    // What the effect gives. One that fails throws, which nothing that handles a failure handles.
    "effect/Effect:runSync": ([self], site) =>
      self?._tag === "Effect"
        ? onFailure(self.run, (error) => rejected(error, true))
        : wrongArguments(site, "Effect.runSync"),
    "effect/Effect:withSpan": transparent("Effect.withSpan"),
    "effect/Effect:annotateSpans": transparent("Effect.annotateSpans"),
    "effect/Effect:annotateLogs": transparent("Effect.annotateLogs"),
    "effect/Effect:withLogSpan": transparent("Effect.withLogSpan"),
    "effect/Effect:logTrace": () => Effect.succeed(done),
    "effect/Effect:logFatal": () => Effect.succeed(done),
  };

  const values: Record<string, V> = {
    "effect/Effect:Do": lazy(() => Effect.sync(() => Value.obj({}))),
    "effect/Effect:yieldNow": done,
    "effect/Effect:succeedNone": lazy(() => Effect.succeed(Value.none)),
  };

  return { models, values };
};
