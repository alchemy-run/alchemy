import type {
  GenericTableInfo,
  OrderedQuery,
  PaginationOptions,
  Query as ConvexQuery,
  QueryInitializer,
} from "convex/server";
import { defineSchema, defineTable, type TableDefinition } from "convex/server";
import type { GenericId } from "convex/values";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Reader, Writer } from "./Function.ts";
import { Id, validator, type ValidatorOf } from "./Value.ts";

/** An object schema whose fields Convex can store. */
export type TableSchema = Schema.Struct<Schema.Struct.Fields> &
  Schema.Codec<any, Record<string, any>, never, never>;

type BaseDefinition<S extends TableSchema> = TableDefinition<ValidatorOf<S["Encoded"]>>;

/** What Convex knows about the table: the encoded document, field paths and indexes. */
export type TableInfo<Name extends string, Definition extends TableDefinition<any, any, any, any>> =
  Definition extends TableDefinition<
    infer Fields,
    infer Indexes,
    infer SearchIndexes,
    infer VectorIndexes
  >
    ? {
        document: { _id: GenericId<Name>; _creationTime: number } & Fields["type"];
        fieldPaths: "_id" | "_creationTime" | Fields["fieldPaths"];
        indexes: Indexes & { by_id: ["_id"]; by_creation_time: ["_creationTime"] };
        searchIndexes: SearchIndexes;
        vectorIndexes: VectorIndexes;
      }
    : GenericTableInfo;

/** A stored document: the schema's type plus the fields Convex adds. */
export type Document<Name extends string, S extends TableSchema> = S["Type"] & {
  readonly _id: GenericId<Name>;
  readonly _creationTime: number;
};

/** A query built with Convex's own builder, run and decoded as Effects. */
export interface TableQuery<Doc> {
  /** Every matching document. */
  readonly collect: Effect.Effect<ReadonlyArray<Doc>, never, Reader>;
  /** The first match, if any. */
  readonly first: Effect.Effect<Option.Option<Doc>, never, Reader>;
  /** The only match, if any. Dies if more than one matches, as Convex does. */
  readonly unique: Effect.Effect<Option.Option<Doc>, never, Reader>;
  /** The first `n` matches. */
  readonly take: (n: number) => Effect.Effect<ReadonlyArray<Doc>, never, Reader>;
  /** One page of matches and the cursor for the next. */
  readonly paginate: (options: PaginationOptions) => Effect.Effect<
    {
      readonly page: ReadonlyArray<Doc>;
      readonly isDone: boolean;
      readonly continueCursor: string;
    },
    never,
    Reader
  >;
}

export interface Table<
  Name extends string = string,
  S extends TableSchema = TableSchema,
  Definition extends TableDefinition<any, any, any, any> = BaseDefinition<S>,
> {
  readonly name: Name;
  /** The fields you store. */
  readonly schema: S;
  /** Convex's table definition, with its indexes. {@link schema} puts it in `defineSchema`. */
  readonly definition: Definition;
  /** An ID in this table. */
  readonly Id: Schema.Codec<GenericId<Name>, GenericId<Name>, never, never>;
  /** A stored document, with `_id` and `_creationTime`. */
  readonly Document: Schema.Codec<Document<Name, S>, any, never, never>;
  /** The document with this ID, if it exists. */
  readonly get: (
    id: GenericId<Name>,
  ) => Effect.Effect<Option.Option<Document<Name, S>>, never, Reader>;
  /**
   * Query the table with Convex's query builder, typed by its indexes.
   * Without `build`, it reads every document in creation order.
   */
  readonly query: (
    build?: (
      q: QueryInitializer<TableInfo<Name, Definition>>,
    ) => ConvexQuery<TableInfo<Name, Definition>> | OrderedQuery<TableInfo<Name, Definition>>,
  ) => TableQuery<Document<Name, S>>;
  /** Store a document and return its ID. */
  readonly insert: (value: S["Type"]) => Effect.Effect<GenericId<Name>, Schema.SchemaError, Writer>;
  /** Change some fields. A field set to `undefined` is removed. */
  readonly patch: (
    id: GenericId<Name>,
    value: Partial<S["Type"]>,
  ) => Effect.Effect<void, Schema.SchemaError, Writer>;
  /** Replace the whole document. */
  readonly replace: (
    id: GenericId<Name>,
    value: S["Type"],
  ) => Effect.Effect<void, Schema.SchemaError, Writer>;
  /** Delete the document. */
  readonly delete: (id: GenericId<Name>) => Effect.Effect<void, never, Writer>;
}

/**
 * A Convex table whose documents are described by an Effect Schema. Indexes
 * use Convex's own builder, so every index type Convex has works here.
 *
 * Its methods run on the database of the function they're called from: a
 * query may only read, and writing from one doesn't type-check.
 *
 * ### Defining a Table
 * **Example:** A table with an index
 * ```typescript
 * export const Messages = Convex.Table(
 *   "messages",
 *   Schema.Struct({ channel: Schema.String, body: Schema.String }),
 *   (table) => table.index("by_channel", ["channel"]),
 * );
 * ```
 *
 * **Example:** `convex/schema.ts`
 * ```typescript
 * export default Convex.schema(Messages);
 * ```
 *
 * ### Reading and Writing
 * **Example:** Read by index, then insert
 * ```typescript
 * const recent = yield* Messages.query((q) =>
 *   q.withIndex("by_channel", (r) => r.eq("channel", channel)).order("desc"),
 * ).take(10);
 * const id = yield* Messages.insert({ channel, body });
 * ```
 *
 * @primitive
 * @product Functions
 */
