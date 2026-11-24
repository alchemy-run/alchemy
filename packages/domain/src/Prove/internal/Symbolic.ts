import * as BigDecimal from "effect/BigDecimal";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Rational from "effect/Rational";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import * as Brands from "./Brands.ts";
import * as Compare from "./Compare.ts";
import type { Sort, Term } from "./Smt.ts";
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
  /** The bounds of a decimal, each as the comparison it is. */
  readonly decimals: Array<{
    readonly operator: ">" | ">=" | "<" | "<=";
    readonly bound: BigDecimal.BigDecimal;
  }>;
  /** The checks the prover does not read, each as its schema says it. */
  readonly unread: Array<string>;
}

/**
 * What a check of a `BigDecimal` says, which its schema gives only as words:
 * `a value greater than 1.5`.
 */
const DECIMAL_BOUNDS: ReadonlyArray<readonly [RegExp, ReadonlyArray<">" | ">=" | "<" | "<=">]> = [
  [/^a value greater than or equal to (\S+)$/, [">="]],
  [/^a value greater than (\S+)$/, [">"]],
  [/^a value less than or equal to (\S+)$/, ["<="]],
  [/^a value less than (\S+)$/, ["<"]],
  [/^a value between (\S+) and (\S+)$/, [">=", "<="]],
];

const decimalBounds = (expected: string): Checks["decimals"] | undefined => {
  for (const [pattern, operators] of DECIMAL_BOUNDS) {
    const found = pattern.exec(expected);
    if (!found) continue;
    const bounds = operators.map((operator, index) => ({
      operator,
      bound: BigDecimal.fromString(found[index + 1]!),
    }));
    return bounds.every((entry) => Option.isSome(entry.bound))
      ? bounds.map((entry) => ({
          operator: entry.operator,
          bound: Option.getOrThrow(entry.bound),
        }))
      : undefined;
  }
  return undefined;
};

const isDecimal = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Declaration" && representationOf(ast.annotations)?.id === `${ID}BigDecimal`;

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
    decimals: [],
    unread: [],
  };
  const decimal = isDecimal(ast);
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
        default: {
          const bounds =
            decimal && typeof expected === "string" ? decimalBounds(expected) : undefined;
          if (bounds) made.decimals.push(...bounds);
          else miss();
        }
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
        ...checks.decimals.map(
          (entry) => `(${entry.operator} ${text} ${Brands.realOf(entry.bound).text})`,
        ),
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

/** Whether a decimal the code wrote passes the checks. */
const within = (checks: Checks, value: BigDecimal.BigDecimal): boolean =>
  checks.decimals.every((entry) =>
    entry.operator === ">"
      ? BigDecimal.isGreaterThan(value, entry.bound)
      : entry.operator === ">="
        ? BigDecimal.isGreaterThanOrEqualTo(value, entry.bound)
        : entry.operator === "<"
          ? BigDecimal.isLessThan(value, entry.bound)
          : BigDecimal.isLessThanOrEqualTo(value, entry.bound),
  );

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
  if (list.split) {
    const parts = list.split.parts(run);
    run.lists.set(list.name, parts);
    return parts;
  }
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
  // A hash set holds no two equal items, and a hash map no two equal keys.
  if (list.distinct) {
    const forcing = (v: V): V => (v._tag === "List" ? force(v, run) : settle(v, run));
    const keys =
      list.distinct === "items"
        ? items
        : items.map((entry) => {
            const pair = forcing(entry);
            return pair._tag === "Arr" && pair.items[0] ? pair.items[0] : entry;
          });
    for (const [index, key] of keys.entries())
      for (const other of keys.slice(index + 1)) {
        const equal = Compare.equals(key, other, forcing);
        if (equal === true) run.assume("false");
        else if (typeof equal === "string") run.assume(Smt.not(equal));
      }
  }
  return made;
};

let shapes = 0;
const signatures = new WeakMap<object, string>();

