/**
 * An engine queries tables in SQL across the stores it reads: Athena or
 * DuckDB over an Iceberg catalog, ClickHouse, Trino, Postgres. A query names
 * its tables and columns as declarations, so a table no listed store holds
 * does not compile, and a table is always read under its stable name (the
 * promoted generation, so a rebuild moves every query at once). Values
 * become bound parameters. A query is an Effect SQL fragment
 * (`effect/sql/Statement`): an engine on a `SqlClient` runs it through its
 * client's own compiler, any other compiles it with Effect's.
 *
 * Rows reach the query as JSON values on every engine and decode with the
 * Schema it gives (`Schema.toCodecJson`), so moving a table to another
 * engine changes no decoding. The cost is one conversion of each value from
 * the driver's form to JSON before the decode.
 *
 * Consistency is Domain's: run a query inside a `Domain.Query` declared
 * with `waitsFor: [Facts, Labor]`, and Domain waits until both tables have
 * handled the caller's writes.
 *
 * @module
 */
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import { DefinitionError, DialectMismatch, TableNotInEngine } from "./DefinitionError.ts";
import { columnName, type TableSpec } from "./Spec.ts";
import type * as Store from "./Store.ts";
import { type ColumnRef, isColumn } from "./Table.ts";

// ---------------------------------------------------------------- errors

/** The database refused the query: its own name for why (`SqlSyntaxError`, Trino's `SYNTAX_ERROR`, an Athena state). Retrying the same query does not help. */
export class QueryRefused extends Data.TaggedError("QueryRefused")<{
  /** The driver's or the database's code, e.g. `SqlSyntaxError`, `FAILED`, `DuckDBPrepare`. */
  readonly code: string;
}> {
  override get message() {
    return `the database refused the query (${this.code})`;
  }
}

/** The engine could not get an answer now: its database, its connection, or the store that names its tables. May pass. */
export class EngineUnavailable extends Data.TaggedError("EngineUnavailable")<{
  /** What failed, e.g. `ConnectionError`, `TrinoHttp`, `Unavailable`. */
  readonly code: string;
}> {
  override get message() {
    return `the engine is unavailable (${this.code})`;
  }
}

/** The SQL client speaks a dialect no engine declares (`mssql`). */
export class UnsupportedDialect extends Data.TaggedError("UnsupportedDialect")<{}> {
  override get message() {
    return "the SQL client speaks a dialect no engine declares";
  }
}

/** A MySQL client reads `DATETIME` in its own zone, not UTC, so every instant the store wrote would shift. */
export class ClientTimeZone extends Data.TaggedError("ClientTimeZone")<{
  /** How the client read `DATETIME '1970-01-01 00:00:00'`. */
  readonly epoch: string;
}> {
  override get message() {
    return `the MySQL client reads DATETIME '1970-01-01 00:00:00' as ${this.epoch}, not as UTC: give it poolConfig: { timezone: "Z" }`;
  }
}

/** Why a query failed. */
export type QueryFailure = QueryRefused | EngineUnavailable | UnsupportedDialect | ClientTimeZone;

/** The engine could not build, or ran the query and it failed. */
export class QueryFailed extends Data.TaggedError("QueryFailed")<{
  readonly reason: QueryFailure;
  /** The driver's own words. */
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return `Query failed: ${this.reason.message}: ${this.detail}`;
  }
}

/** A result row is not what the query's Schema says. */
export class ResultDecodeFailed extends Data.TaggedError("ResultDecodeFailed")<{
  readonly engine: string;
  /** The decoder's issue, which names the failing row and path. */
  readonly issue: string;
}> {
  override get message() {
    return `A result of engine '${this.engine}' does not decode: ${this.issue}`;
  }
}

/** `one` found no row, or more than one. */
export class ExpectedOneRow extends Data.TaggedError("ExpectedOneRow")<{
  readonly engine: string;
  readonly rows: number;
}> {
  override get message() {
    return `Engine '${this.engine}' returned ${this.rows} rows where the query expects exactly one`;
  }
}

// ---------------------------------------------------------------- shapes

/** The SQL an engine speaks. A query is written in its engine's dialect. */
export type Dialect =
  | "postgres"
  | "mysql"
  | "sqlite"
  | "clickhouse"
  | "duckdb"
  | "athena"
  | "trino";

