import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type { Sort } from "./Smt.ts";
import * as Smt from "./Smt.ts";
import type { Brand, Run, V } from "./Value.ts";
import * as Value from "./Value.ts";

interface Bounds {
  integer: boolean;
  readonly lower: Array<{ readonly bound: number; readonly strict: boolean }>;
  readonly upper: Array<{ readonly bound: number; readonly strict: boolean }>;
}

interface Representation {
  readonly id?: string;
  readonly payload?: {
    readonly minimum?: number;
    readonly maximum?: number;
    readonly exclusiveMinimum?: number;
    readonly exclusiveMaximum?: number;
  } | null;
}

const representationOf = (annotations: unknown): Representation | undefined =>
  (annotations as { readonly representation?: Representation } | undefined)?.representation;

/** What a number schema's checks say, as far as the prover reads them. Others are ignored. */
const boundsOf = (ast: SchemaAST.AST): Bounds => {
  const bounds: Bounds = { integer: false, lower: [], upper: [] };
  const visit = (checks: ReadonlyArray<SchemaAST.Check<never>> | undefined): void => {
    for (const check of checks ?? []) {
      if (check._tag === "FilterGroup") {
        visit(check.checks as ReadonlyArray<SchemaAST.Check<never>>);
      }
      const representation = representationOf(check.annotations);
      const payload = representation?.payload ?? {};
      if (representation?.id === "effect/schema/isInt") bounds.integer = true;
      if (typeof payload.minimum === "number")
        bounds.lower.push({ bound: payload.minimum, strict: false });
      if (typeof payload.exclusiveMinimum === "number")
        bounds.lower.push({ bound: payload.exclusiveMinimum, strict: true });
      if (typeof payload.maximum === "number")
        bounds.upper.push({ bound: payload.maximum, strict: false });
      if (typeof payload.exclusiveMaximum === "number")
        bounds.upper.push({ bound: payload.exclusiveMaximum, strict: true });
    }
  };
  visit(ast.checks as ReadonlyArray<SchemaAST.Check<never>> | undefined);
  return bounds;
};

const literal = (sort: Sort, n: number): string => (sort === "Int" ? Smt.int(n) : Smt.real(n)).text;

const boundFormulas = (bounds: Bounds, sort: Sort, text: string): ReadonlyArray<string> => [
  ...bounds.lower.map((b) => `(${b.strict ? ">" : ">="} ${text} ${literal(sort, b.bound)})`),
  ...bounds.upper.map((b) => `(${b.strict ? "<" : "<="} ${text} ${literal(sort, b.bound)})`),
];

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
    case "TemplateLiteral":
      return { _tag: "Term", term: run.constant(name, "String") };
    case "Number": {
      const bounds = boundsOf(ast);
      const term = run.constant(name, bounds.integer ? "Int" : "Real");
      for (const formula of boundFormulas(bounds, term.sort, term.text)) run.assume(formula);
      return { _tag: "Term", term };
    }
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
        fields[key] = symbolic(property.type, `${name}.${key}`, run);
      }
      return Value.obj(fields, brand);
    }
    case "Union":
      return ast.types.length === 0
        ? { _tag: "Opaque", what: name }
        : symbolic(ast.types[run.choose(ast.types.length)]!, name, run, brand);
    case "Declaration":
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
  if (ast._tag !== "Number") return true;
  const bounds = boundsOf(ast);
  if (value._tag === "Num") {
    return (
      (!bounds.integer || Number.isInteger(value.value)) &&
      bounds.lower.every((b) => (b.strict ? value.value > b.bound : value.value >= b.bound)) &&
      bounds.upper.every((b) => (b.strict ? value.value < b.bound : value.value <= b.bound))
    );
  }
  if (value._tag !== "Term" || (value.term.sort !== "Int" && value.term.sort !== "Real"))
    return true;
  if (bounds.integer && value.term.sort === "Real") run.assume(`(is_int ${value.term.text})`);
  for (const formula of boundFormulas(bounds, value.term.sort, value.term.text))
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
export const fits = (value: V, ast: SchemaAST.AST): string => {
  if (value._tag === "Opaque" || value._tag === "Host") return "true";
  const sort = value._tag === "Term" ? value.term.sort : undefined;
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return String(value._tag === "Str" || sort === "String");
    case "Boolean":
      return String(value._tag === "Bool" || sort === "Bool");
    case "Null":
      return String(value._tag === "Null");
    case "Undefined":
    case "Void":
      return String(value._tag === "Undef");
    case "Number": {
      const bounds = boundsOf(ast);
      if (value._tag === "Num")
        return String(
          (!bounds.integer || Number.isInteger(value.value)) &&
            bounds.lower.every((b) =>
              b.strict ? value.value > b.bound : value.value >= b.bound,
            ) &&
            bounds.upper.every((b) => (b.strict ? value.value < b.bound : value.value <= b.bound)),
        );
      if (value._tag !== "Term" || (sort !== "Int" && sort !== "Real")) return "false";
      return all([
        ...(bounds.integer && sort === "Real" ? [`(is_int ${value.term.text})`] : []),
        ...boundFormulas(bounds, sort, value.term.text),
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
          return field === undefined ? "true" : fits(field, property.type);
        }),
      );
    }
    case "Union":
      return any(ast.types.map((member) => fits(value, member)));
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

const fallback = (sort: Sort): number | string | boolean =>
  sort === "String" ? "" : sort === "Bool" ? false : 0;

/**
 * The real value of a symbolic one in a counterexample: each input constant
 * takes the value the solver found.
 */
export const concretize = (
  value: V,
  model: ReadonlyMap<string, number | string | boolean>,
): { readonly value: unknown } | Unbuildable => {
  const build = (v: V): unknown => {
    switch (v._tag) {
      case "Num":
      case "Str":
      case "Bool":
        return v.value;
      case "Null":
        return null;
      case "Undef":
        return undefined;
      case "Term":
        return model.get(v.term.text) ?? fallback(v.term.sort);
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
  if (value === null || typeof value !== "object") return String(value);
  if (DateTime.isDateTime(value)) return DateTime.formatIso(value);
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