/** A schema as text two schemas share only when they allow the same values, by the same checks. */
const signature = (ast: SchemaAST.AST): string => {
  const known = signatures.get(ast);
  if (known !== undefined) return known;
  // A schema that holds itself is known by its place until it is done.
  signatures.set(ast, `#${++shapes}`);
  const checks = ((ast.checks ?? []) as ReadonlyArray<object>).map((check) => ids(check)).join(",");
  const optional = isOptional(ast) ? "?" : "";
  const body = (): string => {
    switch (ast._tag) {
      case "Literal":
        return `${typeof ast.literal}:${String(ast.literal)}`;
      case "Objects":
        return ast.indexSignatures.length > 0
          ? `#${ids(ast)}`
          : `{${ast.propertySignatures
              .map((property) => `${String(property.name)}:${signature(property.type)}`)
              .join(",")}}`;
      case "Arrays":
        return `[${ast.elements.map(signature).join(",")}|${ast.rest.map(signature).join(",")}]`;
      case "Union":
        return `(${ast.types.map(signature).join("|")})`;
      case "Declaration":
        return representationOf(ast.annotations)?.id === undefined
          ? `#${ids(ast)}`
          : `${representationOf(ast.annotations)!.id}<${ast.typeParameters.map(signature).join(",")}>`;
      case "String":
      case "Number":
      case "BigInt":
      case "Boolean":
      case "Null":
      case "Undefined":
      case "Void":
        return "";
      default:
        return `#${ids(ast)}`;
    }
  };
  const made = `${ast._tag}${optional}(${body()})/${checks}`;
  signatures.set(ast, made);
  return made;
};

const numbered = new WeakMap<object, number>();
let count = 0;
/** A number an object keeps: two checks are the same only when they are one object. */
const ids = (object: object): number => {
  const known = numbered.get(object);
  if (known !== undefined) return known;
  numbered.set(object, ++count);
  return count;
};

/** Whether two schemas allow the same values: a field moved from one to the other fits without being read. */
const alike = (a: SchemaAST.AST, b: SchemaAST.AST): boolean =>
  a === b || signature(a) === signature(b);

/** Whether a value of a schema is a choice the run makes: a member of a union, an `Option`, a `Result`. */
const isChoice = (ast: SchemaAST.AST): boolean =>
  (ast._tag === "Union" && ast.types.length > 1) || isOption(ast) || isResult(ast);

const isResult = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Declaration" && representationOf(ast.annotations)?.id === `${ID}Result`;

/**
 * A field of an input: one the run has to choose something for is left
 * until the code reads it. A tag is never left: it says what the object is.
 */
export const field = (ast: SchemaAST.AST, name: string, key: string, run: Run): V =>
  key !== "_tag" && (isOptional(ast) || isChoice(ast))
    ? { _tag: "Pending", name, ast, optional: isOptional(ast) }
    : symbolic(ast, name, run);

/**
 * What a field holds on this path, now that the code reads it: `undefined`
 * for an optional field the run leaves out. The run chooses once, and every
 * copy of the field reads the same.
 */
export const resolve = (pending: V & { readonly _tag: "Pending" }, run: Run): V | undefined => {
  const key = `?${pending.name}`;
  const known = run.lists.get(key);
  if (known) return known === Value.absent ? undefined : known;
  const held = keptOf(pending, run.lists);
  if (held) {
    // Read for a value before, and looked at now: it holds the value, or one of the others.
    const chosen = run.choose(1 + held.others.length);
    run.assume(chosen === 0 ? held.present.text : Smt.not(held.present.text));
    const made = chosen === 0 ? held.whole : held.others[chosen - 1];
    run.lists.set(key, made ?? Value.absent);
    return made;
  }
  const made =
    pending.optional && run.choose(2) === 1
      ? undefined
      : symbolic(pending.ast as SchemaAST.AST, pending.name, run);
  run.lists.set(key, made ?? Value.absent);
  return made;
};

/**
 * A field read only for the value it holds, or a default: whether it holds
 * one is an input, and no path is made for each way.
 */
export interface Kept {
  /** Whether the field holds a value. */
  readonly present: Term;
  /** The value it holds where it holds one: a string, a number or a boolean. */
  readonly value: V;
  /** Whether the field is an `Option`: `value` is then what its `Some` holds. */
  readonly option: boolean;
  /** The field where it holds a value. */
  readonly whole: V;
  /** What the field is where it holds none: `undefined` for a field left out. */
  readonly others: ReadonlyArray<V | undefined>;
}