/**
 * A value a query binds as a parameter. A `DateTime` is bound as a `Date`,
 * except on SQLite, which has no timestamp type: there tables hold timestamps
 * as ISO text (`DateTime.formatIso`), and the parameter is bound the same way
 * so comparisons order as time does.
 */
export type Parameter = string | number | bigint | boolean | null | DateTime.DateTime;

/**
 * What an engine's Layer builds once: the dialect it speaks, how it runs a
 * query (an Effect SQL fragment, compiled by the engine), and how it names a
 * table. Rows come back as JSON values.
 */
export interface Implementation {
  readonly dialect: Dialect;
  readonly run: (
    query: Statement.Fragment,
  ) => Effect.Effect<ReadonlyArray<Schema.JsonObject>, QueryFailed, RuntimeContext>;
  /** A query's rows as the engine produces them, without holding the whole result. */
  readonly stream: (
    query: Statement.Fragment,
  ) => Stream.Stream<Schema.JsonObject, QueryFailed, RuntimeContext>;
  /**
   * The name a table is read under, e.g. `lake.facts` (a dot qualifies).
   * Defaults to the table's stable name, which points at its promoted
   * generation. A store without views (Iceberg) gives an Effect instead,
   * resolved for each query, so a promotion moves every query at once.
   */
  readonly name?:
    | ((table: {
        readonly spec: TableSpec;
        readonly store: string;
      }) => string | Effect.Effect<string, QueryFailed, RuntimeContext>)
    | undefined;
}

/** The tables an engine's stores hold. */
export type TablesOf<Stores extends ReadonlyArray<Store.Any>> = Stores[number]["tables"][number];

/** The columns of the tables an engine's stores hold. */
export type ColumnsOf<Stores extends ReadonlyArray<Store.Any>> = ColumnRef<
  TablesOf<Stores>["tableName"]
>;

/** What a query may interpolate: a table or column the engine's stores hold, or a parameter. */
export type Value<Stores extends ReadonlyArray<Store.Any>> =
  | TablesOf<Stores>
  | ColumnsOf<Stores>
  | Parameter;

/** A Schema a result row can decode with: one that needs no services. */
export type Result = Schema.Top & { readonly DecodingServices: never };

/** A query as a tagged template over an engine's tables, columns and parameters. */
export type Template<Stores extends ReadonlyArray<Store.Any>, A, E> = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<Value<Stores>>
) => Effect.Effect<A, E, RuntimeContext>;

/** A query, as a tagged template, whose rows stream. */
export type StreamTemplate<Stores extends ReadonlyArray<Store.Any>, A, E> = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<Value<Stores>>
) => Stream.Stream<A, E, RuntimeContext>;

/** The queries of one engine, obtained with `yield* Analytics.Query`. */
export interface Sql<Stores extends ReadonlyArray<Store.Any>> {
  /** Every row, decoded with `result`. */
  readonly many: <S extends Result>(
    result: S,
  ) => Template<Stores, ReadonlyArray<S["Type"]>, QueryFailed | ResultDecodeFailed>;
  /** Exactly one row, decoded with `result`. */
  readonly one: <S extends Result>(
    result: S,
  ) => Template<Stores, S["Type"], QueryFailed | ResultDecodeFailed | ExpectedOneRow>;
  /** Every row, decoded with `result`, as the engine produces them: for results too large to hold. */
  readonly stream: <S extends Result>(
    result: S,
  ) => StreamTemplate<Stores, S["Type"], QueryFailed | ResultDecodeFailed>;
}

/** Type-level identity of an engine's queries in an Effect's requirements. */
export interface QueryKey<Name extends string> {
  readonly "~alchemy/Domain/Export/Engine/Query": Name;
}

/** An engine declaration. Like a store, it holds its service (see `Store.StoreClass`). */
export interface EngineClass<
  Name extends string,
  Stores extends ReadonlyArray<Store.Any>,
  D extends Dialect,
> {
  new (): object;
  readonly kind: "Engine";
  readonly engineName: Name;
  readonly stores: Stores;
  readonly dialect: D;
  /** The engine's queries. Provided by `toLayer`. */
  readonly Query: Context.Service<QueryKey<Name>, Sql<Stores>>;
  /** Bind the engine once. Dies if the implementation speaks another dialect than the engine declares. */
  toLayer<E, R>(
    build: Effect.Effect<Implementation, E, R>,
  ): Layer.Layer<QueryKey<Name>, E, Exclude<R, Scope.Scope>>;
}

