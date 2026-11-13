/**
 * DuckDB in process, as a service. A file database is opened once per path
 * (DuckDB's instance cache) with its settings; an in-memory database is
 * fresh per Layer and closes with it. A pool of connections runs one query
 * per connection at a time, and every query is interruptible: an
 * interrupted fiber interrupts DuckDB. Each query is prepared afresh (a plan
 * kept for the next run answers from the statistics of when it was made) and
 * bound with DuckDB's own types; results convert by column
 * type, so decimals and huge integers stay exact and timestamps are ISO
 * strings.
 *
 * `engine` is an engine over the service; `memory` binds an engine
 * declaration to an in-memory database loaded from the stores it reads.
 *
 * @module
 */
import {
  BIGINT,
  BOOLEAN,
  DATE,
  DOUBLE,
  type DuckDBConnection,
  DuckDBInstance,
  type DuckDBResult,
  type DuckDBType,
  DuckDBTypeId,
  type DuckDBValue,
  type DuckDBValueConverter,
  JSDuckDBValueConverter,
  jsToDuckDBValue,
  JsonDuckDBValueConverter,
  TIMESTAMPTZ,
  VARCHAR,
} from "@duckdb/node-api";
import * as Arr from "effect/Array";
import * as BigInt_ from "effect/BigInt";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Pool from "effect/Pool";
import * as Predicate from "effect/Predicate";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import { detailOf, isJsonObject, jsonAt, toJson } from "../internal.ts";
import type * as Engine from "./Engine.ts";
import { EngineUnavailable, QueryFailed, QueryRefused } from "./Engine.ts";
import { columnName, type Logical, type TableSpec } from "./Spec.ts";
import * as Store from "./Store.ts";

// ---------------------------------------------------------------- values

/**
 * Results by column type: exact text for decimals and huge integers, everything else as JSON from its JS
 * form. Values nested in lists and structs convert through their JS form, so a decimal inside a list is a number.
 */
const exact = new Set<DuckDBTypeId>([
  DuckDBTypeId.DECIMAL,
  DuckDBTypeId.HUGEINT,
  DuckDBTypeId.UHUGEINT,
  DuckDBTypeId.BIGNUM,
]);
const resultConverter: DuckDBValueConverter<Schema.Json> = (value, type) =>
  exact.has(type.typeId)
    ? JsonDuckDBValueConverter(value, type, JsonDuckDBValueConverter)
    : toJson(JSDuckDBValueConverter(value, type, JSDuckDBValueConverter));

/** A bound parameter as DuckDB's own value: a `Date` as a `TIMESTAMPTZ`, the rest as they are. */
const toDuckDb: (value: unknown) => DuckDBValue = Match.type<unknown>().pipe(
  Match.when(Predicate.isNullish, () => null),
  Match.when(Predicate.isDate, (date) => jsToDuckDBValue(date, TIMESTAMPTZ)),
  Match.when(Predicate.isString, (string) => string),
  Match.when(Predicate.isNumber, (number) => number),
  Match.when(Predicate.isBigInt, (bigint) => bigint),
  Match.when(Predicate.isBoolean, (boolean) => boolean),
  Match.orElse(String),
);

/** A column's DuckDB type for a table, and the type its cells are appended as. Decimals and bytes stay their text. */
const typeOf: (type: Logical) => { readonly ddl: string; readonly cell: DuckDBType } =
  Match.type<Logical>().pipe(
    Match.tagsExhaustive({
      String: () => ({ ddl: "VARCHAR", cell: VARCHAR }),
      Enum: () => ({ ddl: "VARCHAR", cell: VARCHAR }),
      Int: () => ({ ddl: "BIGINT", cell: BIGINT }),
      Float: () => ({ ddl: "DOUBLE", cell: DOUBLE }),
      Decimal: () => ({ ddl: "VARCHAR", cell: VARCHAR }),
      Bool: () => ({ ddl: "BOOLEAN", cell: BOOLEAN }),
      Timestamp: () => ({ ddl: "TIMESTAMPTZ", cell: TIMESTAMPTZ }),
      Date: () => ({ ddl: "DATE", cell: DATE }),
      Bytes: () => ({ ddl: "VARCHAR", cell: VARCHAR }),
      Json: () => ({ ddl: "JSON", cell: VARCHAR }),
      Array: () => ({ ddl: "JSON", cell: VARCHAR }),
    }),
  );

