/**
 * What a table is, independent of the store that holds it: the columns a
 * table's `Row` flattens to, the identity that makes writes idempotent, and
 * a fingerprint that says whether two specs describe the same table.
 *
 * A spec is derived, never written: `Export.Table` walks the row Schema
 * once. Specs are Schemas themselves, so they travel to stores and writers
 * in other processes, and come back, unchanged.
 *
 * @module
 */
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import * as AST from "effect/SchemaAST";
import {
  MetadataWithoutValue,
  type Reason,
  UnprotectedSensitive,
  UnsupportedType,
} from "./DefinitionError.ts";

declare module "effect/Schema" {
  namespace Annotations {
    interface Annotations {
      /** Exports omit or encrypt this field, as the table's `sensitive` policy says. */
      readonly sensitive?: boolean | undefined;
      /** How an export's metadata column is computed. Set by `Export.Metadata`. */
      readonly exportMetadata?: MetadataValue | undefined;
    }
  }
}

// ---------------------------------------------------------------- shapes

/** A column's type as every store understands it. Each store maps it to its own. */
export type Logical =
  | { readonly _tag: "String" }
  | { readonly _tag: "Enum"; readonly values: ReadonlyArray<string> }
  | { readonly _tag: "Int" }
  | { readonly _tag: "Float" }
  | { readonly _tag: "Decimal" }
  | { readonly _tag: "Bool" }
  | { readonly _tag: "Timestamp" }
  | { readonly _tag: "Date" }
  | { readonly _tag: "Bytes" }
  | { readonly _tag: "Json" }
  | { readonly _tag: "Array"; readonly of: Logical };