/** Whether a schema allows only values the solver has a sort for: a string, a number, a boolean. */
const isScalar = (ast: SchemaAST.AST): boolean =>
  ast._tag === "String" ||
  ast._tag === "TemplateLiteral" ||
  ast._tag === "Number" ||
  ast._tag === "Boolean" ||
  (ast._tag === "Literal" && ["string", "number", "boolean"].includes(typeof ast.literal));

/**
 * The one value a field's schema allows beside nothing, and each nothing it
 * allows: `optionalKey(String)`, `NullOr(Number)`, `Option(String)`.
 * `undefined` for any other schema.
 */
const shapeOf = (
  pending: V & { readonly _tag: "Pending" },
):
  | {
      readonly leaf: SchemaAST.AST;
      readonly name: string;
      readonly option: boolean;
      readonly others: ReadonlyArray<V | undefined>;
    }
  | undefined => {
  const ast = pending.ast as SchemaAST.AST;
  const left: ReadonlyArray<V | undefined> = pending.optional ? [undefined] : [];
  if (isOption(ast)) {
    const leaf = ast.typeParameters[0];
    // An `Option` that is left out is not one: only the code says what it does with that.
    return leaf && isScalar(leaf) && !pending.optional
      ? { leaf, name: `${pending.name}.value`, option: true, others: [Value.none] }
      : undefined;
  }
  if (isScalar(ast))
    return left.length > 0
      ? { leaf: ast, name: pending.name, option: false, others: left }
      : undefined;
  if (ast._tag !== "Union") return undefined;
  const leaves = ast.types.filter(isScalar);
  const nothing = ast.types.flatMap((member) =>
    member._tag === "Null"
      ? [Value.nil]
      : member._tag === "Undefined" || member._tag === "Void"
        ? [Value.undef]
        : [],
  );
  const leaf = leaves[0];
  return leaf && leaves.length === 1 && nothing.length === ast.types.length - 1
    ? { leaf, name: pending.name, option: false, others: [...left, ...nothing] }
    : undefined;
};

/** A field read only for a value, as the path that read it kept it. */
export const keptOf = (
  pending: V & { readonly _tag: "Pending" },
  lists: ReadonlyMap<string, V> | undefined,
): Kept | undefined => {
  const known = lists?.get(`??${pending.name}`);
  const shape = known?._tag === "Obj" ? shapeOf(pending) : undefined;
  if (known?._tag !== "Obj" || !shape) return undefined;
  const present = known.fields.present;
  const value = known.fields.value;
  return present?._tag === "Term" && value
    ? {
        present: present.term,
        value,
        option: shape.option,
        whole: shape.option ? Value.some(value) : value,
        others: shape.others,
      }
    : undefined;
};

/**
 * A field the code reads only for a value, or a default: `field ?? other`,
 * `Option.getOrElse(field, other)`. Both ways go to the same code, so the run
 * does not choose: whether the field holds a value is an input, and what the
 * code computes is one value that depends on it. `undefined` where the field
 * was chosen already, or holds more than one kind of value.
 */
export const keep = (pending: V & { readonly _tag: "Pending" }, run: Run): Kept | undefined => {
  if (run.lists.has(`?${pending.name}`)) return undefined;
  const known = keptOf(pending, run.lists);
  if (known) return known;
  const shape = shapeOf(pending);
  if (!shape) return undefined;
  const present = run.constant(`${pending.name} is there`, "Bool");
  const from = run.conditions.length;
  const value = symbolic(shape.leaf, shape.name, run);
  // What the schema says of the value holds only where there is one.
  for (const condition of run.conditions.splice(from))
    run.assume(`(=> ${present.text} ${condition})`);
  run.lists.set(
    `??${pending.name}`,
    Value.obj({ present: { _tag: "Term", term: present }, value }),
  );
  return keptOf(pending, run.lists);
};