const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** One JSON cell as the DuckDB value its column takes. */
const cellOf = (value: Schema.Json, type: DuckDBType): Effect.Effect<DuckDBValue, QueryFailed> => {
  if (value === null) return Effect.succeed(null);
  if ((type === TIMESTAMPTZ || type === DATE) && Predicate.isString(value)) {
    return Option.match(DateTime.make(value), {
      onNone: () =>
        Effect.fail(
          new QueryFailed({
            reason: new QueryRefused({ code: "DuckDBAppend" }),
            detail: `not a timestamp: ${value}`,
          }),
        ),
      onSome: (at) => Effect.succeed(jsToDuckDBValue(DateTime.toDateUtc(at), type)),
    });
  }
  if (type === BIGINT && Predicate.isNumber(value))
    return Effect.succeed(Option.getOrElse(BigInt_.fromNumber(value), () => value));
  if (typeof value === "object")
    return Effect.mapError(encodeJsonText(value), failed("DuckDBAppend"));
  return Effect.succeed(value);
};

// ---------------------------------------------------------------- the service

/**
 * A failed DuckDB call, by the step that failed. DuckDB names no kinds of
 * failure, so a statement's (`DuckDBPrepare`, `DuckDBError`, …) is
 * `QueryRefused`; opening the database or a connection is `EngineUnavailable`.
 */
const failed = (code: string) => (cause: unknown) =>
  new QueryFailed({
    reason:
      code === "DuckDBOpen" || code === "DuckDBConnect" || code === "StoreUnavailable"
        ? new EngineUnavailable({ code })
        : new QueryRefused({ code }),
    detail: detailOf(cause),
    cause,
  });

const compiler = Statement.makeCompilerSqlite();

/** One pooled connection. */
interface Pooled {
  readonly connection: DuckDBConnection;
}

/** Run a DuckDB call on a connection; interrupting the fiber interrupts DuckDB. */
const call = <A>(
  pooled: Pooled,
  reason: string,
  run: () => Promise<A>,
): Effect.Effect<A, QueryFailed> =>
  Effect.tryPromise({
    try: (signal) => {
      signal.addEventListener("abort", () => pooled.connection.interrupt(), { once: true });
      return run();
    },
    catch: failed(reason),
  });

/**
 * A compiled query's statement on a connection, bound with its parameters,
 * destroyed with the scope. Never reused: DuckDB plans with the statistics
 * of the moment, and a plan run again after the data changed can answer
 * wrongly (its compressed materialization decodes a grouped text column
 * with the bounds of an emptier table).
 */
const prepare = (pooled: Pooled, text: string, parameters: ReadonlyArray<unknown>) =>
  Effect.acquireRelease(
    call(pooled, "DuckDBPrepare", () => pooled.connection.prepare(text)),
    (prepared) => Effect.sync(() => prepared.destroySync()),
  ).pipe(
    Effect.flatMap((prepared) =>
      Effect.try({
        try: () => {
          prepared.bind(Arr.map(parameters, toDuckDb));
          return prepared;
        },
        catch: failed("DuckDBBind"),
      }),
    ),
  );

const rowsOf = (result: DuckDBResult) => result.convertRowObjects(resultConverter);

/** Run a script's statements in order on one connection. */
const execOn = (pooled: Pooled, script: string) =>
  Effect.flatMap(
    call(pooled, "DuckDBScript", () => pooled.connection.extractStatements(script)),
    (statements) =>
      Effect.forEach(
        Arr.makeBy(statements.count, (index) => index),
        (index) =>
          call(pooled, "DuckDBScript", () =>
            statements.prepare(index).then((statement) => statement.run()),
          ),
        { discard: true },
      ),
  );

