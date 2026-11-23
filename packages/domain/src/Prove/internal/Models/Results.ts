import * as Effect from "effect/Effect";
import * as Brands from "../Brands.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, callable, dual, native, onOption, wrongArguments } from "../Kit.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

type Read = NonNullable<ReturnType<typeof Brands.resultOf>>;

/** What `Option.gen` and `Result.gen` stop with when a `yield*` has nothing to give. */
const SHORT: V = { _tag: "Opaque", what: "a generator that stopped early" };

/**
 * `Result`, and what of `Option` reads like it. Both are plain data: a tag
 * the prover always knows on a path, and the value under it.
 */
export const make = (kit: Kit) => {
  const { host } = kit;

  /** A function of a `Result`. */
  const onResult = (
    name: string,
    arity: number,
    body: (result: Read, rest: ReadonlyArray<V>, site: Site, self: V) => Eval<V>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) => {
      const result = Brands.resultOf(self);
      return result && self ? body(result, rest, site, self) : wrongArguments(site, name);
    });

  const handlerOf = (cases: V | undefined, key: string): V | undefined =>
    cases?._tag === "Obj" ? cases.fields[key] : undefined;

  /** The code throws: the path stops, and nothing that handles a failure handles it. */
  const thrown = (error: V) => Effect.fail(new Value.Rejected({ rejection: error, defect: true }));

  // The generators being run by `Option.gen` and `Result.gen`, innermost last.
  const generators: Array<{ readonly kind: "Option" | "Result"; stopped: V | undefined }> = [];

  /**
   * What `yield*` gives inside `Option.gen` and `Result.gen`: the value an
   * `Option` or a `Result` holds, or the end of the generator.
   */
  const yielded = (value: V): Eval<V> | undefined => {
    const generator = generators[generators.length - 1];
    if (!generator) return undefined;
    const stop = (with_: V) => {
      generator.stopped = with_;
      return Effect.fail(new Value.Rejected({ rejection: SHORT, defect: true }));
    };
    if (generator.kind === "Option") {
      const option = Value.optionOf(value);
      if (!option) return undefined;
      return option._tag === "Some" ? Effect.succeed(option.value) : stop(Value.none);
    }
    const result = Brands.resultOf(value);
    if (!result) return undefined;
    return result._tag === "Success" ? Effect.succeed(result.success) : stop(value);
  };

  /** `Option.gen(function* () { ... })` and `Result.gen`. */
  const gen =
    (kind: "Option" | "Result", wrap: (value: V) => V): Model =>
    (args, site) => {
      const body = args.findLast((arg) => arg._tag === "Fn");
      if (body?._tag !== "Fn") return wrongArguments(site, `${kind}.gen`);
      const generator = { kind, stopped: undefined as V | undefined };
      generators.push(generator);
      return host.call({ ...body, effectful: true }, [], site).pipe(
        Effect.flatMap((made) => (made._tag === "Effect" ? made.run : Effect.succeed(made))),
        Effect.map(wrap),
        Effect.catchTag("Rejected", (rejected) =>
          rejected.rejection === SHORT && generator.stopped
            ? Effect.succeed(generator.stopped)
            : Effect.fail(rejected),
        ),
        Effect.ensuring(
          Effect.sync(() => void generators.splice(generators.indexOf(generator), 1)),
        ),
      );
    };

  /** `Result.all` and `Option.all`: every one of an array's or an object's, or the first that has nothing. */
  const every =
    (name: string, read: (v: V) => { readonly value: V } | undefined, wrap: (v: V) => V): Model =>
    ([given], site) => {
      const collect = (items: ReadonlyArray<V>): ReadonlyArray<V> | V | undefined => {
        const out: Array<V> = [];
        for (const item of items) {
          const held = read(item);
          if (held) out.push(held.value);
          else if (Value.optionOf(item) || Brands.resultOf(item)) return item;
          else return undefined;
        }
        return out;
      };
      const items = kit.itemsOf(given);
      const fields = given?._tag === "Obj" && !given.brand ? given.fields : undefined;
      const found = collect(items ?? (fields ? Object.values(fields) : []));
      if ((!items && !fields) || found === undefined) return wrongArguments(site, name);
      if (!Array.isArray(found)) return Effect.succeed(found as V);
      return Effect.succeed(
        wrap(
          items
            ? arr(found)
            : Value.obj(Object.fromEntries(Object.keys(fields!).map((key, i) => [key, found[i]!]))),
        ),
      );
    };

  const some = (v: V) => {
    const option = Value.optionOf(v);
    return option?._tag === "Some" ? { value: option.value } : undefined;
  };
  const succeeded = (v: V) => {
    const result = Brands.resultOf(v);
    return result?._tag === "Success" ? { value: result.success } : undefined;
  };

  const models: Models = {
    "effect/Result:succeed": ([value]) => Effect.succeed(Brands.success(value ?? Value.undef)),
    "effect/Result:fail": ([error]) => Effect.succeed(Brands.failure(error ?? Value.undef)),
    "effect/Result:succeedSome": ([value]) =>
      Effect.succeed(Brands.success(Value.some(value ?? Value.undef))),
    "effect/Result:isResult": ([value]) =>
      Effect.succeed(Value.bool(Brands.resultOf(value) !== undefined)),
    "effect/Result:isSuccess": onResult("Result.isSuccess", 1, (result) =>
      Effect.succeed(Value.bool(result._tag === "Success")),
    ),
    "effect/Result:isFailure": onResult("Result.isFailure", 1, (result) =>
      Effect.succeed(Value.bool(result._tag === "Failure")),
    ),
    "effect/Result:match": onResult("Result.match", 2, (result, [cases], site) => {
      const handler = handlerOf(cases, result._tag === "Success" ? "onSuccess" : "onFailure");
      return handler
        ? host.call(handler, [result._tag === "Success" ? result.success : result.failure], site)
        : wrongArguments(site, "Result.match");
    }),
    "effect/Result:map": onResult("Result.map", 2, (result, [f], site, self) =>
      result._tag === "Failure"
        ? Effect.succeed(self)
        : f
          ? Effect.map(host.call(f, [result.success], site), Brands.success)
          : wrongArguments(site, "Result.map"),
    ),
    "effect/Result:mapError": onResult("Result.mapError", 2, (result, [f], site, self) =>
      result._tag === "Success"
        ? Effect.succeed(self)
        : f
          ? Effect.map(host.call(f, [result.failure], site), Brands.failure)
          : wrongArguments(site, "Result.mapError"),
    ),
    "effect/Result:mapBoth": onResult("Result.mapBoth", 2, (result, [cases], site) => {
      const handler = handlerOf(cases, result._tag === "Success" ? "onSuccess" : "onFailure");
      if (!handler) return wrongArguments(site, "Result.mapBoth");
      return result._tag === "Success"
        ? Effect.map(host.call(handler, [result.success], site), Brands.success)
        : Effect.map(host.call(handler, [result.failure], site), Brands.failure);
    }),
    "effect/Result:flatMap": onResult("Result.flatMap", 2, (result, [f], site, self) =>
      result._tag === "Failure"
        ? Effect.succeed(self)
        : f
          ? host.call(f, [result.success], site)
          : wrongArguments(site, "Result.flatMap"),
    ),
    // What comes next: a function of the value, or a `Result`; a plain value succeeds.
    "effect/Result:andThen": onResult("Result.andThen", 2, (result, [next], site, self) =>
      result._tag === "Failure"
        ? Effect.succeed(self)
        : !next
          ? wrongArguments(site, "Result.andThen")
          : Effect.map(
              callable(next) ? host.call(next, [result.success], site) : Effect.succeed(next),
              (made) => (Brands.resultOf(made) ? made : Brands.success(made)),
            ),
    ),
    "effect/Result:tap": onResult("Result.tap", 2, (result, [f], site, self) =>
      result._tag === "Failure"
        ? Effect.succeed(self)
        : f
          ? Effect.as(host.call(f, [result.success], site), self)
          : wrongArguments(site, "Result.tap"),
    ),
    "effect/Result:flip": onResult("Result.flip", 1, (result) =>
      Effect.succeed(
        result._tag === "Success" ? Brands.failure(result.success) : Brands.success(result.failure),
      ),
    ),
    "effect/Result:merge": onResult("Result.merge", 1, (result) =>
      Effect.succeed(result._tag === "Success" ? result.success : result.failure),
    ),
    "effect/Result:getOrElse": onResult("Result.getOrElse", 2, (result, [orElse], site) =>
      result._tag === "Success"
        ? Effect.succeed(result.success)
        : orElse
          ? host.call(orElse, [result.failure], site)
          : wrongArguments(site, "Result.getOrElse"),
    ),
    "effect/Result:getOrNull": onResult("Result.getOrNull", 1, (result) =>
      Effect.succeed(result._tag === "Success" ? result.success : Value.nil),
    ),
    "effect/Result:getOrUndefined": onResult("Result.getOrUndefined", 1, (result) =>
      Effect.succeed(result._tag === "Success" ? result.success : Value.undef),
    ),
    "effect/Result:getOrThrow": onResult("Result.getOrThrow", 1, (result) =>
      result._tag === "Success" ? Effect.succeed(result.success) : thrown(result.failure),
    ),
    "effect/Result:getOrThrowWith": onResult("Result.getOrThrowWith", 2, (result, [f], site) =>
      result._tag === "Success"
        ? Effect.succeed(result.success)
        : f
          ? Effect.flatMap(host.call(f, [result.failure], site), thrown)
          : wrongArguments(site, "Result.getOrThrowWith"),
    ),
    "effect/Result:orElse": onResult("Result.orElse", 2, (result, [orElse], site, self) =>
      result._tag === "Success"
        ? Effect.succeed(self)
        : orElse
          ? host.call(orElse, [result.failure], site)
          : wrongArguments(site, "Result.orElse"),
    ),
    "effect/Result:getSuccess": onResult("Result.getSuccess", 1, (result) =>
      Effect.succeed(result._tag === "Success" ? Value.some(result.success) : Value.none),
    ),
    "effect/Result:getFailure": onResult("Result.getFailure", 1, (result) =>
      Effect.succeed(result._tag === "Failure" ? Value.some(result.failure) : Value.none),
    ),
    "effect/Result:fromOption": onOption("Result.fromOption", 2, (option, [onNone], site) =>
      option._tag === "Some"
        ? Effect.succeed(Brands.success(option.value))
        : onNone
          ? Effect.map(host.call(onNone, [], site), Brands.failure)
          : wrongArguments(site, "Result.fromOption"),
    ),
    "effect/Result:fromNullishOr": dual("Result.fromNullishOr", 2, ([value, onNullish], site) =>
      value && value._tag !== "Null" && value._tag !== "Undef"
        ? Effect.succeed(Brands.success(value))
        : onNullish
          ? Effect.map(host.call(onNullish, [value ?? Value.undef], site), Brands.failure)
          : wrongArguments(site, "Result.fromNullishOr"),
    ),
    "effect/Result:filterOrFail": onResult(
      "Result.filterOrFail",
      3,
      (result, [predicate, orFail], site, self) =>
        result._tag === "Failure"
          ? Effect.succeed(self)
          : predicate && orFail
            ? Effect.flatMap(kit.holds(predicate, [result.success], site), (held) =>
                held
                  ? Effect.succeed(self)
                  : Effect.map(host.call(orFail, [result.success], site), Brands.failure),
              )
            : wrongArguments(site, "Result.filterOrFail"),
    ),
    // `Result.liftPredicate(predicate, orFailWith)`: a function of a value, or the value first.
    "effect/Result:liftPredicate": (args, site) => {
      const lifted = (value: V, predicate: V, orFail: V, at: Site) =>
        Effect.flatMap(kit.holds(predicate, [value], at), (held) =>
          held
            ? Effect.succeed(Brands.success(value))
            : Effect.map(host.call(orFail, [value], at), Brands.failure),
        );
      const [a, b, c] = args;
      if (args.length >= 3 && a && b && c) return lifted(a, b, c, site);
      return a && b
        ? Effect.succeed(
            native("Result.liftPredicate", ([value], at) =>
              value ? lifted(value, a, b, at) : wrongArguments(at, "Result.liftPredicate"),
            ),
          )
        : wrongArguments(site, "Result.liftPredicate");
    },
    "effect/Result:all": every("Result.all", succeeded, Brands.success),
    "effect/Result:gen": gen("Result", Brands.success),
    "effect/Option:gen": gen("Option", Value.some),
    "effect/Option:all": every("Option.all", some, Value.some),
    "effect/Option:isOption": ([value]) =>
      Effect.succeed(Value.bool(Value.optionOf(value) !== undefined)),
    "effect/Option:andThen": onOption("Option.andThen", 2, (option, [next], site) =>
      option._tag === "None"
        ? Effect.succeed(Value.none)
        : !next
          ? wrongArguments(site, "Option.andThen")
          : Effect.map(
              callable(next) ? host.call(next, [option.value], site) : Effect.succeed(next),
              (made) => (Value.optionOf(made) ? made : Value.some(made)),
            ),
    ),
    "effect/Option:as": onOption("Option.as", 2, (option, [value]) =>
      Effect.succeed(option._tag === "None" ? Value.none : Value.some(value ?? Value.undef)),
    ),
    "effect/Option:asVoid": onOption("Option.asVoid", 1, (option) =>
      Effect.succeed(option._tag === "None" ? Value.none : Value.some(Value.undef)),
    ),
    "effect/Option:tap": onOption("Option.tap", 2, (option, [f], site, self) =>
      option._tag === "None"
        ? Effect.succeed(Value.none)
        : f
          ? Effect.map(host.call(f, [option.value], site), (made) =>
              Value.optionOf(made)?._tag === "None" ? Value.none : self,
            )
          : wrongArguments(site, "Option.tap"),
    ),
    "effect/Option:flatten": onOption("Option.flatten", 1, (option, _, site) =>
      option._tag === "None"
        ? Effect.succeed(Value.none)
        : Value.optionOf(option.value)
          ? Effect.succeed(option.value)
          : wrongArguments(site, "Option.flatten"),
    ),
    "effect/Option:flatMapNullishOr": onOption("Option.flatMapNullishOr", 2, (option, [f], site) =>
      option._tag === "None"
        ? Effect.succeed(Value.none)
        : f
          ? Effect.map(host.call(f, [option.value], site), (made) =>
              made._tag === "Null" || made._tag === "Undef" ? Value.none : Value.some(made),
            )
          : wrongArguments(site, "Option.flatMapNullishOr"),
    ),
    "effect/Option:contains": onOption("Option.contains", 2, (option, [value], site) =>
      option._tag === "None"
        ? Effect.succeed(Value.bool(false))
        : kit.equals(option.value, value ?? Value.undef, site),
    ),
    "effect/Option:getOrThrow": onOption("Option.getOrThrow", 1, (option) =>
      option._tag === "Some"
        ? Effect.succeed(option.value)
        : thrown(Value.obj({ _tag: Value.str("NoSuchElementError") })),
    ),
    "effect/Option:getOrThrowWith": onOption("Option.getOrThrowWith", 2, (option, [f], site) =>
      option._tag === "Some"
        ? Effect.succeed(option.value)
        : f
          ? Effect.flatMap(host.call(f, [], site), thrown)
          : wrongArguments(site, "Option.getOrThrowWith"),
    ),
    "effect/Option:orElseSome": onOption("Option.orElseSome", 2, (option, [orElse], site, self) =>
      option._tag === "Some"
        ? Effect.succeed(self)
        : orElse
          ? Effect.map(host.call(orElse, [], site), Value.some)
          : wrongArguments(site, "Option.orElseSome"),
    ),
    "effect/Option:toArray": onOption("Option.toArray", 1, (option) =>
      Effect.succeed(arr(option._tag === "Some" ? [option.value] : [])),
    ),
    "effect/Option:zipWith": onOption("Option.zipWith", 3, (option, [that, f], site) => {
      const other = Value.optionOf(that);
      if (!other || !f) return wrongArguments(site, "Option.zipWith");
      return option._tag === "Some" && other._tag === "Some"
        ? Effect.map(host.call(f, [option.value, other.value], site), Value.some)
        : Effect.succeed(Value.none);
    }),
    "effect/Option:zipLeft": onOption("Option.zipLeft", 2, (option, [that], site, self) => {
      const other = Value.optionOf(that);
      return other
        ? Effect.succeed(option._tag === "Some" && other._tag === "Some" ? self : Value.none)
        : wrongArguments(site, "Option.zipLeft");
    }),
    "effect/Option:zipRight": onOption("Option.zipRight", 2, (option, [that], site) => {
      const other = Value.optionOf(that);
      return other && that
        ? Effect.succeed(option._tag === "Some" ? that : Value.none)
        : wrongArguments(site, "Option.zipRight");
    }),
    "effect/Option:product": onOption("Option.product", 2, (option, [that], site) => {
      const other = Value.optionOf(that);
      return other
        ? Effect.succeed(
            option._tag === "Some" && other._tag === "Some"
              ? Value.some(arr([option.value, other.value]))
              : Value.none,
          )
        : wrongArguments(site, "Option.product");
    }),
    "effect/Option:firstSomeOf": ([options], site) => {
      const items = kit.itemsOf(options);
      if (!items || !items.every((item) => Value.optionOf(item)))
        return wrongArguments(site, "Option.firstSomeOf");
      return Effect.succeed(
        items.find((item) => Value.optionOf(item)?._tag === "Some") ?? Value.none,
      );
    },
    // `Option.liftPredicate(predicate)`: a function of a value, or the value first.
    "effect/Option:liftPredicate": (args, site) => {
      const lifted = (value: V, predicate: V, at: Site) =>
        Effect.map(kit.holds(predicate, [value], at), (held) =>
          held ? Value.some(value) : Value.none,
        );
      const [a, b] = args;
      if (args.length >= 2 && a && b) return lifted(a, b, site);
      return a
        ? Effect.succeed(
            native("Option.liftPredicate", ([value], at) =>
              value ? lifted(value, a, at) : wrongArguments(at, "Option.liftPredicate"),
            ),
          )
        : wrongArguments(site, "Option.liftPredicate");
    },
    "effect/Option:getSuccess": ([result], site) => {
      const read = Brands.resultOf(result);
      return read
        ? Effect.succeed(read._tag === "Success" ? Value.some(read.success) : Value.none)
        : wrongArguments(site, "Option.getSuccess");
    },
    "effect/Option:getFailure": ([result], site) => {
      const read = Brands.resultOf(result);
      return read
        ? Effect.succeed(read._tag === "Failure" ? Value.some(read.failure) : Value.none)
        : wrongArguments(site, "Option.getFailure");
    },
  };

  const values: Record<string, V> = {
    "effect/Result:succeedNone": Brands.success(Value.none),
    "effect/Result:failVoid": Brands.failure(Value.undef),
  };

  return { models, values, yielded };
};
