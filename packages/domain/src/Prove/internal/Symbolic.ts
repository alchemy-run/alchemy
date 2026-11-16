import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type { Sort } from "./Smt.ts";
import * as Smt from "./Smt.ts";
import type { Brand, Run, V } from "./Value.ts";
import * as Value from "./Value.ts";

interface Bound {
  readonly bound: number | bigint;
  readonly strict: boolean;
}

/** What a schema's checks say of a value, as far as the prover reads them. */
interface Checks {
  integer: boolean;
  readonly lower: Array<Bound>;
  readonly upper: Array<Bound>;
  /** The whole numbers the value is a multiple of. */
  readonly multiples: Array<number>;
  /** The least and the most a string's or a list's length may be. */
  minLength: number;
  maxLength: number | undefined;
  /** The checks the prover does not read, each as its schema says it. */
  readonly unread: Array<string>;
}

interface Representation {
  readonly id?: string;
  readonly payload?: {
    readonly minimum?: unknown;
    readonly maximum?: unknown;
    readonly exclusiveMinimum?: unknown;
    readonly exclusiveMaximum?: unknown;
    readonly divisor?: unknown;
    readonly minLength?: unknown;
    readonly maxLength?: unknown;
  } | null;
}

const representationOf = (annotations: unknown): Representation | undefined =>
  (annotations as { readonly representation?: Representation } | undefined)?.representation;

const ID = "effect/schema/";

/** A bound as a schema writes it: a number, or a `bigint` as its digits. */
const boundOf = (value: unknown, big: boolean): number | bigint | undefined =>
  typeof value === "number"
    ? value
    : typeof value === "bigint"
      ? value
      : big && typeof value === "string" && /^-?\d+$/.test(value)
        ? BigInt(value)
        : undefined;

/** What a schema's checks say. One the prover does not read is named in `unread`. */
const checksOf = (ast: SchemaAST.AST): Checks => {
  const big = ast._tag === "BigInt";
  const sized = ast._tag === "String" || ast._tag === "Arrays";
  const made: Checks = {
    integer: false,
    lower: [],
    upper: [],
    multiples: [],
    minLength: 0,
    maxLength: undefined,
    unread: [],
  };
  const visit = (checks: ReadonlyArray<SchemaAST.Check<never>> | undefined): void => {
    for (const check of checks ?? []) {
      if (check._tag === "FilterGroup") {
        visit(check.checks as ReadonlyArray<SchemaAST.Check<never>>);
        continue;
      }
      const representation = representationOf(check.annotations);
      const id = representation?.id?.startsWith(ID) ? representation.id.slice(ID.length) : "";
      const payload = representation?.payload ?? {};
      const expected = (check.annotations as { readonly expected?: unknown } | undefined)?.expected;
      const said =
        typeof expected === "string" ? expected : id === "" ? "a check written by hand" : id;
      const miss = () => void made.unread.push(said);
      const minimum = boundOf(payload.minimum, big);
      const maximum = boundOf(payload.maximum, big);
      const above = boundOf(payload.exclusiveMinimum, big);
      const below = boundOf(payload.exclusiveMaximum, big);
      switch (id) {
        case "isInt":
          made.integer = true;
          break;
        // A solver's number is always finite.
        case "isFinite":
          break;
        case "isGreaterThan":
        case "isGreaterThanBigInt":
        case "isGreaterThanOrEqualTo":
        case "isGreaterThanOrEqualToBigInt":
        case "isLessThan":
        case "isLessThanBigInt":
        case "isLessThanOrEqualTo":
        case "isLessThanOrEqualToBigInt":
        case "isBetween":
        case "isBetweenBigInt":
          if (
            (ast._tag !== "Number" && !big) ||
            (minimum ?? maximum ?? above ?? below) === undefined
          ) {
            miss();
            break;
          }
          // `isBetween` gives a bound and says apart whether the bound itself is left out.
          if (minimum !== undefined)
            made.lower.push({ bound: minimum, strict: payload.exclusiveMinimum === true });
          if (above !== undefined) made.lower.push({ bound: above, strict: true });
          if (maximum !== undefined)
            made.upper.push({ bound: maximum, strict: payload.exclusiveMaximum === true });
          if (below !== undefined) made.upper.push({ bound: below, strict: true });
          break;
        case "isMultipleOf":
          if (
            ast._tag === "Number" &&
            typeof payload.divisor === "number" &&
            Number.isInteger(payload.divisor)
          )
            made.multiples.push(payload.divisor);
          else miss();
          break;
        case "isMinLength":
          if (sized && typeof payload.minLength === "number")
            made.minLength = Math.max(made.minLength, payload.minLength);
          else miss();
          break;
        case "isMaxLength":
          if (sized && typeof payload.maxLength === "number")
            made.maxLength = Math.min(made.maxLength ?? Infinity, payload.maxLength);
          else miss();
          break;
        default:
          miss();
      }
    }
  };
  visit(ast.checks as ReadonlyArray<SchemaAST.Check<never>> | undefined);
  return made;
};