/** DuckDB in process: queries, streams, scripts, bulk appends and table introspection over pooled connections. */
export class DuckDb extends Context.Service<
  DuckDb,
  {
    /** Every row of a query, as JSON. */
    readonly query: (
      query: Statement.Fragment,
    ) => Effect.Effect<ReadonlyArray<Schema.JsonObject>, QueryFailed>;
    /** A query's rows chunk by chunk, holding one connection until the stream ends. */
    readonly stream: (query: Statement.Fragment) => Stream.Stream<Schema.JsonObject, QueryFailed>;
    /** Run a script of statements, in order. */
    readonly exec: (script: string) => Effect.Effect<void, QueryFailed>;
    /** Every row of a query already compiled (`?` placeholders), as JSON. */
    readonly execute: (
      text: string,
      parameters: ReadonlyArray<unknown>,
    ) => Effect.Effect<ReadonlyArray<Schema.JsonObject>, QueryFailed>;
    /** Append rows to a table through DuckDB's appender, each cell as its column's type. */
    readonly append: (
      table: string,
      columns: ReadonlyArray<{ readonly type: Logical }>,
      rows: ReadonlyArray<ReadonlyArray<Schema.Json>>,
    ) => Effect.Effect<void, QueryFailed>;
    /** The tables a query reads, as DuckDB resolves them. */
    readonly tables: (
      query: Statement.Fragment,
    ) => Effect.Effect<ReadonlyArray<string>, QueryFailed>;
  }
>()("alchemy/Domain/Export/DuckDb") {}

/** The database `Export.DuckDb.layer` opens, and how. */
export interface Options {
  /**
   * The database file, or `:memory:` for a fresh in-memory database.
   * @default ":memory:"
   */
  readonly path?: string | undefined;
  /**
   * DuckDB settings, e.g. `{ threads: "4", memory_limit: "2GB", access_mode: "READ_ONLY" }`.
   * `disabled_optimizers` defaults to `compressed_materialization`: with it on, a grouped
   * query racing a write to the same table can return text no row holds (DuckDB 1.5).
   */
  readonly config?: Readonly<Record<string, string>> | undefined;
  /**
   * A script run once on the database before any connection is pooled, for
   * what belongs to the database rather than a connection: `INSTALL`,
   * `LOAD`, `CREATE SECRET`, `ATTACH`.
   */
  readonly init?: string | undefined;
  /** A script run on every connection as it opens: `SET`, `USE`. An attached database belongs to the instance, so `ATTACH` goes in `init`. */
  readonly setup?: string | undefined;
  /**
   * Connections in the pool. DuckDB runs one query per connection at a time.
   * @default 4
   */
  readonly connections?: number | undefined;
}

/** A file database from DuckDB's instance cache (shared, so not closed here); an in-memory one fresh, closed with the scope. */
const open = (
  path: string,
  config: Record<string, string>,
): Effect.Effect<DuckDBInstance, QueryFailed, Scope.Scope> =>
  path === ":memory:"
    ? Effect.acquireRelease(
        Effect.tryPromise({
          try: () => DuckDBInstance.create(path, config),
          catch: failed("DuckDBOpen"),
        }),
        (instance) => Effect.sync(() => instance.closeSync()),
      )
    : Effect.tryPromise({
        try: () => DuckDBInstance.fromCache(path, config),
        catch: failed("DuckDBOpen"),
      });

/**
 * The `DuckDb` service over a database: in memory by default, or a file.
 * What belongs to the database (extensions, secrets, an attached catalog)
 * goes in `init`, run once; what belongs to a connection goes in `setup`.
 *
 * ### Reading an Iceberg lake
 * **Example:** The engine over a lake attached once for the database
 * ```typescript
 * import * as DuckDb from "@alchemy.run/domain/Export/DuckDb";
 * import * as Layer from "effect/Layer";
 *
 * export const AnalyticsLive = Analytics.toLayer(
 *   DuckDb.engine({ name: ({ spec }) => `lake.facts.${spec.name}` }),
 * ).pipe(
 *   Layer.provide(
 *     DuckDb.layer({
 *       config: { threads: "4", memory_limit: "2GB" },
 *       init: "INSTALL iceberg; LOAD iceberg; ATTACH 'warehouse' AS lake (TYPE iceberg, ENDPOINT 'http://lakekeeper:8181/catalog', AUTHORIZATION_TYPE 'none')",
 *     }),
 *   ),
 * );
 * ```
 *
 * ### Querying a file
 * **Example:** A database file, read only
 * ```typescript
 * DuckDb.layer({ path: "facts.duckdb", config: { access_mode: "READ_ONLY" } });
 * ```
 *
 * @layer
 * @title DuckDb
 * @provides Export.DuckDb.DuckDb
 * @peer @duckdb/node-api
 */
