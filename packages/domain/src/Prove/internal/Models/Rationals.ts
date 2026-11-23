import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Rational from "effect/Rational";
import * as Brands from "../Brands.ts";
import type { Fraction } from "../Brands.ts";
import type { Kit, Model, Models } from "../Kit.ts";
import { dual, wrongArguments } from "../Kit.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

type Known = Rational.Rational;

const both = (a: Fraction, b: Fraction): readonly [Known, Known] | undefined =>
  Brands.isFraction(a) && Brands.isFraction(b) ? [a, b] : undefined;

const real = (text: string): Fraction => ({ sort: "Real", text });
const textOf = (fraction: Fraction): string => Brands.realOfFraction(fraction).text;

/** The fraction the library gives, as the prover holds one. */
const from = (made: () => Known): V => Brands.rational(made());

/**
 * `Rational`: one whole number over another, held exactly. The solver's real
 * numbers are those, so every operation is read on any fraction, a division
 * too.
 */
export const make = (kit: Kit) => {
  const { host } = kit;

  const fractionOf = (name: string, v: V | undefined, site: Site): Eval<Fraction> => {
    const fraction = Brands.rationalOf(v);
    return fraction ? Effect.succeed(fraction) : wrongArguments(site, name);
  };

  const combining = (
    name: string,
    fold: (a: Known, b: Known) => Known,
    formula: (a: string, b: string) => string,
  ): Model =>
    dual(name, 2, ([self, that], site) =>
      Effect.gen(function* () {
        const a = yield* fractionOf(name, self, site);
        const b = yield* fractionOf(name, that, site);
        const known = both(a, b);
        return known
          ? from(() => fold(known[0], known[1]))
          : Brands.rational(real(formula(textOf(a), textOf(b))));
      }),
    );

  const comparing = (
    name: string,
    fold: (a: Known, b: Known) => boolean,
    operator: string,
  ): Model =>
    dual(name, 2, ([self, that], site) =>
      Effect.gen(function* () {
        const a = yield* fractionOf(name, self, site);
        const b = yield* fractionOf(name, that, site);
        const known = both(a, b);
        return known
          ? Value.bool(fold(known[0], known[1]))
          : Value.term("Bool", `(${operator} ${textOf(a)} ${textOf(b)})`);
      }),
    );

  const against =
    (name: string, fold: (a: Known) => boolean, test: (text: string) => string): Model =>
    ([self], site) =>
      Effect.map(fractionOf(name, self, site), (a) =>
        Brands.isFraction(a) ? Value.bool(fold(a)) : Value.term("Bool", test(a.text)),
      );

  const changing =
    (name: string, fold: (a: Known) => Known, formula: (text: string) => string): Model =>
    ([self], site) =>
      Effect.map(fractionOf(name, self, site), (a) =>
        Brands.isFraction(a) ? from(() => fold(a)) : Brands.rational(real(formula(a.text))),
      );

  /** A whole number as a fraction: one the code writes, or a formula for one. */
  const whole = (name: string, v: V | undefined, site: Site): Eval<Fraction> =>
    v?._tag === "Big"
      ? Effect.succeed(Rational.fromBigInt(v.value))
      : v?._tag === "Num" && Number.isSafeInteger(v.value)
        ? Effect.succeed(Rational.fromBigInt(BigInt(v.value)))
        : v?._tag === "Term" && v.term.sort === "Int"
          ? Effect.succeed(real(`(to_real ${v.term.text})`))
          : wrongArguments(site, name);

  /** One fraction over another: nothing when the second is zero. */
  const quotient = (name: string, a: Fraction, b: Fraction, site: Site): Eval<V | undefined> =>
    Effect.gen(function* () {
      const zero = Brands.isFraction(b)
        ? Rational.isZero(b)
        : yield* host.decide(Value.term("Bool", `(= ${b.text} 0.0)`), site);
      if (zero) return undefined;
      const known = both(a, b);
      return known
        ? from(() => Rational.divideUnsafe(known[0], known[1]))
        : Brands.rational(real(`(/ ${textOf(a)} ${textOf(b)})`));
    });

  const thrown = (site: Site, name: string): Eval<never> =>
    Effect.fail(Value.notTranslated(site, `${name} divides by zero`));

  const made =
    (name: string): Model =>
    ([numerator, denominator], site) =>
      Effect.gen(function* () {
        const n = yield* whole(name, numerator, site);
        const d = yield* whole(name, denominator, site);
        return (yield* quotient(name, n, d, site)) ?? Value.undef;
      });

  const sum = combining("Rational.sum", Rational.sum, (a, b) => `(+ ${a} ${b})`);
  const multiply = combining("Rational.multiply", Rational.multiply, (a, b) => `(* ${a} ${b})`);
  const min = combining("Rational.min", Rational.min, (a, b) => `(ite (<= ${a} ${b}) ${a} ${b})`);
  const max = combining("Rational.max", Rational.max, (a, b) => `(ite (>= ${a} ${b}) ${a} ${b})`);
  const lessThan = comparing("Rational.isLessThan", Rational.isLessThan, "<");
  const atMost = comparing("Rational.isLessThanOrEqualTo", Rational.isLessThanOrEqualTo, "<=");

  const bounds = (options: V | undefined): readonly [V, V] | undefined => {
    const fields = options?._tag === "Obj" ? options.fields : undefined;
    return fields?.minimum && fields.maximum ? [fields.minimum, fields.maximum] : undefined;
  };

  const all =
    (name: string, combine: Model, zero: bigint): Model =>
    ([collection], site) =>
      collection
        ? Effect.gen(function* () {
            const items = yield* kit.iterate(collection, site);
            if (!items) return yield* wrongArguments(site, name);
            let total = from(() => Rational.fromBigInt(zero));
            for (const item of items) total = yield* combine([total, item], site);
            return total;
          })
        : wrongArguments(site, name);

  const known =
    (name: string, run: (a: Known) => V): Model =>
    ([self], site) =>
      Effect.flatMap(fractionOf(name, self, site), (a) =>
        Brands.isFraction(a)
          ? Effect.succeed(run(a))
          : Effect.fail(
              Value.notTranslated(
                site,
                `calls ${name} on a fraction an input holds, which the prover does not translate`,
              ),
            ),
      );

  const models: Models = {
    "effect/Rational:make": (args, site) =>
      Effect.map(made("Rational.make")(args, site), (fraction) =>
        fraction._tag === "Undef" ? Value.none : Value.some(fraction),
      ),
    "effect/Rational:makeUnsafe": (args, site) =>
      Effect.flatMap(made("Rational.makeUnsafe")(args, site), (fraction) =>
        fraction._tag === "Undef" ? thrown(site, "Rational.makeUnsafe") : Effect.succeed(fraction),
      ),
    "effect/Rational:fromBigInt": ([n], site) =>
      Effect.map(whole("Rational.fromBigInt", n, site), Brands.rational),
    "effect/Rational:fromNumberUnsafe": ([n], site) =>
      Effect.map(whole("Rational.fromNumberUnsafe", n, site), Brands.rational),
    "effect/Rational:fromNumber": ([n], site) =>
      Effect.map(whole("Rational.fromNumber", n, site), (fraction) =>
        Value.some(Brands.rational(fraction)),
      ),
    "effect/Rational:fromStringUnsafe": ([text], site) => {
      const found = text?._tag === "Str" ? Rational.fromString(text.value) : Option.none();
      return Option.isSome(found)
        ? Effect.succeed(from(() => found.value))
        : wrongArguments(site, "Rational.fromStringUnsafe");
    },
    "effect/Rational:fromString": ([text], site) => {
      if (text?._tag !== "Str") return wrongArguments(site, "Rational.fromString");
      const found = Rational.fromString(text.value);
      return Effect.succeed(
        Option.isSome(found) ? Value.some(from(() => found.value)) : Value.none,
      );
    },
    // A decimal is a fraction: the same number, held the other way.
    "effect/Rational:fromBigDecimal": ([decimal], site) => {
      const read = Brands.decimalOf(decimal);
      return read
        ? Effect.succeed(
            Brands.isKnown(read)
              ? from(() => Rational.fromBigDecimal(read))
              : Brands.rational(read),
          )
        : wrongArguments(site, "Rational.fromBigDecimal");
    },
    "effect/Rational:isRational": ([value]) =>
      Effect.succeed(Value.bool(Brands.rationalOf(value) !== undefined)),
    "effect/Rational:sum": sum,
    "effect/Rational:subtract": combining(
      "Rational.subtract",
      Rational.subtract,
      (a, b) => `(- ${a} ${b})`,
    ),
    "effect/Rational:multiply": multiply,
    "effect/Rational:divide": dual("Rational.divide", 2, ([self, that], site) =>
      Effect.gen(function* () {
        const a = yield* fractionOf("Rational.divide", self, site);
        const b = yield* fractionOf("Rational.divide", that, site);
        const made = yield* quotient("Rational.divide", a, b, site);
        return made ? Value.some(made) : Value.none;
      }),
    ),
    "effect/Rational:divideUnsafe": dual("Rational.divideUnsafe", 2, ([self, that], site) =>
      Effect.gen(function* () {
        const a = yield* fractionOf("Rational.divideUnsafe", self, site);
        const b = yield* fractionOf("Rational.divideUnsafe", that, site);
        return (
          (yield* quotient("Rational.divideUnsafe", a, b, site)) ??
          (yield* thrown(site, "Rational.divideUnsafe"))
        );
      }),
    ),
    "effect/Rational:negate": changing("Rational.negate", Rational.negate, (a) => `(- ${a})`),
    "effect/Rational:abs": changing(
      "Rational.abs",
      Rational.abs,
      (a) => `(ite (>= ${a} 0.0) ${a} (- ${a}))`,
    ),
    "effect/Rational:min": min,
    "effect/Rational:max": max,
    "effect/Rational:clamp": dual("Rational.clamp", 2, ([self, options], site) => {
      const ends = bounds(options);
      return self && ends
        ? Effect.flatMap(max([self, ends[0]], site), (raised) => min([raised, ends[1]], site))
        : wrongArguments(site, "Rational.clamp");
    }),
    "effect/Rational:between": dual("Rational.between", 2, ([self, options], site) => {
      const ends = bounds(options);
      return self && ends
        ? Effect.gen(function* () {
            const above = yield* host.truth(yield* atMost([ends[0], self], site), site);
            const below = yield* host.truth(yield* atMost([self, ends[1]], site), site);
            return above === false || below === false
              ? Value.bool(false)
              : above === true
                ? typeof below === "boolean"
                  ? Value.bool(below)
                  : Value.term("Bool", below)
                : below === true
                  ? Value.term("Bool", above)
                  : Value.term("Bool", `(and ${above} ${below})`);
          })
        : wrongArguments(site, "Rational.between");
    }),
    "effect/Rational:equals": comparing("Rational.equals", Rational.equals, "="),
    "effect/Rational:isLessThan": lessThan,
    "effect/Rational:isLessThanOrEqualTo": atMost,
    "effect/Rational:isGreaterThan": comparing(
      "Rational.isGreaterThan",
      Rational.isGreaterThan,
      ">",
    ),
    "effect/Rational:isGreaterThanOrEqualTo": comparing(
      "Rational.isGreaterThanOrEqualTo",
      Rational.isGreaterThanOrEqualTo,
      ">=",
    ),
    "effect/Rational:isZero": against("Rational.isZero", Rational.isZero, (a) => `(= ${a} 0.0)`),
    "effect/Rational:isPositive": against(
      "Rational.isPositive",
      Rational.isPositive,
      (a) => `(> ${a} 0.0)`,
    ),
    "effect/Rational:isNegative": against(
      "Rational.isNegative",
      Rational.isNegative,
      (a) => `(< ${a} 0.0)`,
    ),
    "effect/Rational:isInteger": against(
      "Rational.isInteger",
      Rational.isInteger,
      (a) => `(is_int ${a})`,
    ),
    "effect/Rational:sign": ([self], site) =>
      Effect.gen(function* () {
        const a = yield* fractionOf("Rational.sign", self, site);
        if (Brands.isFraction(a)) return a.pipe(Rational.sign, Value.num);
        if (yield* host.decide(Value.term("Bool", `(< ${a.text} 0.0)`), site)) return Value.num(-1);
        return (yield* host.decide(Value.term("Bool", `(> ${a.text} 0.0)`), site))
          ? Value.num(1)
          : Value.num(0);
      }),
    "effect/Rational:sumAll": all("Rational.sumAll", sum, 0n),
    "effect/Rational:multiplyAll": all("Rational.multiplyAll", multiply, 1n),
    "effect/Rational:format": known("Rational.format", (a) => a.pipe(Rational.format, Value.str)),
    "effect/Rational:toNumberUnsafe": known("Rational.toNumberUnsafe", (a) =>
      a.pipe(Rational.toNumberUnsafe, Value.num),
    ),
  };

  const order = kit.order("Rational.Order", (a, b, site) => lessThan([a, b], site));

  const values: Record<string, V> = { "effect/Rational:Order": order };

  return { models, values };
};