const literal = (sort: Sort, n: number | bigint): string =>
  (typeof n === "bigint" ? Smt.big(n) : sort === "Int" ? Smt.int(n) : Smt.real(n)).text;

/** What the checks say of a number or a string the solver holds, as formulas. */
const checkFormulas = (checks: Checks, sort: Sort, text: string): ReadonlyArray<string> =>
  sort === "String"
    ? [
        ...(checks.minLength > 0 ? [`(>= (str.len ${text}) ${checks.minLength})`] : []),
        ...(checks.maxLength === undefined ? [] : [`(<= (str.len ${text}) ${checks.maxLength})`]),
      ]
    : [
        ...checks.lower.map((b) => `(${b.strict ? ">" : ">="} ${text} ${literal(sort, b.bound)})`),
        ...checks.upper.map((b) => `(${b.strict ? "<" : "<="} ${text} ${literal(sort, b.bound)})`),
        ...checks.multiples.map((divisor) =>
          sort === "Int"
            ? `(= (mod ${text} ${Math.abs(divisor)}) 0)`
            : `(and (is_int ${text}) (= (mod (to_int ${text}) ${Math.abs(divisor)}) 0))`,
        ),
      ];

/** Whether a number the code wrote passes the checks. */
const passes = (checks: Checks, value: number | bigint): boolean =>
  (!checks.integer || typeof value === "bigint" || Number.isInteger(value)) &&
  checks.lower.every((b) => (b.strict ? value > b.bound : value >= b.bound)) &&
  checks.upper.every((b) => (b.strict ? value < b.bound : value <= b.bound)) &&
  checks.multiples.every((divisor) => typeof value === "number" && value % divisor === 0);

/** Whether a string the code wrote passes the checks. */
const long = (checks: Checks, length: number): boolean =>
  length >= checks.minLength && (checks.maxLength === undefined || length <= checks.maxLength);

/** Whether a property may be left out of its object. */
const isOptional = (ast: SchemaAST.AST): boolean =>
  (ast as { readonly context?: { readonly isOptional?: boolean } }).context?.isOptional === true;

const isOption = (ast: SchemaAST.AST): ast is SchemaAST.Declaration =>
  ast._tag === "Declaration" && representationOf(ast.annotations)?.id === `${ID}Option`;

/** A check the prover does not read, and the part of a value it is on. */
export interface Unread {
  /** The properties that lead to the part, from the top. */
  readonly path: ReadonlyArray<string>;
  /** The part, as a reader names it: `state.code`. */
  readonly at: string;
  /** The check, as its schema says it. */
  readonly check: string;
}

