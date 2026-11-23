import * as Brands from "./Brands.ts";
import type { Term } from "./Smt.ts";
import * as Smt from "./Smt.ts";
import type { V } from "./Value.ts";
import * as Value from "./Value.ts";

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

/** What is known of a condition: whether it holds, the formula for it, or nothing. */
export type Known = boolean | string | undefined;

/** `true`/`false` when known, else the formula for "this value is truthy". */
export const truth = (v: V): Known => {
  switch (v._tag) {
    case "Num":
      return v.value !== 0 && !Number.isNaN(v.value);
    case "Big":
      return v.value !== 0n;
    case "Str":
      return v.value !== "";
    case "Bool":
      return v.value;
    case "Null":
    case "Undef":
      return false;
    case "Term":
      return v.term.sort === "Bool"
        ? v.term.text
        : v.term.sort === "String"
          ? `(not (= ${v.term.text} ""))`
          : `(not (= ${v.term.text} ${v.term.sort === "Int" ? "0" : "0.0"}))`;
    case "Opaque":
      return undefined;
    default:
      return true;
  }
};

export const fromTruth = (t: boolean | string): V =>
  typeof t === "boolean"
    ? Value.bool(t)
    : t === "true" || t === "false"
      ? Value.bool(t === "true")
      : Value.term("Bool", t);

/** A string as a solver term, or `undefined` when the value is not a string. */
export const textual = (v: V): Term | undefined =>
  v._tag === "Str"
    ? Smt.string(v.value)
    : v._tag === "Term" && v.term.sort === "String"
      ? v.term
      : undefined;

const isPrimitive = (v: V): boolean =>
  v._tag === "Num" ||
  v._tag === "Big" ||
  v._tag === "Str" ||
  v._tag === "Bool" ||
  v._tag === "Null" ||
  v._tag === "Undef";

export const isQuotient = (v: V): boolean => v._tag === "Term" && v.quotient !== undefined;

/** `a === b`: known, a formula, or `undefined` when the prover cannot tell. */
export const same = (a: V, b: V): Known => {
  // Two calls of an opaque function are the same value when they are the same call.
  if (a._tag === "Applied" || b._tag === "Applied")
    return a._tag === "Applied" && b._tag === "Applied" && a.key === b.key ? true : undefined;
  if (a._tag === "Opaque" || b._tag === "Opaque" || a._tag === "Time" || b._tag === "Time")
    return a === b ? true : undefined;
  if (isPrimitive(a) && isPrimitive(b))
    return (
      a._tag === b._tag && (a as { value?: unknown }).value === (b as { value?: unknown }).value
    );
  const x = numeric(a);
  const y = numeric(b);
  if (x && y) {
    // A `bigint` is never a `number`, whatever the two count.
    if (Value.isBig(a) !== Value.isBig(b)) return false;
    // JavaScript rounds a division: it is the whole number it looks like only when it is one.
    if ((isQuotient(a) && y.sort !== "Int") || (isQuotient(b) && x.sort !== "Int"))
      return undefined;
    const [l, r] = promote(x, y);
    // The same term on both sides is equal whatever it stands for.
    return l.text === r.text ? true : `(= ${l.text} ${r.text})`;
  }
  const s = textual(a);
  const t = textual(b);
  if (s && t) return `(= ${s.text} ${t.text})`;
  const p =
    a._tag === "Bool"
      ? Smt.bool(a.value)
      : a._tag === "Term" && a.term.sort === "Bool"
        ? a.term
        : undefined;
  const q =
    b._tag === "Bool"
      ? Smt.bool(b.value)
      : b._tag === "Term" && b.term.sort === "Bool"
        ? b.term
        : undefined;
  if (p && q) return `(= ${p.text} ${q.text})`;
  // Different kinds are never equal; objects and functions are equal only to themselves.
  return a === b;
};

/** Every part holds. One that does not settles it, whatever is unknown of the others. */
export const all = (parts: ReadonlyArray<Known>): Known => {
  if (parts.includes(false) || parts.includes("false")) return false;
  if (parts.includes(undefined)) return undefined;
  const open = parts.filter((part): part is string => typeof part === "string" && part !== "true");
  return open.length === 0 ? true : open.length === 1 ? open[0]! : `(and ${open.join(" ")})`;
};