export const layer = (options: Options = {}): Layer.Layer<DuckDb, QueryFailed> =>
  Layer.effect(
    DuckDb,
    Effect.gen(function* () {
      const instance = yield* open(options.path ?? ":memory:", {
        disabled_optimizers: "compressed_materialization",
        ...options.config,
      });
      if (options.init !== undefined) {
        const script = options.init;
        yield* Effect.acquireUseRelease(
          Effect.tryPromise({ try: () => instance.connect(), catch: failed("DuckDBConnect") }),
          (connection) => execOn({ connection }, script),
          (connection) => Effect.sync(() => connection.closeSync()),
        );
      }
      const pool = yield* Pool.make({
        size: options.connections ?? 4,
        acquire: Effect.acquireRelease(
          Effect.tryPromise({ try: () => instance.connect(), catch: failed("DuckDBConnect") }).pipe(
            Effect.map((connection): Pooled => ({ connection })),
            Effect.tap((pooled) =>
              options.setup === undefined ? Effect.void : execOn(pooled, options.setup),
            ),
          ),
          (pooled) => Effect.sync(() => pooled.connection.closeSync()),
        ),
      });
      /** A connection for `use`, whose scope (its statement) closes before the connection returns. */
      const borrow = <A, E>(
        use: (pooled: Pooled) => Effect.Effect<A, E, Scope.Scope>,
      ): Effect.Effect<A, E | QueryFailed> =>
        Pool.get(pool).pipe(Effect.flatMap(use), Effect.scoped);
      const execute = (text: string, parameters: ReadonlyArray<unknown>) =>
        borrow((pooled) =>
          prepare(pooled, text, parameters).pipe(
            Effect.flatMap((statement) =>
              call(pooled, "DuckDBError", () => statement.run().then(rowsOf)),
            ),
            Effect.map(Arr.filter(isJsonObject)),
          ),
        );
      return {
        query: (query) => execute(...compiler.compile(query, false)),
        execute,
        stream: (query) =>
          Pool.get(pool).pipe(
            Effect.flatMap((pooled) =>
              // A stream interrupted midway (its consumer gone) stops DuckDB before the connection returns to the pool.
              Effect.addFinalizer((exit) =>
                Exit.hasInterrupts(exit)
                  ? Effect.sync(() => pooled.connection.interrupt())
                  : Effect.void,
              ).pipe(
                Effect.andThen(prepare(pooled, ...compiler.compile(query, false))),
                Effect.flatMap((statement) =>
                  call(pooled, "DuckDBError", () => statement.stream()),
                ),
                Effect.map((result) =>
                  Stream.fromAsyncIterable(
                    result.yieldConvertedRowObjects(resultConverter),
                    failed("DuckDBError"),
                  ).pipe(
                    Stream.flatMap((chunk) => Stream.fromIterable(Arr.filter(chunk, isJsonObject))),
                  ),
                ),
              ),
            ),
            Stream.unwrap,
          ),
        exec: (script) => borrow((pooled) => execOn(pooled, script)),
        append: (table, columns, rows) => {
          const types = Arr.map(columns, (column) => typeOf(column.type).cell);
          return Effect.forEach(rows, (row) =>
            Effect.forEach(row, (value, index) => cellOf(value, types[index] ?? VARCHAR)),
          ).pipe(
            Effect.flatMap((cells) =>
              borrow((pooled) =>
                Effect.acquireUseRelease(
                  call(pooled, "DuckDBAppend", () => pooled.connection.createAppender(table)),
                  (appender) =>
                    Effect.try({
                      try: () => {
                        for (const row of cells) {
                          row.forEach((cell, index) => appender.appendValue(cell, types[index]));
                          appender.endRow();
                        }
                        appender.flushSync();
                      },
                      catch: failed("DuckDBAppend"),
                    }),
                  (appender) => Effect.sync(() => appender.closeSync()),
                ),
              ),
            ),
          );
        },
        tables: (query) =>
          borrow((pooled) =>
            Effect.try({
              // DuckDB resolves no tables in a query with parameters; the tables do not depend on their values.
              try: () =>
                pooled.connection.getTableNames(
                  compiler.compile(
                    Statement.fragment(
                      Arr.map(query.segments, (segment) =>
                        segment._tag === "Parameter" ? Statement.literal("NULL") : segment,
                      ),
                    ),
                    false,
                  )[0],
                  false,
                ),
              catch: failed("DuckDBTables"),
            }),
          ),
      };
    }),
  );