/** Whether an object has a field the run has not chosen yet. */
export const isUnsettled = (value: V): value is V & { readonly _tag: "Obj" } => {
  if (value._tag !== "Obj") return false;
  for (const key in value.fields) if (value.fields[key]!._tag === "Pending") return true;
  return false;
};

/**
 * An object with every field chosen: what code that goes over its keys, or
 * compares it whole, has to see. A run settles an object once, so it stays
 * the one object.
 */
export const settle = (value: V, run: Run): V => {
  if (!isUnsettled(value)) return value;
  const known = run.settled.get(value);
  if (known) return known;
  const fields: Record<string, V> = {};
  for (const [key, held] of Object.entries(value.fields)) {
    const made = held._tag === "Pending" ? resolve(held, run) : held;
    if (made !== undefined) fields[key] = made;
  }
  const made = Value.obj(fields, value.brand);
  run.settled.set(value, made);
  return made;
};

/** The schema of a list of `items`, each of the schemas given: what a hash set or a hash map holds. */
const listOf = (elements: ReadonlyArray<SchemaAST.AST>, rest: ReadonlyArray<SchemaAST.AST>) =>
  ({ _tag: "Arrays", elements, rest }) as unknown as SchemaAST.Arrays;

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
        // An optional field is there or it is not: the run takes each in turn, once the code reads it.
        fields[key] = field(property.type, `${name}.${key}`, key, run);
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
      switch (representationOf(ast.annotations)?.id) {
        case "effect/schema/DateTimeUtc":
          return { _tag: "Time", millis: run.constant(name, "Int") };
        // A duration of a whole number of milliseconds: the others are not read.
        case "effect/schema/Duration":
          return Brands.duration({ _tag: "Term", term: run.constant(name, "Int") });
        case "effect/schema/BigDecimal": {
          const term = run.constant(name, "Real");
          for (const formula of checkFormulas(checksOf(ast), "Real", term.text))
            run.assume(formula);
          return Brands.decimal(term);
        }
        case "effect/schema/HashSet":
          return ast.typeParameters[0]
            ? Brands.hashSet({
                _tag: "List",
                name,
                ast: listOf([], [ast.typeParameters[0]]),
                distinct: "items",
              })
            : { _tag: "Opaque", what: name };
        case "effect/schema/HashMap":
          return ast.typeParameters[0] && ast.typeParameters[1]
            ? Brands.hashMap({
                _tag: "List",
                name,
                ast: listOf([], [listOf([ast.typeParameters[0], ast.typeParameters[1]], [])]),
                distinct: "keys",
              })
            : { _tag: "Opaque", what: name };
        case "effect/schema/Result":
          return !ast.typeParameters[0] || !ast.typeParameters[1]
            ? { _tag: "Opaque", what: name }
            : run.choose(2) === 0
              ? Brands.success(symbolic(ast.typeParameters[0], `${name}.success`, run))
              : Brands.failure(symbolic(ast.typeParameters[1], `${name}.failure`, run));
        default:
          return { _tag: "Opaque", what: name };
      }
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
      const held = value.fields[String(property.name)];
      // A field no code looked at is the one the input held: it fits where it came from.
      if (held?._tag === "Pending" && alike(held.ast as SchemaAST.AST, property.type)) return true;
      const field = held?._tag === "Pending" ? resolve(held, run) : held;
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
  if (isDecimal(ast)) {
    const decimal = Brands.decimalOf(value);
    if (!decimal) return true;
    if (Brands.isKnown(decimal)) return within(checksOf(ast), decimal);
    for (const formula of checkFormulas(checksOf(ast), "Real", decimal.text)) run.assume(formula);
    return true;
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
  // What an opaque function returns is taken to be what its place allows: the report says so.
  if (value._tag === "Opaque" || value._tag === "Host" || value._tag === "Applied") return "true";
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
      if (isDecimal(ast)) {
        const decimal = Brands.decimalOf(value);
        if (!decimal) return "false";
        return Brands.isKnown(decimal)
          ? String(within(checksOf(ast), decimal))
          : all(checkFormulas(checksOf(ast), "Real", decimal.text));
      }
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
      const one = (property: SchemaAST.PropertySignature, field: V | undefined): string =>
        // A field that is not there fits when it may be left out, or may be `undefined`.
        field === undefined
          ? isOptional(property.type)
            ? "true"
            : fits(Value.undef, property.type, run)
          : fits(field, property.type, run);
      const held = (property: SchemaAST.PropertySignature) => value.fields[String(property.name)];
      // The fields the run has chosen say first: an object of another shape is ruled out by them,
      // and no field is chosen to find that out.
      const chosen = all(
        ast.propertySignatures
          .filter((property) => held(property)?._tag !== "Pending")
          .map((property) => one(property, held(property))),
      );
      if (chosen === "false") return "false";
      return all([
        chosen,
        ...ast.propertySignatures.flatMap((property) => {
          const field = held(property);
          if (field?._tag !== "Pending") return [];
          // A field no code looked at is the one the input held: it fits where it came from.
          if (!run || alike(field.ast as SchemaAST.AST, property.type)) return ["true"];
          return [one(property, resolve(field, run))];
        }),
      ]);
    }
    case "Union":
      return any(ast.types.map((member) => fits(value, member, run)));
    default:
      return "true";
  }
};

