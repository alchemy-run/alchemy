import type { GenericId, GenericValidator, VAny, VObject } from "convex/values";
import { v } from "convex/values";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";

/** The annotation that names the Convex validator a schema stands for. */
const VALIDATOR = "@alchemy.run/convex/validator";

/** An Effect Schema has no Convex validator: a tuple, a recursive schema, a class with no encoding. */
export class UnsupportedSchema extends Data.TaggedError("UnsupportedSchema")<{
  readonly message: string;
}> {}

type Leaf = ReadonlyArray<unknown> | ArrayBuffer | GenericId<string>;
type Depth = [unknown, unknown, unknown, unknown];

/** The dotted paths into `T`'s nested objects, which Convex indexes and filters by. */
export type FieldPathsOf<T, D extends ReadonlyArray<unknown> = Depth> = [T] extends [Leaf]
  ? never
  : [T] extends [Record<string, unknown>]
    ? {
        [K in keyof T & string]:
          | K
          | (D extends readonly [unknown, ...infer Rest]
              ? `${K}.${FieldPathsOf<NonNullable<T[K]>, Rest>}`
              : never);
      }[keyof T & string]
    : never;

/**
 * The Convex validator type for a value of type `T`: an object keeps its
 * field paths, so Convex can type indexes over them.
 */
export type ValidatorOf<T> = [T] extends [Leaf]
  ? VAny<T, "required", never>
  : [T] extends [Record<string, unknown>]
    ? VObject<T, Record<string, GenericValidator>, "required", FieldPathsOf<T>>
    : VAny<T, "required", never>;

/**
 * A document ID in `table`, the Effect Schema form of `v.id(table)`.
 *
 * **Example:** A message that points at its author
 * ```typescript
 * const Message = Schema.Struct({
 *   author: Convex.Id("users"),
 *   body: Schema.String,
 * });
 * ```
 */
export const Id = <const Table extends string>(table: Table) =>
  Schema.declare((value): value is GenericId<Table> => typeof value === "string", {
    [VALIDATOR]: () => v.id(table),
    expected: `an ID in the ${table} table`,
  });

/** Binary data, the Effect Schema form of `v.bytes()`. Convex stores it as an `ArrayBuffer`. */
export const Bytes = Schema.declare((value): value is ArrayBuffer => value instanceof ArrayBuffer, {
  [VALIDATOR]: () => v.bytes(),
  expected: "an ArrayBuffer",
});

/** A 64-bit integer, the Effect Schema form of `v.int64()`. Convex stores it as a `bigint`. */
export const Int64 = Schema.BigInt;

const unsupported = (ast: SchemaAST.AST, why: string): never => {
  // A schema the program declares is fixed at module load: there is nothing
  // to recover from, so this is a defect, like an invalid Convex validator.
  throw new UnsupportedSchema({
    message: `Convex can't store this ${ast._tag} schema: ${why}.`,
  });
};

const override = (ast: SchemaAST.AST): GenericValidator | undefined => {
  const make = SchemaAST.resolve(ast)?.[VALIDATOR];
  return typeof make === "function" ? (make as () => GenericValidator)() : undefined;
};

const literal = (value: unknown, ast: SchemaAST.AST) =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  typeof value === "bigint"
    ? v.literal(value)
    : unsupported(ast, "a literal must be a string, number, boolean or bigint");

const union = (members: ReadonlyArray<GenericValidator>): GenericValidator =>
  members.length === 1 ? members[0]! : v.union(...members);

const fromAST = (ast: SchemaAST.AST): GenericValidator => {
  const explicit = override(ast);
  if (explicit !== undefined) return explicit;
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return v.string();
    case "Number":
      return v.float64();
    case "Boolean":
      return v.boolean();
    case "BigInt":
      return v.int64();
    case "Null":
      return v.null();
    case "Unknown":
    case "Any":
      return v.any();
    case "Literal":
      return literal(ast.literal, ast);
    case "Enum":
      return union(ast.enums.map(([, value]) => literal(value, ast)));
    case "Union": {
      const members = ast.types.filter((member) => member._tag !== "Undefined");
      if (members.length === 0) return unsupported(ast, "undefined is not a Convex value");
      return union(members.map(fromAST));
    }
    case "Arrays":
      if (ast.elements.length === 0 && ast.rest.length === 1) return v.array(fromAST(ast.rest[0]!));
      return unsupported(ast, "Convex has arrays, not tuples");
    case "Objects": {
      if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 1) {
        const [signature] = ast.indexSignatures;
        return v.record(v.string(), fromAST(signature!.type));
      }
      if (ast.indexSignatures.length > 0) {
        return unsupported(ast, "an object can't mix fields with an index signature");
      }
      return v.object(
        Object.fromEntries(
          ast.propertySignatures.map((property) => {
            if (typeof property.name !== "string") {
              return unsupported(ast, "field names must be strings");
            }
            const field = fromAST(property.type);
            return [property.name, SchemaAST.isOptional(property.type) ? v.optional(field) : field];
          }),
        ),
      );
    }
    case "Suspend":
      return unsupported(ast, "Convex validators can't be recursive");
    default:
      return unsupported(ast, "it has no Convex value type");
  }
};

/**
 * The Convex validator for an Effect Schema's encoded form.
 *
 * A transform such as `Schema.DateTimeUtcFromMillis` stores its encoded
 * value, here a number. Checks such as `Schema.isMinLength` aren't part of
 * the validator: Alchemy runs them when it encodes or decodes, and Convex
 * checks only the shape.
 *
 * **Example:** Use an Effect Schema in a Convex table
 * ```typescript
 * const Message = Schema.Struct({ body: Schema.String });
 * defineTable(Convex.validator(Message));
 * ```
 */
export const validator = <S extends Schema.Top>(schema: S): ValidatorOf<S["Encoded"]> =>
  fromAST(SchemaAST.toEncoded(schema.ast)) as ValidatorOf<S["Encoded"]>;

/** The fields of an object schema as Convex validators, as Convex's `args` takes them. */
export const fields = (schema: Schema.Top): Record<string, GenericValidator> => {
  const object = validator(schema) as GenericValidator;
  if (object.kind !== "object") {
    throw new UnsupportedSchema({
      message: "Convex function arguments must be an object schema, such as Schema.Struct.",
    });
  }
  return (object as VObject<unknown, Record<string, GenericValidator>>).fields;
};