// ---------------------------------------------------------------- the factory

/**
 * Declare an engine over stores, speaking one dialect. Its queries may name
 * only the tables those stores hold; `toLayer` binds an implementation
 * (`Export.Sql.engine`, `Export.Trino.engine`, `Export.DuckDb.engine`,
 * `Export.Athena.engine`) and dies if it speaks another dialect.
 *
 * ### Declaring an engine
 * **Example:** Labor per pick across two tables, on Postgres
 * ```typescript
 * import * as Export from "@alchemy.run/domain/Export";
 * import { PgClient } from "@effect/sql-pg";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import * as Schema from "effect/Schema";
 *
 * export class Analytics extends Export.Engine("Analytics", {
 *   stores: [Warehouse],
 *   dialect: "postgres",
 * }) {}
 *
 * export const AnalyticsLive = Analytics.toLayer(Export.Sql.engine()).pipe(
 *   Layer.provide(PgClient.layer({ url })),
 * );
 *
 * const LaborPerPickRow = Schema.Struct({ facility: Schema.String, picks: Schema.Number });
 *
 * export const laborPerPick = (facility: string, day: DateTime.Utc) =>
 *   Effect.gen(function* () {
 *     const sql = yield* Analytics.Query;
 *     return yield* sql.many(LaborPerPickRow)`
 *       SELECT ${Facts.column("key")} AS facility, count(*) AS picks
 *       FROM ${Facts} JOIN ${Labor}
 *         ON ${Labor.column("envelope.correlationId")} = ${Facts.column("envelope.correlationId")}
 *       WHERE ${Facts.column("key")} = ${facility} AND ${Facts.column("envelope.at")} >= ${day}
 *       GROUP BY 1`;
 *   });
 * ```
 *
 * ### Waiting for the caller's writes
 * **Example:** A query that reads what its caller just wrote
 * ```typescript
 * export class LaborPerPick extends Domain.Query("LaborPerPick", {
 *   input: { facility: Schema.String },
 *   output: Schema.Array(LaborPerPickRow),
 *   waitsFor: [Facts, Labor],
 * }) {}
 * ```
 *
 * @primitive
 */
export const make = <
  const Name extends string,
  const Stores extends ReadonlyArray<Store.Any>,
  const D extends Dialect,