export function Table<const Name extends string, S extends TableSchema>(
  name: Name,
  schema: S,
): Table<Name, S>;
export function Table<
  const Name extends string,
  S extends TableSchema,
  Definition extends TableDefinition<any, any, any, any>,
>(
  name: Name,
  schema: S,
  indexes: (table: BaseDefinition<S>) => Definition,
): Table<Name, S, Definition>;
export function Table(
  name: string,
  schema: TableSchema,
  indexes?: (table: TableDefinition<any>) => TableDefinition<any, any, any, any>,
): Table<string, any, any> {
  const base = defineTable(validator(schema));
  const id = Id(name);
  const DocumentSchema = Schema.Struct({
    ...schema.fields,
    _id: id,
    _creationTime: Schema.Number,
  }) as unknown as Schema.Codec<any, any, never, never>;
  const decode = (document: unknown) =>
    Schema.decodeUnknownEffect(DocumentSchema)(document).pipe(Effect.orDie);
  const decodeAll = (documents: ReadonlyArray<unknown>) => Effect.forEach(documents, decode);
  const encode = (value: unknown) =>
    Schema.encodeEffect(schema)(value) as Effect.Effect<Record<string, any>, Schema.SchemaError>;
  const encodeSome = (value: Record<string, unknown>) =>
    Effect.forEach(Object.entries(value), ([key, field]) =>
      field === undefined
        ? Effect.succeed([key, undefined] as const)
        : (
            Schema.encodeEffect(schema.fields[key] as Schema.Codec<any, any, never, never>)(
              field,
            ) as Effect.Effect<unknown, Schema.SchemaError>
          ).pipe(Effect.map((encoded) => [key, encoded] as const)),
    ).pipe(Effect.map(Object.fromEntries));
  const read = <A>(use: (db: Reader["Service"]) => Promise<A>) =>
    Reader.use((db) => Effect.promise(() => use(db)));
  const write = <A>(use: (db: Writer["Service"]) => Promise<A>) =>
    Writer.use((db) => Effect.promise(() => use(db)));

  const query = (build?: (q: QueryInitializer<any>) => ConvexQuery<any> | OrderedQuery<any>) => {
    const make = (db: Reader["Service"]) => {
      const q = db.query(name);
      return build === undefined ? q : build(q);
    };
    const one = (pick: (query: OrderedQuery<any>) => Promise<unknown>) =>
      read((db) => pick(make(db))).pipe(
        Effect.flatMap((document) =>
          document === null
            ? Effect.succeed(Option.none())
            : Effect.map(decode(document), Option.some),
        ),
      );
    return {
      collect: read((db) => make(db).collect()).pipe(Effect.flatMap(decodeAll)),
      first: one((q) => q.first()),
      unique: one((q) => q.unique()),
      take: (n: number) => read((db) => make(db).take(n)).pipe(Effect.flatMap(decodeAll)),
      paginate: (options: PaginationOptions) =>
        read((db) => make(db).paginate(options)).pipe(
          Effect.flatMap((result) =>
            Effect.map(decodeAll(result.page), (page) => ({
              page,
              isDone: result.isDone,
              continueCursor: result.continueCursor,
            })),
          ),
        ),
    } satisfies TableQuery<unknown>;
  };

  return {
    name,
    schema,
    definition: indexes === undefined ? base : indexes(base),
    Id: id,
    Document: DocumentSchema,
    get: (documentId) =>
      read((db) => db.get(name, documentId)).pipe(
        Effect.flatMap((document) =>
          document === null
            ? Effect.succeed(Option.none())
            : Effect.map(decode(document), Option.some),
        ),
      ),
    query,
    insert: (value) =>
      encode(value).pipe(Effect.flatMap((encoded) => write((db) => db.insert(name, encoded)))),
    patch: (documentId, value) =>
      encodeSome(value as Record<string, unknown>).pipe(
        Effect.flatMap((encoded) => write((db) => db.patch(name, documentId, encoded))),
      ),
    replace: (documentId, value) =>
      encode(value).pipe(
        Effect.flatMap((encoded) => write((db) => db.replace(name, documentId, encoded))),
      ),
    delete: (documentId) => write((db) => db.delete(name, documentId)),
  };
}

type TablesOf<Tables extends ReadonlyArray<Table<any, any, any>>> = {
  [T in Tables[number] as T["name"]]: T["definition"];
};

/**
 * The `convex/schema.ts` default export for these tables. Mix in tables
 * defined with `defineTable` by spreading `definition`s into `defineSchema`
 * yourself instead.
 *
 * **Example:** `convex/schema.ts`
 * ```typescript
 * export default Convex.schema(Messages, Users);
 * ```
 */
export const schema = <const Tables extends ReadonlyArray<Table<any, any, any>>>(
  ...tables: Tables
) =>
  defineSchema(
    Object.fromEntries(tables.map((table) => [table.name, table.definition])) as TablesOf<Tables>,
  );