/** Some part holds. One that does settles it, whatever is unknown of the others. */
export const any = (parts: ReadonlyArray<Known>): Known => {
  if (parts.includes(true) || parts.includes("true")) return true;
  if (parts.includes(undefined)) return undefined;
  const open = parts.filter((part): part is string => typeof part === "string" && part !== "false");
  return open.length === 0 ? false : open.length === 1 ? open[0]! : `(or ${open.join(" ")})`;
};

export const negate = (known: Known): Known =>
  known === undefined ? undefined : typeof known === "boolean" ? !known : Smt.not(known);

/**
 * `Equal.equals(a, b)`: the library's equality, which compares objects,
 * arrays and its own data types by what they hold. Known, a formula, or
 * `undefined` when the prover cannot tell.
 */
export const equals = (a: V, b: V, force: (list: V) => V = (list) => list): Known => {
  if (a === b && a._tag !== "Opaque") return true;
  const x = force(a);
  const y = force(b);
  if (x._tag === "Time" || y._tag === "Time")
    return x._tag === "Time" && y._tag === "Time"
      ? x.millis.text === y.millis.text
        ? true
        : `(= ${x.millis.text} ${y.millis.text})`
      : x._tag === "Opaque" || y._tag === "Opaque" || x._tag === "Applied" || y._tag === "Applied"
        ? undefined
        : false;
  if (x._tag === "Arr" || y._tag === "Arr") {
    if (x._tag !== "Arr" || y._tag !== "Arr")
      return x._tag === "Arr" || y._tag === "Arr" ? unlike(x, y) : undefined;
    return x.items.length === y.items.length
      ? all(x.items.map((item, index) => equals(item, y.items[index]!, force)))
      : false;
  }
  if (x._tag === "Obj" || y._tag === "Obj") {
    if (x._tag !== "Obj" || y._tag !== "Obj") return unlike(x, y);
    if (x.brand?.kind !== y.brand?.kind) return false;
    switch (x.brand?.kind) {
      case "BigDecimal": {
        const l = Brands.decimalOf(x);
        const r = Brands.decimalOf(y);
        if (!l || !r) return undefined;
        const left = Brands.realOf(l).text;
        const right = Brands.realOf(r).text;
        return left === right
          ? true
          : Brands.isKnown(l) && Brands.isKnown(r)
            ? false
            : `(= ${left} ${right})`;
      }
      case "HashSet": {
        const l = force(Brands.setOf(x)!);
        const r = force(Brands.setOf(y)!);
        if (l._tag !== "Arr" || r._tag !== "Arr") return undefined;
        // No two items of a set are equal, so two sets of one size are equal when each item of one is in the other.
        return l.items.length === r.items.length
          ? all(l.items.map((item) => any(r.items.map((other) => equals(item, other, force)))))
          : false;
      }
      case "HashMap": {
        const l = force(Brands.mapOf(x)!);
        const r = force(Brands.mapOf(y)!);
        if (l._tag !== "Arr" || r._tag !== "Arr") return undefined;
        return l.items.length === r.items.length
          ? all(l.items.map((entry) => any(r.items.map((other) => equals(entry, other, force)))))
          : false;
      }
      case "Matcher":
      case "Recorded":
        return x === y;
      default: {
        // Two instances of different classes are never equal.
        if (x.brand?.cls !== y.brand?.cls) return false;
        const keys = Object.keys(x.fields);
        return keys.length === Object.keys(y.fields).length &&
          keys.every((key) => Object.hasOwn(y.fields, key))
          ? all(keys.map((key) => equals(x.fields[key]!, y.fields[key]!, force)))
          : false;
      }
    }
  }
  return same(x, y);
};

/** An object or an array next to something else: never equal, unless the prover cannot see the other. */
const unlike = (a: V, b: V): Known =>
  [a, b].some((v) => v._tag === "Opaque" || v._tag === "Applied" || v._tag === "List")
    ? undefined
    : false;
