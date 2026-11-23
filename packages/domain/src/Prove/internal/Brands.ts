import * as BigDecimal from "effect/BigDecimal";
import * as Rational from "effect/Rational";
import type { Term } from "./Smt.ts";
import type { Brand, V } from "./Value.ts";
import * as Value from "./Value.ts";

// The library's own data types, as the prover holds them: each is an object
// with a brand, whose fields are all there is to it. Two of them with the
// same fields are the same value.

const DURATION: Brand = { kind: "Duration", cls: undefined };
const RESULT: Brand = { kind: "Result", cls: undefined };
const DECIMAL: Brand = { kind: "BigDecimal", cls: undefined };
const SET: Brand = { kind: "HashSet", cls: undefined };
const MAP: Brand = { kind: "HashMap", cls: undefined };

const branded = (v: V | undefined, kind: Brand["kind"]): Readonly<Record<string, V>> | undefined =>
  v?._tag === "Obj" && v.brand?.kind === kind ? v.fields : undefined;

/** A duration of so many milliseconds: a whole number the prover knows, or a formula for one. */
export const duration = (millis: V): V => Value.obj({ millis }, DURATION);

/** The milliseconds of a duration: `undefined` when the value is not one. */
export const durationOf = (v: V | undefined): V | undefined => branded(v, "Duration")?.millis;

/** `Result.succeed(value)`. */
export const success = (value: V): V =>
  Value.obj({ _tag: Value.str("Success"), success: value }, RESULT);

/** `Result.fail(error)`. */
export const failure = (error: V): V =>
  Value.obj({ _tag: Value.str("Failure"), failure: error }, RESULT);

/** What a `Result` holds: `undefined` when the value is not one. */
export const resultOf = (
  v: V | undefined,
):
  | { readonly _tag: "Success"; readonly success: V }
  | { readonly _tag: "Failure"; readonly failure: V }
  | undefined => {
  const fields = branded(v, "Result");
  if (!fields) return undefined;
  const tag = fields._tag;
  return tag?._tag === "Str" && tag.value === "Success"
    ? { _tag: "Success", success: fields.success ?? Value.undef }
    : { _tag: "Failure", failure: fields.failure ?? Value.undef };
};

/** A decimal the prover knows, or a real number of the solver's that stands for one. */
export type Decimal = BigDecimal.BigDecimal | Term;

export const isKnown = (decimal: Decimal): decimal is BigDecimal.BigDecimal =>
  BigDecimal.isBigDecimal(decimal);

/** A `BigDecimal`. One the prover knows is kept as its shortest text, so equal decimals read the same. */
export const decimal = (value: Decimal): V =>
  Value.obj(
    {
      value: isKnown(value)
        ? value.pipe(BigDecimal.normalize, BigDecimal.format, Value.str)
        : { _tag: "Term", term: value },
    },
    DECIMAL,
  );

/** What a `BigDecimal` is: `undefined` when the value is not one. */
export const decimalOf = (v: V | undefined): Decimal | undefined => {
  const value = branded(v, "BigDecimal")?.value;
  return value?._tag === "Str"
    ? BigDecimal.fromStringUnsafe(value.value)
    : value?._tag === "Term" && value.term.sort === "Real"
      ? value.term
      : undefined;
};

const digits = (n: bigint): string => `${n < 0n ? -n : n}.0`;

/** A decimal as the solver's real number: exactly, as one whole number over a power of ten. */
export const realOf = (value: Decimal): Term => {
  if (!isKnown(value)) return value;
  const { scale, value: unscaled } = BigDecimal.normalize(value);
  const over = scale > 0 ? 10n ** BigInt(scale) : 1n;
  const whole = scale < 0 ? unscaled * 10n ** BigInt(-scale) : unscaled;
  const size = over === 1n ? digits(whole) : `(/ ${digits(whole)} ${digits(over)})`;
  return { sort: "Real", text: whole < 0n ? `(- ${size})` : size };
};

const RATIONAL: Brand = { kind: "Rational", cls: undefined };

/** A fraction the prover knows, or a real number of the solver's that stands for one. */
export type Fraction = Rational.Rational | Term;

export const isFraction = (fraction: Fraction): fraction is Rational.Rational =>
  Rational.isRational(fraction);

/** A `Rational`. One the prover knows is kept as the library writes it, in lowest terms. */
export const rational = (value: Fraction): V =>
  Value.obj(
    {
      value: isFraction(value)
        ? value.pipe(Rational.format, Value.str)
        : { _tag: "Term", term: value },
    },
    RATIONAL,
  );

/** What a `Rational` is: `undefined` when the value is not one. */
export const rationalOf = (v: V | undefined): Fraction | undefined => {
  const value = branded(v, "Rational")?.value;
  return value?._tag === "Str"
    ? Rational.fromStringUnsafe(value.value)
    : value?._tag === "Term" && value.term.sort === "Real"
      ? value.term
      : undefined;
};

/** A fraction as the solver's real number: one whole number over another. */
export const realOfFraction = (value: Fraction): Term => {
  if (!isFraction(value)) return value;
  const { denominator, numerator } = value;
  const size =
    denominator === 1n ? digits(numerator) : `(/ ${digits(numerator)} ${digits(denominator)})`;
  return { sort: "Real", text: numerator < 0n ? `(- ${size})` : size };
};

/** A hash set of these items: an array, or the list an input holds. */
export const hashSet = (items: V): V => Value.obj({ items }, SET);

/** A hash map of these pairs of a key and its value: an array, or the list an input holds. */
export const hashMap = (entries: V): V => Value.obj({ entries }, MAP);

/** The items of a hash set, as the prover holds them: `undefined` when the value is not one. */
export const setOf = (v: V | undefined): V | undefined => branded(v, "HashSet")?.items;

/** The pairs of a hash map, as the prover holds them: `undefined` when the value is not one. */
export const mapOf = (v: V | undefined): V | undefined => branded(v, "HashMap")?.entries;

/** The brands whose values are read only through their module, never by what they are made of. */
export const SEALED: ReadonlySet<Brand["kind"]> = new Set([
  "Duration",
  "BigDecimal",
  "HashSet",
  "HashMap",
  "Ref",
  "Rational",
  "Redacted",
]);

/** The brands whose values have the library's `.pipe`. */
export const PIPED: ReadonlySet<Brand["kind"]> = new Set([
  "Option",
  "Matcher",
  "Duration",
  "Result",
  "BigDecimal",
  "HashSet",
  "HashMap",
  "Data",
  "Ref",
  "Rational",
  "Redacted",
]);