// ---------------------------------------------------------------- an Effect SqlClient

const sqlErrorOf = (failure: QueryFailed) =>
  SqlError.make({ reason: UnknownError.make({ cause: failure, message: failure.message }) });

/**
 * An Effect `SqlClient` over the `DuckDb` service in context: SQLite's
 * statement compiler (DuckDB reads its `?` placeholders and quoting), each
 * statement on a pooled connection. Code written for a `SqlClient` runs on
 * DuckDB, and through it on what DuckDB attaches (an Iceberg catalog).
 * There are no transactions: DuckDB's would span one pooled connection only.
 * DuckDB names no kinds of failure, so every failed statement is an
 * `UnknownError` (a store retries it as `Unavailable`).
 *
 * ### Code written for a SqlClient
 * **Example:** Effect SQL on an in-memory DuckDB
 * ```typescript
 * import * as DuckDb from "@alchemy.run/domain/Export/DuckDb";
 * import * as Layer from "effect/Layer";
 *
 * export const DuckDbSql = DuckDb.sqlClient.pipe(Layer.provideMerge(DuckDb.layer()));
 * ```
 *
 * @layer
 * @provides SqlClient
 * @peer @duckdb/node-api
 */
export const sqlClient: Layer.Layer<SqlClient.SqlClient, never, DuckDb> = Layer.effect(
  SqlClient.SqlClient,
  Effect.gen(function* () {
    const duckdb = yield* DuckDb;
    const run = (text: string, parameters: ReadonlyArray<unknown>) =>
      Effect.mapError(duckdb.execute(text, parameters), sqlErrorOf);
    const values = (text: string, parameters: ReadonlyArray<unknown>) =>
      Effect.map(run(text, parameters), (rows) => rows.map((row) => Object.values(row)));
    const connection = {
      execute: (text: string, parameters: ReadonlyArray<unknown>) => run(text, parameters),
      executeRaw: (text: string, parameters: ReadonlyArray<unknown>) => run(text, parameters),
      executeStream: (text: string, parameters: ReadonlyArray<unknown>) =>
        Stream.unwrap(Effect.map(run(text, parameters), Stream.fromIterable)),
      executeValues: values,
      executeValuesUnprepared: values,
      executeUnprepared: (text: string, parameters: ReadonlyArray<unknown>) =>
        run(text, parameters),
    };
    return yield* SqlClient.make({
      acquirer: Effect.succeed(connection),
      compiler,
      driver: "duckdb",
      spanAttributes: [["db.system.name", "duckdb"]],
    });
  }),
).pipe(Layer.provide(Reactivity.layer));

// ---------------------------------------------------------------- engines