/**
 * Whether `fits` says exactly which values a schema allows: every part of it
 * is one the prover reads, so a value fits when the formula holds and only then.
 */
export const exact = (ast: SchemaAST.AST, seen: Set<SchemaAST.AST> = new Set()): boolean => {
  // A schema that holds itself is not read to its end.
  if (seen.has(ast)) return false;
  seen.add(ast);
  if (checksOf(ast).unread.length > 0) return false;
  switch (ast._tag) {
    case "String":
    case "BigInt":
    case "Boolean":
    case "Null":
    case "Undefined":
    case "Void":
    case "Number":
    case "Unknown":
    case "Any":
      return true;
    case "Literal":
      return ["string", "number", "boolean"].includes(typeof ast.literal);
    case "Arrays":
      // A tuple may leave out an item, which `fits` does not ask about.
      return ast.elements.length === 0 && ast.rest.length === 1 && exact(ast.rest[0]!, seen);
    case "Objects":
      return (
        ast.indexSignatures.length === 0 &&
        ast.propertySignatures.every(
          (property) => typeof property.name === "string" && exact(property.type, seen),
        )
      );
    case "Union":
      return ast.types.every((member) => exact(member, seen));
    case "Declaration": {
      if (isDecimal(ast)) return true;
      const held = ast.typeParameters[0];
      return isOption(ast) && held !== undefined && exact(held, seen);
    }
    default:
      return false;
  }
};