/** The checks of a schema the prover does not read, each with the part it is on. */
export const unread = (schema: unknown, name: string): ReadonlyArray<Unread> => {
  const found = new Map<string, Unread>();
  const seen = new Set<SchemaAST.AST>();
  const visit = (ast: SchemaAST.AST, path: ReadonlyArray<string>, at: string): void => {
    if (seen.has(ast)) return;
    seen.add(ast);
    for (const check of checksOf(ast).unread) found.set(`${at}: ${check}`, { path, at, check });
    switch (ast._tag) {
      case "Objects":
        for (const property of ast.propertySignatures)
          visit(property.type, [...path, String(property.name)], `${at}.${String(property.name)}`);
        for (const index of ast.indexSignatures) visit(index.type, path, `${at}[key]`);
        return;
      case "Arrays":
        for (const [index, element] of ast.elements.entries())
          visit(element, path, `${at}[${index}]`);
        for (const rest of ast.rest) visit(rest, path, `${at}[n]`);
        return;
      case "Union":
        for (const member of ast.types) visit(member, path, at);
        return;
      case "Declaration":
        for (const parameter of ast.typeParameters) visit(parameter, path, at);
        return;
      default:
        return;
    }
  };
  const ast = typeOf(schema);
  if (ast) visit(ast, [], name);
  return [...found.values()];
};

/** The most items the prover gives a list whose length the schema leaves open. */
export const MAX_ITEMS = 2;

/**
 * The items of a list an input holds, on this path: a length the run chooses,
 * and an input for each item. A list the schema lets grow past `MAX_ITEMS` is
 * tried only up to there, and the run says so.
 */
export const force = (list: V & { readonly _tag: "List" }, run: Run): V => {
  const known = run.lists.get(list.name);
  if (known) return known;
  const ast = list.ast as SchemaAST.Arrays;
  const checks = checksOf(ast);
  const least = Math.max(ast.elements.length, checks.minLength);
  const most = ast.rest.length === 0 ? ast.elements.length : (checks.maxLength ?? Infinity);
  const tried = Math.min(most, least + MAX_ITEMS);
  if (tried < most) run.bounds.set(list.name, tried);
  const length = tried <= least ? least : least + run.choose(tried - least + 1);
  const items: Array<V> = [];
  for (let index = 0; index < length; index++) {
    const item = ast.elements[index] ?? ast.rest[0];
    items.push(
      item ? symbolic(item, `${list.name}.${index}`, run) : { _tag: "Opaque", what: list.name },
    );
  }
  const made: V = { _tag: "Arr", items };
  run.lists.set(list.name, made);
  return made;
};

/** The type side of a schema: what `decide` and `evolve` see. */
export const typeOf = (schema: unknown): SchemaAST.AST | undefined =>
  Schema.isSchema(schema) ? Schema.toType(schema).ast : undefined;

/**
 * Every value a schema allows, as one symbolic value: an input constant per
 * leaf, with the schema's bounds assumed. A union is a choice the run makes.
 */