/**
 * An engine over the `DuckDb` service in context. `name` gives the name
 * each table is read under (`Export.Iceberg.names` for an attached lake);
 * by default its stable name.
 *
 * ### Querying with DuckDB
 * **Example:** The engine over the database `Export.Iceberg.layer` attached
 * ```typescript
 * export const AnalyticsLive = Analytics.toLayer(
 *   Effect.flatMap(Iceberg.names(Lake), (name) => DuckDb.engine({ name })),
 * ).pipe(Layer.provideMerge(LakeLive));
 * ```
 *
 * @layer
 * @provides Export.Engine.Implementation
 * @peer @duckdb/node-api
 */
export const engine = (
  options: { readonly name?: Engine.Implementation["name"] } = {},
): Effect.Effect<Engine.Implementation, never, DuckDb> =>
  Effect.map(DuckDb, (duckdb): Engine.Implementation => ({
    dialect: "duckdb",
    name: options.name,
    run: duckdb.query,
    stream: duckdb.stream,
  }));

/** Replace one table with the rows its store holds now, under its stable name. */
const load = (
  duckdb: DuckDb["Service"],
  spec: TableSpec,
  rows: ReadonlyArray<Schema.JsonObject>,
) => {
  const columns = [...spec.columns, ...spec.metadata];
  const create = Statement.fragment([
    Statement.literal("CREATE OR REPLACE TABLE "),
    Statement.identifier(spec.name),
    Statement.literal(" ("),
    ...Arr.flatMap(columns, (column, index) => [
      ...(index === 0 ? [] : [Statement.literal(", ")]),
      Statement.identifier(columnName(column.path)),
      Statement.literal(` ${typeOf(column.type).ddl}`),
    ]),
    Statement.literal(")"),
  ]);
  return duckdb.query(create).pipe(
    Effect.andThen(
      duckdb.append(
        spec.name,
        columns,
        Arr.map(rows, (row) => Arr.map(columns, (column) => jsonAt(row, column.path) ?? null)),
      ),
    ),
  );
};

/**
 * Bind an engine declaration to DuckDB in memory over its stores. Before
 * each query, the tables it reads (as DuckDB resolves them) are reloaded
 * from their stores, so it sees what they hold now. Queries run one at a
 * time and keep the engine's dialect; DuckDB reads most Postgres-style SQL.
 *
 * ### Testing a query in a story
 * **Example:** The engine over the stores' memory implementations
 * ```typescript
 * const AnalyticsTest = DuckDb.memory(Analytics).pipe(Layer.provide(Lake.memory()));
 * ```
 *
 * @layer
 * @provides Export.Engine.Query
 * @peer @duckdb/node-api
 */
export const memory = <
  Name extends string,
  Stores extends ReadonlyArray<Store.Any>,
  D extends Engine.Dialect,
>(
  declaration: Engine.EngineClass<Name, Stores, D>,
): Layer.Layer<Engine.QueryKey<Name>, never, Store.KeysOf<Stores>> =>
  declaration
    .toLayer(
      Effect.gen(function* () {
        const duckdb = yield* DuckDb;
        const tables = Arr.flatMap(
          yield* Store.implementationsOf(declaration.stores),
          ({ store, implementation }) =>
            Arr.map(store.tables, (table) => ({
              spec: table.spec,
              reader: implementation.reader(table.spec),
            })),
        );
        const one = yield* Semaphore.make(1);
        const reload = (query: Statement.Fragment) =>
          Effect.flatMap(duckdb.tables(query), (names) =>
            Effect.forEach(
              Arr.filter(tables, ({ spec }) => names.includes(spec.name)),
              ({ spec, reader }) =>
                Stream.runCollect(reader.scan({})).pipe(
                  Effect.mapError(failed("StoreUnavailable")),
                  Effect.flatMap((rows) => load(duckdb, spec, Arr.filter(rows, isJsonObject))),
                ),
              { discard: true },
            ),
          );
        return {
          dialect: declaration.dialect,
          run: (query) => one.withPermits(1)(Effect.andThen(reload(query), duckdb.query(query))),
          stream: (query) =>
            Stream.unwrap(reload(query).pipe(Effect.as(duckdb.stream(query)), one.withPermits(1))),
        } satisfies Engine.Implementation;
      }),
    )
    .pipe(Layer.provide(Layer.orDie(layer({ connections: 1 }))));
