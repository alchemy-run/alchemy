import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Brands from "../Brands.ts";
import type { Decimal } from "../Brands.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { counted, dual, wrongArguments } from "../Kit.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

const known = (
  a: Decimal,
  b: Decimal,
): readonly [BigDecimal.BigDecimal, BigDecimal.BigDecimal] | undefined =>
  Brands.isKnown(a) && Brands.isKnown(b) ? [a, b] : undefined;

const real = (text: string): Decimal => ({ sort: "Real", text });

/** The decimal the library gives, as the prover holds one. */
const decimalFrom = (made: () => BigDecimal.BigDecimal): V => Brands.decimal(made());

/**
 * `BigDecimal`: a decimal number held exactly, which is what money is counted
 * in. The solver's real numbers are exact too, so a sum, a difference, a
 * product and a comparison are read as they are. A division is not: the
 * library rounds one that does not end.
 */
export const make = (kit: Kit) => {
  const { host } = kit;

  const decimalOf = (name: string, v: V | undefined, site: Site): Eval<Decimal> => {
    const decimal = Brands.decimalOf(v);
    return decimal ? Effect.succeed(decimal) : wrongArguments(site, name);
  };

  /** A function of two decimals that gives a decimal. */
  const combining = (
    name: string,
    fold: (a: BigDecimal.BigDecimal, b: BigDecimal.BigDecimal) => BigDecimal.BigDecimal,
    formula: (a: string, b: string) => string,
  ): Model =>
    dual(name, 2, ([self, that], site) =>
      Effect.gen(function* () {
        const a = yield* decimalOf(name, self, site);
        const b = yield* decimalOf(name, that, site);
        const both = known(a, b);
        return Brands.decimal(
          both
            ? fold(both[0], both[1])
            : real(formula(Brands.realOf(a).text, Brands.realOf(b).text)),
        );
      }),
    );

  /** A test of two decimals. */
  const comparing = (
    name: string,
    fold: (a: BigDecimal.BigDecimal, b: BigDecimal.BigDecimal) => boolean,
    operator: string,
  ): Model =>
    dual(name, 2, ([self, that], site) =>
      Effect.gen(function* () {
        const a = yield* decimalOf(name, self, site);
        const b = yield* decimalOf(name, that, site);
        const both = known(a, b);
        return both
          ? Value.bool(fold(both[0], both[1]))
          : Value.term("Bool", `(${operator} ${Brands.realOf(a).text} ${Brands.realOf(b).text})`);
      }),
    );

  /** A test of one decimal against zero. */
  const against =
    (name: string, fold: (a: BigDecimal.BigDecimal) => boolean, operator: string): Model =>
    ([self], site) =>
      Effect.map(decimalOf(name, self, site), (a) =>
        Brands.isKnown(a) ? Value.bool(fold(a)) : Value.term("Bool", `(${operator} ${a.text} 0.0)`),
      );

  /** A decimal the code changes in a way the prover computes only on one it knows. */
  const computed = (
    name: string,
    run: (a: BigDecimal.BigDecimal, rest: ReadonlyArray<V>) => V | undefined,
  ): Model =>
    dual(name, 1, ([self, ...rest], site) =>
      Effect.flatMap(decimalOf(name, self, site), (a) => {
        const made = Brands.isKnown(a) ? run(a, rest) : undefined;
        return made
          ? Effect.succeed(made)
          : Effect.fail(
              Value.notTranslated(
                site,
                `calls ${name} on a decimal an input holds, which the prover does not translate`,
              ),
            );
      }),
    );

  const bounds = (options: V | undefined): readonly [V, V] | undefined => {
    const fields = options?._tag === "Obj" ? options.fields : undefined;
    return fields?.minimum && fields.maximum ? [fields.minimum, fields.maximum] : undefined;
  };

  const min = combining(
    "BigDecimal.min",
    BigDecimal.min,
    (a, b) => `(ite (<= ${a} ${b}) ${a} ${b})`,
  );
  const max = combining(
    "BigDecimal.max",
    BigDecimal.max,
    (a, b) => `(ite (>= ${a} ${b}) ${a} ${b})`,
  );
  const sum = combining("BigDecimal.sum", BigDecimal.sum, (a, b) => `(+ ${a} ${b})`);
  const multiply = combining("BigDecimal.multiply", BigDecimal.multiply, (a, b) => `(* ${a} ${b})`);
  const lessThanOrEqualTo = comparing(
    "BigDecimal.isLessThanOrEqualTo",
    BigDecimal.isLessThanOrEqualTo,
    "<=",
  );
  const lessThan = comparing("BigDecimal.isLessThan", BigDecimal.isLessThan, "<");

  /** `floor`, `ceil` and `truncate`, at so many places after the point. */
  const rounding = (
    name: string,
    fold: (a: BigDecimal.BigDecimal, scale: number) => BigDecimal.BigDecimal,
    whole: (text: string) => string,
  ): Model =>
    dual(name, 1, ([self, scale], site) =>
      Effect.gen(function* () {
        const a = yield* decimalOf(name, self, site);
        const places =
          scale === undefined || scale._tag === "Undef" ? 0 : yield* counted(name, scale, site);
        if (Brands.isKnown(a)) return Brands.decimal(fold(a, places));
        if (places < 0) return yield* wrongArguments(site, name);
        const unit = `${10n ** BigInt(places)}.0`;
        const scaled = places === 0 ? a.text : `(* ${a.text} ${unit})`;
        const rounded = `(to_real ${whole(scaled)})`;
        return Brands.decimal(real(places === 0 ? rounded : `(/ ${rounded} ${unit})`));
      }),
    );

  const floored = (text: string) => `(to_int ${text})`;
  const ceiled = (text: string) => `(- (to_int (- ${text})))`;

  /** A division of two decimals the prover knows: one an input holds is rounded by the library. */
  const dividing = (
    name: string,
    wrap: (found: Option.Option<BigDecimal.BigDecimal>) => V | undefined,
  ): Model =>
    dual(name, 2, ([self, that], site) =>
      Effect.gen(function* () {
        const a = yield* decimalOf(name, self, site);
        const b = yield* decimalOf(name, that, site);
        const both = known(a, b);
        const made = both ? wrap(BigDecimal.divide(both[0], both[1])) : undefined;
        return (
          made ??
          (yield* Value.notTranslated(
            site,
            both
              ? `${name} divides a decimal by zero`
              : `${name} divides decimals an input holds, which BigDecimal rounds and the prover does not`,
          ))
        );
      }),
    );

  const some = (found: Option.Option<BigDecimal.BigDecimal>): V =>
    Option.isSome(found) ? found.value.pipe(Brands.decimal, Value.some) : Value.none;

  const models: Models = {
    "effect/BigDecimal:make": ([value, scale], site) =>
      value?._tag === "Big" && scale?._tag === "Num"
        ? Effect.succeed(decimalFrom(() => BigDecimal.make(value.value, scale.value)))
        : wrongArguments(site, "BigDecimal.make"),
    "effect/BigDecimal:fromBigInt": ([value], site) =>
      value?._tag === "Big"
        ? Effect.succeed(decimalFrom(() => BigDecimal.fromBigInt(value.value)))
        : value?._tag === "Term" && value.big === true
          ? Effect.succeed(Brands.decimal(real(`(to_real ${value.term.text})`)))
          : wrongArguments(site, "BigDecimal.fromBigInt"),
    "effect/BigDecimal:fromNumberUnsafe": ([value], site) => fromNumber(value, site),
    "effect/BigDecimal:fromNumber": ([value], site) =>
      Effect.map(fromNumber(value, site), Value.some),
    "effect/BigDecimal:fromStringUnsafe": ([text], site) => {
      const found = text?._tag === "Str" ? BigDecimal.fromString(text.value) : Option.none();
      return Option.isSome(found)
        ? Effect.succeed(decimalFrom(() => found.value))
        : wrongArguments(site, "BigDecimal.fromStringUnsafe");
    },
    "effect/BigDecimal:fromString": ([text], site) =>
      text?._tag === "Str"
        ? Effect.succeed(BigDecimal.fromString(text.value).pipe(some))
        : wrongArguments(site, "BigDecimal.fromString"),
    "effect/BigDecimal:isBigDecimal": ([value]) =>
      Effect.succeed(Value.bool(Brands.decimalOf(value) !== undefined)),
    "effect/BigDecimal:normalize": ([self], site) =>
      Effect.map(decimalOf("BigDecimal.normalize", self, site), Brands.decimal),
    "effect/BigDecimal:sum": sum,
    "effect/BigDecimal:subtract": combining(
      "BigDecimal.subtract",
      BigDecimal.subtract,
      (a, b) => `(- ${a} ${b})`,
    ),
    "effect/BigDecimal:multiply": multiply,
    "effect/BigDecimal:divide": dividing("BigDecimal.divide", some),
    "effect/BigDecimal:divideUnsafe": dividing("BigDecimal.divideUnsafe", (found) =>
      Option.isSome(found) ? Brands.decimal(found.value) : undefined,
    ),
    "effect/BigDecimal:min": min,
    "effect/BigDecimal:max": max,
    "effect/BigDecimal:negate": ([self], site) =>
      Effect.map(decimalOf("BigDecimal.negate", self, site), (a) =>
        Brands.decimal(Brands.isKnown(a) ? BigDecimal.negate(a) : real(`(- ${a.text})`)),
      ),
    "effect/BigDecimal:abs": ([self], site) =>
      Effect.map(decimalOf("BigDecimal.abs", self, site), (a) =>
        Brands.decimal(
          Brands.isKnown(a)
            ? BigDecimal.abs(a)
            : real(`(ite (>= ${a.text} 0.0) ${a.text} (- ${a.text}))`),
        ),
      ),
    "effect/BigDecimal:equals": comparing("BigDecimal.equals", BigDecimal.equals, "="),
    "effect/BigDecimal:isLessThan": lessThan,
    "effect/BigDecimal:isLessThanOrEqualTo": lessThanOrEqualTo,
    "effect/BigDecimal:isGreaterThan": comparing(
      "BigDecimal.isGreaterThan",
      BigDecimal.isGreaterThan,
      ">",
    ),
    "effect/BigDecimal:isGreaterThanOrEqualTo": comparing(
      "BigDecimal.isGreaterThanOrEqualTo",
      BigDecimal.isGreaterThanOrEqualTo,
      ">=",
    ),
    "effect/BigDecimal:isZero": against("BigDecimal.isZero", BigDecimal.isZero, "="),
    "effect/BigDecimal:isPositive": against("BigDecimal.isPositive", BigDecimal.isPositive, ">"),
    "effect/BigDecimal:isNegative": against("BigDecimal.isNegative", BigDecimal.isNegative, "<"),
    "effect/BigDecimal:isInteger": ([self], site) =>
      Effect.map(decimalOf("BigDecimal.isInteger", self, site), (a) =>
        Brands.isKnown(a)
          ? a.pipe(BigDecimal.isInteger, Value.bool)
          : Value.term("Bool", `(is_int ${a.text})`),
      ),
    "effect/BigDecimal:sign": ([self], site) =>
      Effect.gen(function* () {
        const a = yield* decimalOf("BigDecimal.sign", self, site);
        if (Brands.isKnown(a)) return a.pipe(BigDecimal.sign, Value.num);
        if (yield* host.decide(Value.term("Bool", `(< ${a.text} 0.0)`), site)) return Value.num(-1);
        return (yield* host.decide(Value.term("Bool", `(> ${a.text} 0.0)`), site))
          ? Value.num(1)
          : Value.num(0);
      }),
    "effect/BigDecimal:between": dual("BigDecimal.between", 2, ([self, options], site) => {
      const ends = bounds(options);
      return self && ends
        ? Effect.gen(function* () {
            const above = yield* lessThanOrEqualTo([ends[0], self], site);
            const below = yield* lessThanOrEqualTo([self, ends[1]], site);
            const a = yield* host.truth(above, site);
            const b = yield* host.truth(below, site);
            return a === false || b === false
              ? Value.bool(false)
              : a === true
                ? typeof b === "boolean"
                  ? Value.bool(b)
                  : Value.term("Bool", b)
                : b === true
                  ? Value.term("Bool", a)
                  : Value.term("Bool", `(and ${a} ${b})`);
          })
        : wrongArguments(site, "BigDecimal.between");
    }),
    "effect/BigDecimal:clamp": dual("BigDecimal.clamp", 2, ([self, options], site) => {
      const ends = bounds(options);
      return self && ends
        ? Effect.flatMap(max([self, ends[0]], site), (raised) => min([raised, ends[1]], site))
        : wrongArguments(site, "BigDecimal.clamp");
    }),
    "effect/BigDecimal:sumAll": ([collection], site) => all(collection, sum, "0", site),
    "effect/BigDecimal:multiplyAll": ([collection], site) => all(collection, multiply, "1", site),
    "effect/BigDecimal:floor": rounding("BigDecimal.floor", BigDecimal.floor, floored),
    "effect/BigDecimal:ceil": rounding("BigDecimal.ceil", BigDecimal.ceil, ceiled),
    "effect/BigDecimal:truncate": rounding(
      "BigDecimal.truncate",
      BigDecimal.truncate,
      (text) => `(ite (>= ${text} 0.0) ${floored(text)} ${ceiled(text)})`,
    ),
    "effect/BigDecimal:format": computed("BigDecimal.format", (a) =>
      a.pipe(BigDecimal.format, Value.str),
    ),
    "effect/BigDecimal:toNumberUnsafe": computed("BigDecimal.toNumberUnsafe", (a) =>
      a.pipe(BigDecimal.toNumberUnsafe, Value.num),
    ),
    "effect/BigDecimal:scale": computed("BigDecimal.scale", (a, [scale]) =>
      scale?._tag === "Num" ? Brands.decimal(BigDecimal.scale(a, scale.value)) : undefined,
    ),
  };

  function fromNumber(value: V | undefined, site: Site): Eval<V> {
    if (value?._tag === "Num" && Number.isFinite(value.value))
      return Effect.succeed(decimalFrom(() => BigDecimal.fromNumberUnsafe(value.value)));
    if (value?._tag === "Term" && value.big !== true && !value.quotient) {
      if (value.term.sort === "Int")
        return Effect.succeed(Brands.decimal(real(`(to_real ${value.term.text})`)));
      if (value.term.sort === "Real") return Effect.succeed(Brands.decimal(value.term));
    }
    return wrongArguments(site, "BigDecimal.fromNumber");
  }

  function all(collection: V | undefined, combine: Model, zero: string, site: Site): Eval<V> {
    return collection
      ? Effect.gen(function* () {
          const items = yield* kit.iterate(collection, site);
          if (!items) return yield* wrongArguments(site, "BigDecimal.sumAll");
          let total = Brands.decimal(BigDecimal.fromStringUnsafe(zero));
          for (const item of items) total = yield* combine([total, item], site);
          return total;
        })
      : wrongArguments(site, "BigDecimal.sumAll");
  }

  const order = kit.order("BigDecimal.Order", (a, b, site) => lessThan([a, b], site));

  const values: Record<string, V> = { "effect/BigDecimal:Order": order };

  return { models, values };
};