export const symbolic = (ast: SchemaAST.AST, name: string, run: Run, brand?: Brand): V => {
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral": {
      const term = run.constant(name, "String");
      for (const formula of checkFormulas(checksOf(ast), "String", term.text)) run.assume(formula);
      return { _tag: "Term", term };
    }
    case "Number": {
      const checks = checksOf(ast);
      const term = run.constant(name, checks.integer ? "Int" : "Real");
      for (const formula of checkFormulas(checks, term.sort, term.text)) run.assume(formula);
      return { _tag: "Term", term };
    }
    case "BigInt": {
      const term = run.constant(name, "Int", true);
      for (const formula of checkFormulas(checksOf(ast), "Int", term.text)) run.assume(formula);
      return { _tag: "Term", term, big: true };
    }
    case "Arrays":
      // A list is given its items when the code first looks at it.
      return ast.rest.length <= 1 ? { _tag: "List", name, ast } : { _tag: "Opaque", what: name };
    case "Boolean":
      return { _tag: "Term", term: run.constant(name, "Bool") };
    case "Literal": {
      const value: unknown = ast.literal;
      return typeof value === "string"
        ? Value.str(value)
        : typeof value === "number"
          ? Value.num(value)
          : typeof value === "boolean"
            ? Value.bool(value)
            : typeof value === "bigint"
              ? { _tag: "Big", value }
              : { _tag: "Opaque", what: name };
    }
    case "Null":
      return Value.nil;
    case "Undefined":
    case "Void":
      return Value.undef;
    case "Objects": {
      if (ast.indexSignatures.length > 0) return { _tag: "Opaque", what: name };
      const fields: Record<string, V> = {};
      for (const property of ast.propertySignatures) {
        const key = String(property.name);
        // An optional field is there or it is not: the run takes each in turn.
        if (isOptional(property.type) && run.choose(2) === 1) continue;
        fields[key] = symbolic(property.type, `${name}.${key}`, run);
      }
      return Value.obj(fields, brand);
    }
    case "Union":
      return ast.types.length === 0
        ? { _tag: "Opaque", what: name }
        : symbolic(ast.types[run.choose(ast.types.length)]!, name, run, brand);
    case "Declaration":
      if (isOption(ast) && ast.typeParameters[0])
        return run.choose(2) === 0
          ? Value.none
          : Value.some(symbolic(ast.typeParameters[0], `${name}.value`, run));
      return representationOf(ast.annotations)?.id === "effect/schema/DateTimeUtc"
        ? { _tag: "Time", millis: run.constant(name, "Int") }
        : { _tag: "Opaque", what: name };
    default:
      return { _tag: "Opaque", what: name };
  }
};

/**
 * Assume a value passes a schema's checks, where the prover reads them: a
 * domain class refuses to construct otherwise, so nothing is committed.
 * Returns `false` when the value can never pass.
 */
export const assumeFits = (value: V, ast: SchemaAST.AST, run: Run): boolean => {
  if (ast._tag === "Objects" && value._tag === "Obj") {
    return ast.propertySignatures.every((property) => {
      const field = value.fields[String(property.name)];
      return field === undefined || assumeFits(field, property.type, run);
    });
  }
  if (isOption(ast) && ast.typeParameters[0]) {
    const option = Value.optionOf(value);
    return option?._tag !== "Some" || assumeFits(option.value, ast.typeParameters[0], run);
  }
  if (ast._tag === "Arrays" && value._tag === "Arr") {
    const checks = checksOf(ast);
    return (
      long(checks, value.items.length) &&
      value.items.every((item, index) => {
        const member = ast.elements[index] ?? ast.rest[0];
        return member === undefined || assumeFits(item, member, run);
      })
    );
  }
  if (ast._tag !== "Number" && ast._tag !== "BigInt" && ast._tag !== "String") return true;
  const checks = checksOf(ast);
  if (value._tag === "Num" || value._tag === "Big") return passes(checks, value.value);
  if (value._tag === "Str") return long(checks, value.value.length);
  if (value._tag !== "Term" || value.term.sort === "Bool") return true;
  if (checks.integer && value.term.sort === "Real") run.assume(`(is_int ${value.term.text})`);
  for (const formula of checkFormulas(checks, value.term.sort, value.term.text))
    run.assume(formula);
  return true;
};

const all = (parts: ReadonlyArray<string>): string => {
  if (parts.includes("false")) return "false";
  const open = parts.filter((part) => part !== "true");
  return open.length === 0 ? "true" : open.length === 1 ? open[0]! : `(and ${open.join(" ")})`;
};

const any = (parts: ReadonlyArray<string>): string => {
  if (parts.includes("true")) return "true";
  const open = parts.filter((part) => part !== "false");
  return open.length === 0 ? "false" : open.length === 1 ? open[0]! : `(or ${open.join(" ")})`;
};