/** The members of a schema of several, and the schema of what an `Option` or a list holds. */
export const partsOf = (
  ast: SchemaAST.AST,
): { readonly _tag: "Option"; readonly value: SchemaAST.AST } | { readonly _tag: "Other" } => {
  const held = ast._tag === "Declaration" && isOption(ast) ? ast.typeParameters[0] : undefined;
  return held ? { _tag: "Option", value: held } : { _tag: "Other" };
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
 * A value a schema allows, where any will do: the code never read this part
 * of an input, so nothing depends on what it is. `undefined` for a schema
 * the prover cannot pick a value of.
 */
const sample = (ast: SchemaAST.AST): V | undefined => {
  switch (ast._tag) {
    case "String": {
      const checks = checksOf(ast);
      return Value.str("a".repeat(checks.minLength));
    }
    case "Number": {
      const checks = checksOf(ast);
      const near = [...checks.lower, ...checks.upper].flatMap((b) =>
        typeof b.bound === "number" ? [b.bound, b.bound + 1, b.bound - 1, b.bound + 0.5] : [],
      );
      const found = [0, 1, -1, ...near, ...checks.multiples].find((n) => passes(checks, n));
      return found === undefined ? undefined : Value.num(found);
    }
    case "BigInt": {
      const checks = checksOf(ast);
      const near = [...checks.lower, ...checks.upper].flatMap((b) =>
        typeof b.bound === "bigint" ? [b.bound, b.bound + 1n, b.bound - 1n] : [],
      );
      const found = [0n, 1n, -1n, ...near].find((n) => passes(checks, n));
      return found === undefined ? undefined : { _tag: "Big", value: found };
    }
    case "Boolean":
      return Value.bool(false);
    case "Null":
      return Value.nil;
    case "Undefined":
    case "Void":
      return Value.undef;
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
              : undefined;
    }
    case "Arrays": {
      const checks = checksOf(ast);
      const items: Array<V> = [];
      for (let index = 0; index < Math.max(ast.elements.length, checks.minLength); index++) {
        const member = ast.elements[index] ?? ast.rest[0];
        const item = member ? sample(member) : undefined;
        if (!item) return undefined;
        items.push(item);
      }
      return { _tag: "Arr", items };
    }
    case "Objects": {
      if (ast.indexSignatures.length > 0) return Value.obj({});
      const fields: Record<string, V> = {};
      for (const property of ast.propertySignatures) {
        if (isOptional(property.type)) continue;
        const made = sample(property.type);
        if (!made) return undefined;
        fields[String(property.name)] = made;
      }
      return Value.obj(fields);
    }
    case "Union":
      for (const member of ast.types) {
        const made = sample(member);
        if (made) return made;
      }
      return undefined;
    case "Declaration":
      return isOption(ast) ? Value.none : undefined;
    default:
      return undefined;
  }
};

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
  /**
   * What a field the code may not have read holds: what the path chose, and
   * for one no code read, the least its schema allows. `undefined` for a
   * field left out.
   */
  const chosen = (pending: V & { readonly _tag: "Pending" }): V | Unbuildable | undefined => {
    const known = lists?.get(`?${pending.name}`);
    if (known) return known === Value.absent ? undefined : known;
    // Read only for a value: the solver says whether it holds one.
    const held = keptOf(pending, lists);
    if (held) return model.get(held.present.text) === true ? held.whole : held.others[0];
    if (pending.optional) return undefined;
    const least = sample(pending.ast as SchemaAST.AST);
    return least ?? { _tag: "Unbuildable", reason: `the prover cannot pick a ${pending.name}` };
  };
  const build = (v: V): unknown => {
    switch (v._tag) {
      case "Num":
      case "Big":
      case "Str":
      case "Bool":
        return v.value;
      case "Pending": {
        const field = chosen(v);
        return field === undefined || isUnbuildable(field) ? field : build(field);
      }
      case "List": {
        const items = lists?.get(v.name);
        if (items) return build(items);
        if (v.split) {
          // The parts no code counted are the ones the real `split` gives.
          const self = build(v.split.self);
          return isUnbuildable(self) ? self : String(self).split(v.split.separator);
        }
        // No code looked at it: the shortest list its schema allows will do.
        const ast = v.ast as SchemaAST.Arrays;
        if (Math.max(ast.elements.length, checksOf(ast).minLength) === 0) return [];
        const least = sample(ast);
        return least
          ? build(least)
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
        if (v.brand?.kind === "Duration") {
          const millis = build(v.fields.millis ?? Value.num(0));
          return isUnbuildable(millis) ? millis : Duration.millis(Number(millis));
        }
        if (v.brand?.kind === "BigDecimal") {
          const held = v.fields.value;
          const fraction =
            held?._tag === "Term" ? Smt.exact.get(model)?.get(held.term.text) : undefined;
          // The number the solver found, exactly, where a decimal can hold it.
          const precise = fraction
            ? BigDecimal.divide(
                BigDecimal.fromBigInt(fraction.numerator),
                BigDecimal.fromBigInt(fraction.denominator),
              )
            : Option.none();
          if (
            fraction &&
            Option.isSome(precise) &&
            BigDecimal.equals(
              BigDecimal.multiply(precise.value, BigDecimal.fromBigInt(fraction.denominator)),
              BigDecimal.fromBigInt(fraction.numerator),
            )
          )
            return precise.value;
          const value = build(held ?? Value.num(0));
          if (isUnbuildable(value)) return value;
          const decimal =
            typeof value === "string"
              ? BigDecimal.fromString(value)
              : BigDecimal.fromNumber(Number(value));
          return Option.isSome(decimal)
            ? decimal.value
            : ({ _tag: "Unbuildable", reason: `${String(value)} is not a decimal` } as Unbuildable);
        }
        if (v.brand?.kind === "Rational") {
          const held = v.fields.value;
          const exact =
            held?._tag === "Term" ? Smt.exact.get(model)?.get(held.term.text) : undefined;
          const precise = exact ? Rational.make(exact.numerator, exact.denominator) : Option.none();
          if (Option.isSome(precise)) return precise.value;
          const value = build(held ?? Value.num(0));
          if (isUnbuildable(value)) return value;
          const fraction =
            typeof value === "string"
              ? Rational.fromString(value)
              : Rational.fromNumber(Number(value));
          return Option.isSome(fraction)
            ? fraction.value
            : ({
                _tag: "Unbuildable",
                reason: `${String(value)} is not a fraction`,
              } as Unbuildable);
        }
        if (v.brand?.kind === "Redacted") {
          const value = build(v.fields.value ?? Value.undef);
          return isUnbuildable(value) ? value : Redacted.make(value);
        }
        const result = Brands.resultOf(v);
        if (result) {
          const held = build(result._tag === "Success" ? result.success : result.failure);
          return isUnbuildable(held)
            ? held
            : result._tag === "Success"
              ? Result.succeed(held)
              : Result.fail(held);
        }
        if (v.brand?.kind === "HashSet") {
          const items = build(Brands.setOf(v)!);
          return isUnbuildable(items)
            ? items
            : HashSet.fromIterable(items as ReadonlyArray<unknown>);
        }
        if (v.brand?.kind === "HashMap") {
          const entries = build(Brands.mapOf(v)!);
          return isUnbuildable(entries)
            ? entries
            : HashMap.fromIterable(entries as ReadonlyArray<readonly [unknown, unknown]>);
        }
        const out: Record<string, unknown> = {};
        for (const [key, held] of Object.entries(v.fields)) {
          const field = held._tag === "Pending" ? chosen(held) : held;
          if (field === undefined) continue;
          const built = isUnbuildable(field) ? field : build(field);
          if (isUnbuildable(built)) return built;
          if (built !== undefined) out[key] = built;
        }
        if (v.brand?.kind === "Data" && typeof v.brand.cls === "function") {
          // An instance of the class, as the code would have made it.
          const cls = v.brand.cls as new (fields: object) => unknown;
          const { _tag: _, ...fields } = out;
          try {
            return new cls(fields);
          } catch (cause) {
            return {
              _tag: "Unbuildable",
              reason: `${cls.name} refuses ${show(fields)}: ${String(cause)}`,
            } as Unbuildable;
          }
        }
        return out;
      }
      case "Opaque":
        return { _tag: "Unbuildable", reason: `the prover cannot build ${v.what}` } as Unbuildable;
      case "Applied": {
        // The real function, on the arguments the solver found.
        const args = v.args.map(build);
        const failed = args.find(isUnbuildable);
        if (failed) return failed;
        try {
          return v.call(...args);
        } catch (cause) {
          return {
            _tag: "Unbuildable",
            reason: `${v.name} threw on ${args.map(show).join(", ")}: ${String(cause)}`,
          } as Unbuildable;
        }
      }
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
  if (Duration.isDuration(value)) return `Duration.millis(${Duration.toMillis(value)})`;
  if (Option.isOption(value))
    return Option.isSome(value) ? `Option.some(${show(value.value)})` : "Option.none()";
  if (Result.isResult(value))
    return Result.isSuccess(value)
      ? `Result.succeed(${show(value.success)})`
      : `Result.fail(${show(value.failure)})`;
  if (BigDecimal.isBigDecimal(value)) return `BigDecimal(${BigDecimal.format(value)})`;
  if (Rational.isRational(value)) return `Rational(${Rational.format(value)})`;
  if (Redacted.isRedacted(value)) return `Redacted(${value.pipe(Redacted.value, show)})`;
  if (HashSet.isHashSet(value)) return `HashSet(${[...value].map(show).sort().join(", ")})`;
  if (HashMap.isHashMap(value))
    return `HashMap(${[...value]
      .map(([key, held]) => `${show(key)} => ${show(held)}`)
      .sort()
      .join(", ")})`;
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