>(
  name: Name,
  definition: { readonly stores: Stores; readonly dialect: D },
): EngineClass<Name, Stores, D> => {
  const Query = Context.Service<QueryKey<Name>, Sql<Stores>>()(
    `alchemy/Domain/Export/Engine/${name}/Query`,
  );
  const placed = definition.stores.flatMap((store) =>
    store.tables.map((table) => ({ table, store: store.storeName })),
  );

  /** The queries over one built implementation: static names resolved once, effectful ones per query. */
  const sqlOf = (engine: Implementation): Sql<Stores> => {
    const names = new Map(
      placed.map(({ table, store }) => [
        table.tableName,
        engine.name?.({ spec: table.spec, store }) ?? table.spec.name,
      ]),
    );
    // A type escape (an untyped caller) is the only way to name a table the engine does not read.
    const nameOf = (table: string): Effect.Effect<string, QueryFailed, RuntimeContext> => {
      const resolved = names.get(table);
      return resolved === undefined
        ? Effect.die(new DefinitionError({ reason: new TableNotInEngine({ engine: name, table }) }))
        : typeof resolved === "string"
          ? Effect.succeed(resolved)
          : resolved;
    };
    /** A table a query value names: a table itself, or one of its columns. */
    const tableOf = (value: Value<Stores>): string | undefined =>
      // Among a query's values only declarations carry a `kind`; a table is a projection.
      Predicate.hasProperty(value, "kind") || isColumn(value) ? value.tableName : undefined;
    /**
     * A parameter as the dialect binds it. MySQL and ClickHouse take an
     * instant as UTC text to the millisecond: mysql2 writes a `Date` in the
     * client's zone, and ClickHouse binds one as whole seconds.
     */
    const parameterOf = (value: unknown) =>
      DateTime.isDateTime(value)
        ? engine.dialect === "sqlite"
          ? DateTime.formatIso(value)
          : engine.dialect === "mysql" || engine.dialect === "clickhouse"
            ? DateTime.formatIso(value).slice(0, 23).replace("T", " ")
            : DateTime.toDateUtc(value)
        : value;
    /** A value as a fragment's segment: a table or column as an identifier, anything else a parameter. */
    const segmentOf = (
      value: Value<Stores>,
      tables: ReadonlyMap<string, string>,
    ): Statement.Segment => {
      const table = tableOf(value);
      if (table === undefined) return Statement.parameter(parameterOf(value));
      const resolved = tables.get(table)!;
      return isColumn(value)
        ? Statement.identifier(`${resolved}.${columnName(value.path)}`)
        : Statement.identifier(resolved);
    };
    /**
     * The template as one fragment: its text as literals between the values'
     * segments. Each table is named once per query: a store that resolves
     * names per query (Iceberg) may promote between two lookups, and one
     * query must not read two generations.
     */
    const prepare = (strings: TemplateStringsArray, values: ReadonlyArray<Value<Stores>>) =>
      Effect.gen(function* () {
        const tables = new Map<string, string>();
        for (const value of values) {
          const table = tableOf(value);
          if (table !== undefined && !tables.has(table)) tables.set(table, yield* nameOf(table));
        }
        const segments = values.map((value) => segmentOf(value, tables));
        return Statement.fragment(
          strings.flatMap((text, index) => {
            const segment = segments[index];
            const literal = text === "" ? [] : [Statement.literal(text)];
            return segment === undefined ? literal : [...literal, segment];
          }),
        );
      });
    const rowsOf = <S extends Result>(result: S) => {
      const decode = Schema.decodeUnknownEffect(Schema.Array(Schema.toCodecJson(result)));
      return (strings: TemplateStringsArray, values: ReadonlyArray<Value<Stores>>) =>
        prepare(strings, values).pipe(
          Effect.flatMap(engine.run),
          Effect.flatMap((json) =>
            Effect.mapError(
              decode(json),
              (issue) => new ResultDecodeFailed({ engine: name, issue: String(issue) }),
            ),
          ),
          Effect.withSpan(`Export.Engine ${name}`, {
            attributes: { "domain.export.engine": name, "db.system.name": engine.dialect },
          }),
        );
    };
    return {
      many: (result) => {
        const rows = rowsOf(result);
        return (strings, ...values) => rows(strings, values);
      },
      one: (result) => {
        const rows = rowsOf(result);
        return (strings, ...values) =>
          Effect.flatMap(rows(strings, values), (all) => {
            const [row] = all;
            return all.length === 1 && row !== undefined
              ? Effect.succeed(row)
              : Effect.fail(new ExpectedOneRow({ engine: name, rows: all.length }));
          });
      },
      stream: (result) => {
        const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(result));
        return (strings, ...values) =>
          Stream.unwrap(
            Effect.map(prepare(strings, values), (query) =>
              engine
                .stream(query)
                .pipe(
                  Stream.mapEffect((row) =>
                    Effect.mapError(
                      decode(row),
                      (issue) => new ResultDecodeFailed({ engine: name, issue: String(issue) }),
                    ),
                  ),
                ),
            ),
          ).pipe(
            Stream.withSpan(`Export.Engine ${name}`, {
              attributes: { "domain.export.engine": name, "db.system.name": engine.dialect },
            }),
          );
      },
    };
  };

  const bind = (engine: Implementation) =>
    engine.dialect === definition.dialect
      ? Effect.succeed(sqlOf(engine))
      : Effect.die(
          new DefinitionError({
            reason: new DialectMismatch({
              engine: name,
              declared: definition.dialect,
              bound: engine.dialect,
            }),
          }),
        );

  return class {
    static readonly kind = "Engine" as const;
    static readonly engineName = name;
    static readonly stores = definition.stores;
    static readonly dialect = definition.dialect;
    static readonly Query = Query;
    static toLayer<E, R>(build: Effect.Effect<Implementation, E, R>) {
      return Layer.effect(Query, Effect.flatMap(build, bind));
    }
  };
};