/**
 * That a value is one a schema allows, as a formula: what `symbolic` assumes
 * of an input, asked of a value the code made. Where the prover does not read
 * a schema, the formula is `true`.
 */
export const fits = (value: V, ast: SchemaAST.AST, run?: Run): string => {
  if (value._tag === "Opaque" || value._tag === "Host") return "true";
  const sort = value._tag === "Term" ? value.term.sort : undefined;
  switch (ast._tag) {
    case "String": {
      const checks = checksOf(ast);
      if (value._tag === "Str") return String(long(checks, value.value.length));
      return value._tag === "Term" && sort === "String"
        ? all(checkFormulas(checks, "String", value.term.text))
        : "false";
    }
    case "TemplateLiteral":
      return String(value._tag === "Str" || sort === "String");
    case "BigInt": {
      const checks = checksOf(ast);
      if (value._tag === "Big") return String(passes(checks, value.value));
      return value._tag === "Term" && value.big === true
        ? all(checkFormulas(checks, "Int", value.term.text))
        : "false";
    }
    case "Arrays": {
      // A list no code looked at is the one the input held: it fits where it came from.
      if (value._tag === "List" && value.ast === ast) return "true";
      const list = value._tag === "List" && run ? force(value, run) : value;
      if (list._tag !== "Arr") return String(list._tag === "List");
      if (!long(checksOf(ast), list.items.length)) return "false";
      if (list.items.length > ast.elements.length && ast.rest.length === 0) return "false";
      return all(
        list.items.map((item, index) => {
          const member = ast.elements[index] ?? ast.rest[0];
          return member === undefined ? "true" : fits(item, member, run);
        }),
      );
    }
    case "Declaration": {
      if (!isOption(ast) || !ast.typeParameters[0]) return "true";
      const option = Value.optionOf(value);
      if (!option) return "false";
      return option._tag === "None" ? "true" : fits(option.value, ast.typeParameters[0], run);
    }
    case "Boolean":
      return String(value._tag === "Bool" || sort === "Bool");
    case "Null":
      return String(value._tag === "Null");
    case "Undefined":
    case "Void":
      return String(value._tag === "Undef");
    case "Number": {
      const checks = checksOf(ast);
      if (value._tag === "Num") return String(passes(checks, value.value));
      if (value._tag !== "Term" || value.big === true || (sort !== "Int" && sort !== "Real"))
        return "false";
      return all([
        ...(checks.integer && sort === "Real" ? [`(is_int ${value.term.text})`] : []),
        ...checkFormulas(checks, sort, value.term.text),
      ]);
    }
    case "Literal": {
      const literal: unknown = ast.literal;
      if (value._tag === "Str" || value._tag === "Num" || value._tag === "Bool")
        return String(value.value === literal);
      if (value._tag !== "Term") return "false";
      const term =
        typeof literal === "string" && sort === "String"
          ? Smt.string(literal)
          : typeof literal === "boolean" && sort === "Bool"
            ? Smt.bool(literal)
            : typeof literal === "number" && sort === "Int" && Number.isInteger(literal)
              ? Smt.int(literal)
              : typeof literal === "number" && sort === "Real"
                ? Smt.real(literal)
                : undefined;
      return term ? `(= ${value.term.text} ${term.text})` : "false";
    }
    case "Objects": {
      if (ast.indexSignatures.length > 0) return "true";
      if (value._tag !== "Obj") return "false";
      return all(
        ast.propertySignatures.map((property) => {
          const field = value.fields[String(property.name)];
          // A field that is not there fits when it may be left out, or may be `undefined`.
          return field === undefined
            ? isOptional(property.type)
              ? "true"
              : fits(Value.undef, property.type, run)
            : fits(field, property.type, run);
        }),
      );
    }
    case "Union":
      return any(ast.types.map((member) => fits(value, member, run)));
    default:
      return "true";
  }
};