export const Logical: Schema.Codec<Logical> = Schema.Union([
  Schema.TaggedStruct("String", {}),
  Schema.TaggedStruct("Enum", { values: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Int", {}),
  Schema.TaggedStruct("Float", {}),
  Schema.TaggedStruct("Decimal", {}),
  Schema.TaggedStruct("Bool", {}),
  Schema.TaggedStruct("Timestamp", {}),
  Schema.TaggedStruct("Date", {}),
  Schema.TaggedStruct("Bytes", {}),
  Schema.TaggedStruct("Json", {}),
  Schema.TaggedStruct("Array", { of: Schema.suspend((): Schema.Codec<Logical> => Logical) }),
]);

/** One column: a field of the row, flattened to a dotted path. */
export const Column = Schema.Struct({
  path: Schema.String,
  type: Logical,
  nullable: Schema.Boolean,
  sensitive: Schema.Boolean,
});
export type Column = typeof Column.Type;

/**
 * How a metadata column's value is computed. Plain data, so every store
 * computes it the same way; `Metadata.evaluate` is its meaning.
 *
 * A rebuild (a new generation, filled from history) keeps the original
 * write's values: a `Run` value is carried from the generation being
 * replaced, matched by identity; `Elapsed` and `Copy` are recomputed from
 * the row and the carried values. A `Run` value the replaced generation
 * never recorded takes the rebuild's.
 */
export const MetadataValue = Schema.Union([
  /** A value of the run, the same for all its rows. */
  Schema.TaggedStruct("Run", { field: Schema.Literal("ingestedAt") }),
  /** Whole milliseconds from one timestamp to another, each a row path or a metadata column. */
  Schema.TaggedStruct("Elapsed", { from: Schema.String, to: Schema.String }),
  /** A copy of one row value, by path. */
  Schema.TaggedStruct("Copy", { path: Schema.String }),
]);
export type MetadataValue = typeof MetadataValue.Type;

/** One metadata column: its name (a top-level field of the read row), its type, and how it is computed. */
export const MetadataColumn = Schema.Struct({
  path: Schema.String,
  type: Logical,
  value: MetadataValue,
});
export type MetadataColumn = typeof MetadataColumn.Type;

/** One event class of a table, for its typed per-event view. */
export const EventSpec = Schema.Struct({
  tag: Schema.String,
  columns: Schema.Array(Column),
});
export type EventSpec = typeof EventSpec.Type;

/** A table, independent of its store. */
export const TableSpec = Schema.Struct({
  /** The declaration's name, e.g. `Facts`. */
  table: Schema.String,
  /** The physical base name, e.g. `facts`; generation n is `<name>_v<n>`. */
  name: Schema.String,
  generation: Schema.Int,
  columns: Schema.Array(Column),
  /** Columns the store computes beside each row; `Run` values first, then the rest in order. */
  metadata: Schema.Array(MetadataColumn),
  /** The columns that identify one row: the key and route it was handled for, and the event's place in its stream. */
  identity: Schema.Tuple([
    Schema.Literal("key"),
    Schema.Literal("route"),
    Schema.Literal("envelope.stream"),
    Schema.Literal("envelope.seq"),
  ]),
  events: Schema.Array(EventSpec),
  /** What happens to sensitive event fields; changing it changes what is stored. */
  sensitive: Schema.optionalKey(Schema.Literals(["omit", "encrypt"])),
  /** What the table means, canonically: two specs with equal fingerprints describe the same table. */
  fingerprint: Schema.String,
});
export type TableSpec = typeof TableSpec.Type;

/** The physical name of a spec's generation. */
export const generationName = (spec: TableSpec): string => `${spec.name}_v${spec.generation}`;

/**
 * A column's physical name in every SQL store and engine: its dotted path
 * with `_` for `.` (`envelope.at` is `envelope_at`). The event union stays
 * one JSON column, `event`; metadata keeps its own name.
 */
export const columnName = (path: string): string => path.replaceAll(".", "_");

// ---------------------------------------------------------------- the walk

/** What walking a Schema yields: columns, and the fields that cannot be columns. */
interface Walked {
  readonly columns: ReadonlyArray<Column>;
  readonly problems: ReadonlyArray<UnsupportedType>;
}

const column = (path: string, type: Logical, nullable: boolean, sensitive: boolean): Walked => ({
  columns: [{ path, type, nullable, sensitive }],
  problems: [],
});
const concat = (walks: ReadonlyArray<Walked>): Walked => ({
  columns: walks.flatMap((w) => w.columns),
  problems: walks.flatMap((w) => w.problems),
});

/** The representation id Effect gives its built-in declarations and checks, e.g. `effect/schema/DateTimeUtc`. */
const representationOf = (
  annotations: Schema.Annotations.Annotations | undefined,
): string | undefined => {
  const representation = annotations?.["representation"];
  return typeof representation === "object" &&
    representation !== null &&
    "id" in representation &&
    typeof representation.id === "string"
    ? representation.id
    : undefined;
};

const isInt = (ast: AST.AST): boolean =>
  (ast.checks ?? []).some((check) => representationOf(check.annotations) === "effect/schema/isInt");

const declarations: Readonly<Record<string, Logical>> = {
  "effect/schema/DateTimeUtc": { _tag: "Timestamp" },
  "effect/schema/Date": { _tag: "Date" },
  "effect/schema/BigDecimal": { _tag: "Decimal" },
  "effect/schema/Uint8Array": { _tag: "Bytes" },
};

/** A leaf's type: a scalar or a recognised declaration. */
const leafOf = (ast: AST.AST): Logical | undefined => {
  switch (ast._tag) {
    case "String":
    case "TemplateLiteral":
      return { _tag: "String" };
    case "Number":
      return isInt(ast) ? { _tag: "Int" } : { _tag: "Float" };
    case "BigInt":
      return { _tag: "Decimal" };
    case "Boolean":
      return { _tag: "Bool" };
    case "Literal":
      return typeof ast.literal === "string"
        ? { _tag: "Enum", values: [ast.literal] }
        : typeof ast.literal === "boolean"
          ? { _tag: "Bool" }
          : { _tag: "Float" };
    case "Enum":
      return { _tag: "Enum", values: ast.enums.map(([, value]) => String(value)) };
    case "Declaration": {
      const id = representationOf(ast.annotations);
      return id === undefined ? undefined : declarations[id];
    }
    default:
      return undefined;
  }
};

const isNothing = (ast: AST.AST) => ast._tag === "Null" || ast._tag === "Undefined";
const stringLiterals = (types: ReadonlyArray<AST.AST>): ReadonlyArray<string> | undefined => {
  const values = types.flatMap((t) =>
    t._tag === "Literal" && typeof t.literal === "string" ? [t.literal] : [],
  );
  return values.length === types.length && values.length > 0 ? values : undefined;
};

/**
 * Walk one field. `flatten` decides whether a struct becomes dotted columns
 * (the envelope) or one JSON column (the event body). A column describes
 * what the store holds: a type with a richer column (a timestamp, a date, a
 * decimal) keeps it; any other field that transforms is walked as what it
 * encodes to (an aggregate key's ref is stored as its id).
 */
const walk = (
  table: string,
  path: string,
  ast: AST.AST,
  nullable: boolean,
  sensitive: boolean,
  flatten: boolean,
): Walked => {
  const marked = sensitive || ast.annotations?.["sensitive"] === true;
  const leaf = leafOf(ast);
  if (leaf !== undefined) return column(path, leaf, nullable, marked);
  if (ast.encoding !== undefined)
    return walk(table, path, AST.toEncoded(ast), nullable, marked, flatten);
  switch (ast._tag) {
    case "Declaration": {
      if (
        representationOf(ast.annotations) === "effect/schema/Option" &&
        ast.typeParameters.length === 1
      ) {
        return walk(table, path, ast.typeParameters[0]!, true, marked, flatten);
      }
      // A class (a Domain event, any `Schema.Class`) declares its fields as its one struct type parameter.
      const [fields] = ast.typeParameters;
      return ast.typeParameters.length === 1 && fields?._tag === "Objects"
        ? walk(table, path, fields, nullable, marked, flatten)
        : { columns: [], problems: [new UnsupportedType({ table, path, kind: ast._tag })] };
    }
    case "Union": {
      const members = ast.types.filter((t) => !isNothing(t));
      const orNull = nullable || members.length !== ast.types.length;
      const values = stringLiterals(members);
      if (values !== undefined) return column(path, { _tag: "Enum", values }, orNull, marked);
      if (members.length === 1) return walk(table, path, members[0]!, orNull, marked, flatten);
      return column(path, { _tag: "Json" }, orNull, marked); // a union of shapes, e.g. the events
    }
    case "Objects":
      return flatten && ast.indexSignatures.length === 0
        ? concat(
            ast.propertySignatures.map((property) =>
              walk(
                table,
                `${path}.${String(property.name)}`,
                property.type,
                nullable || AST.isOptional(property.type),
                marked,
                true,
              ),
            ),
          )
        : column(path, { _tag: "Json" }, nullable, marked);
    case "Arrays": {
      const element = ast.rest[0] ?? ast.elements[0];
      const of = element === undefined ? undefined : leafOf(element);
      return column(
        path,
        of === undefined ? { _tag: "Json" } : { _tag: "Array", of },
        nullable,
        marked,
      );
    }
    case "Suspend":
      return column(path, { _tag: "Json" }, nullable, marked);
    default:
      return { columns: [], problems: [new UnsupportedType({ table, path, kind: ast._tag })] };
  }
};

/**
 * Flatten a row Schema into columns: nested structs become dotted paths;
 * the field `event` (the event union) stays one JSON column.
 */
export const columnsOf = (table: string, row: Schema.Top): Walked => {
  // The row as declared, transformations kept: each field is walked as the store holds it.
  const ast = row.ast;
  if (ast._tag !== "Objects")
    return { columns: [], problems: [new UnsupportedType({ table, path: "", kind: ast._tag })] };
  return concat(
    ast.propertySignatures.map((property) => {
      const name = String(property.name);
      return walk(
        table,
        name,
        property.type,
        AST.isOptional(property.type),
        false,
        name !== "event",
      );
    }),
  );
};

/** One event class's own columns, under `event.`, for its typed view. */
export const eventSpecOf = (
  table: string,
  tag: string,
  event: Schema.Top,
): Walked & { readonly tag: string } => ({
  tag,
  ...walk(table, "event", AST.toType(event.ast), false, false, true),
});

/**
 * A table's metadata columns, from the metadata fields: each field's type by
 * the same walk as the row's, its value from the field's `exportMetadata`.
 * A field must hold one column and say how it is computed.
 */
export const metadataOf = (
  table: string,
  fields: Readonly<Record<string, Schema.Top>>,
): {
  readonly metadata: ReadonlyArray<MetadataColumn>;
  readonly problems: ReadonlyArray<Reason>;
} => {
  const walked = Object.entries(fields).map(([path, schema]) => ({
    path,
    value: AST.resolve(schema.ast)?.["exportMetadata"],
    ...walk(table, path, AST.toType(schema.ast), false, false, false),
  }));
  const metadata = walked.flatMap(({ path, value, columns }) =>
    value !== undefined && columns.length === 1 && columns[0] !== undefined
      ? [{ path, type: columns[0].type, value }]
      : [],
  );
  const problems = walked.flatMap(({ path, value, columns, problems }): ReadonlyArray<Reason> => [
    ...problems,
    ...(value === undefined ? [new MetadataWithoutValue({ table, path })] : []),
    ...(columns.length > 1
      ? [new UnsupportedType({ table, path, kind: "metadata of several columns" })]
      : []),
  ]);
  // `Run` values first: the rest may read them.
  return {
    metadata: [
      ...metadata.filter((m) => m.value._tag === "Run"),
      ...metadata.filter((m) => m.value._tag !== "Run"),
    ],
    problems,
  };
};

// ---------------------------------------------------------------- sensitive data

/** Apply a table's `sensitive` policy to the row's columns; without one, every sensitive column is a problem. */
export const protect = (
  table: string,
  columns: ReadonlyArray<Column>,
  policy: "omit" | "encrypt" | undefined,
): {
  readonly columns: ReadonlyArray<Column>;
  readonly problems: ReadonlyArray<UnprotectedSensitive>;
} =>
  policy === undefined
    ? {
        columns,
        problems: columns
          .filter((c) => c.sensitive)
          .map((c) => new UnprotectedSensitive({ table, path: c.path })),
      }
    : {
        columns:
          policy === "omit"
            ? columns.filter((c) => !c.sensitive)
            : columns.map((c) => (c.sensitive ? { ...c, type: { _tag: "Bytes" } } : c)),
        problems: [],
      };

/**
 * Apply the policy to one event's columns. The unit protected is the
 * top-level event field holding a sensitive mark (`event.owner` for a mark on
 * `event.owner.name`): omitted, its columns go; encrypted, they become one
 * opaque column. Without a policy, every sensitive column is a problem.
 */
export const protectEvent = (
  table: string,
  columns: ReadonlyArray<Column>,
  policy: "omit" | "encrypt" | undefined,
): {
  readonly columns: ReadonlyArray<Column>;
  readonly fields: ReadonlySet<string>;
  readonly problems: ReadonlyArray<UnprotectedSensitive>;
} => {
  const fieldOf = (path: string) => path.split(".")[1] ?? path;
  const fields = new Set(columns.filter((c) => c.sensitive).map((c) => fieldOf(c.path)));
  if (policy === undefined) {
    return {
      columns,
      fields,
      problems: columns
        .filter((c) => c.sensitive)
        .map((c) => new UnprotectedSensitive({ table, path: c.path })),
    };
  }
  const kept = columns.filter((c) => !fields.has(fieldOf(c.path)));
  const sealedColumns: ReadonlyArray<Column> =
    policy === "omit"
      ? []
      : [...fields].map((field) => ({
          path: `event.${field}`,
          type: { _tag: "Bytes" },
          nullable: false,
          sensitive: true,
        }));
  return { columns: [...kept, ...sealedColumns], fields, problems: [] };
};

// ---------------------------------------------------------------- fingerprint

/** The canonical form of what a table means; not its name or generation. */
export const fingerprintOf = (
  spec: Pick<TableSpec, "columns" | "metadata" | "identity" | "events" | "sensitive">,
): string =>
  JSON.stringify({
    columns: Arr.sort(
      spec.columns,
      Order.mapInput(Order.String, (c: Column) => c.path),
    ),
    metadata: Arr.sort(
      spec.metadata,
      Order.mapInput(Order.String, (m: MetadataColumn) => m.path),
    ),
    identity: spec.identity,
    events: Arr.sort(
      spec.events.map((e) => e.tag),
      Order.String,
    ),
    sensitive: spec.sensitive ?? null,
  });