/** A reason a counterexample's input cannot be built as a real value. */
export interface Unbuildable {
  readonly _tag: "Unbuildable";
  readonly reason: string;
}

const isUnbuildable = (u: unknown): u is Unbuildable =>
  typeof u === "object" && u !== null && (u as { _tag?: unknown })._tag === "Unbuildable";

const fallback = (sort: Sort): number | bigint | string | boolean =>
  sort === "String" ? "" : sort === "Bool" ? false : 0;

/**
 * The real value of a symbolic one in a counterexample: each input constant
 * takes the value the solver found.
 */
export const concretize = (
  value: V,
  model: ReadonlyMap<string, number | bigint | string | boolean>,
  /** The items each list was given on the path the values come from. */
  lists?: ReadonlyMap<string, V>,
): { readonly value: unknown } | Unbuildable => {
  const build = (v: V): unknown => {
    switch (v._tag) {
      case "Num":
      case "Big":
      case "Str":
      case "Bool":
        return v.value;
      case "List": {
        const items = lists?.get(v.name);
        if (items) return build(items);
        // No code looked at it: the shortest list its schema allows will do.
        const ast = v.ast as SchemaAST.Arrays;
        return Math.max(ast.elements.length, checksOf(ast).minLength) === 0
          ? []
          : ({
              _tag: "Unbuildable",
              reason: `the prover gave ${v.name} no items, and its schema wants some`,
            } as Unbuildable);
      }
      case "Null":
        return null;
      case "Undef":
        return undefined;
      case "Term": {
        const found = model.get(v.term.text) ?? fallback(v.term.sort);
        return v.big === true && typeof found === "number"
          ? BigInt(Math.trunc(found))
          : v.big !== true && typeof found === "bigint"
            ? Number(found)
            : found;
      }
      case "Time": {
        const millis = model.get(v.millis.text) ?? 0;
        const time = DateTime.make(millis as number);
        return Option.isSome(time)
          ? time.value
          : ({ _tag: "Unbuildable", reason: `${String(millis)} is not a time` } as Unbuildable);
      }
      case "Arr": {
        const items = v.items.map(build);
        return items.find(isUnbuildable) ?? items;
      }
      case "Obj": {
        const option = Value.optionOf(v);
        if (option) {
          if (option._tag === "None") return Option.none();
          const held = build(option.value);
          return isUnbuildable(held) ? held : Option.some(held);
        }
        const out: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(v.fields)) {
          const built = build(field);
          if (isUnbuildable(built)) return built;
          if (built !== undefined) out[key] = built;
        }
        return out;
      }
      case "Opaque":
        return { _tag: "Unbuildable", reason: `the prover cannot build ${v.what}` } as Unbuildable;
      default:
        return {
          _tag: "Unbuildable",
          reason: `the prover cannot build a ${v._tag}`,
        } as Unbuildable;
    }
  };
  const built = build(value);
  return isUnbuildable(built) ? built : { value: built };
};

/** A value as it would be written in TypeScript, on one line. */
export const show = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  if (value === null || typeof value !== "object") return String(value);
  if (DateTime.isDateTime(value)) return DateTime.formatIso(value);
  if (Option.isOption(value))
    return Option.isSome(value) ? `Option.some(${show(value.value)})` : "Option.none()";
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  const entries = Object.entries(value).filter(([, field]) => field !== undefined);
  const name = Object.getPrototypeOf(value)?.constructor?.name as string | undefined;
  const tag = (value as { readonly _tag?: unknown })._tag;
  const named = name !== undefined && name !== "Object" && name !== "";
  const fields = (named ? entries.filter(([key]) => key !== "_tag") : entries)
    .map(([key, field]) => `${key}: ${show(field)}`)
    .join(", ");
  const label = named ? (typeof tag === "string" ? tag : name) : "";
  return fields === "" ? (label === "" ? "{}" : label) : `${label}${label ? " " : ""}{ ${fields} }`;
};
