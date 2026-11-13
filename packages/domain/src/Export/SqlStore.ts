/**
 * A store over an Effect `SqlClient` speaking Postgres (Neon, PlanetScale),
 * MySQL (and Vitess: PlanetScale), SQLite (libSQL, Turso; D1 and Durable
 * Object SQLite speak the same SQL) or ClickHouse; or, given `iceberg`,
 * DuckDB's client (`Export.DuckDb.sqlClient`) with an Iceberg catalog
 * attached (`Export.Iceberg`).
 *
 * Each generation is a table `<name>_v<n>`: one typed column per spec column
 * (`envelope_at`, `_export_lag_ms`, …) for engines to query, the row's JSON
 * exactly as written (`_export_json`) for readers, its identity
 * (`_export_identity`) and its place in the log (`_export_ord`). First write
 * wins on the identity; metadata is carried from the generation a write
 * replaces. Two control tables hold each generation's fingerprint
 * (`_export_generations`) and each table's promoted generation
 * (`_export_promoted`); a view under the stable name points at the promoted
 * generation, or the first one made before any promotion.
 *
 * Postgres, MySQL and SQLite write in a transaction against a unique index on the
 * identity. MySQL keeps text in `utf8mb4_0900_bin` (its default collation ignores
 * case and accents; `utf8mb4_bin` ignores trailing spaces), timestamps as `DATETIME(3)` in UTC, and replaces the
 * stable-name view in one statement; its DDL commits as it runs, so `ensure`
 * and `promote` are idempotent steps rather than one transaction.
 * ClickHouse has neither: a write skips identities already held,
 * every read keeps the first row of each identity (`LIMIT 1 BY`, exact
 * before or after merges), the typed columns are computed by ClickHouse from
 * the JSON (`MATERIALIZED`), and the log position comes from this process
 * (monotonic; across processes, write time orders it).
 *
 * Iceberg has no unique keys, transactions or views either: a write is one
 * `MERGE INTO` (one atomic commit, inserting identities not yet held), the
 * control tables are append-only (the latest row wins), and there is no view
 * under the stable name: `stableName` gives engines the generation to read,
 * and `Export.Iceberg` keeps a catalog view where the catalog has them.
 *
 * Reads keep `Filter.matches` and `Filter.sort` exactly: the part of a filter
 * SQL can evaluate with the same result (comparisons on typed columns whose
 * SQL and JavaScript semantics agree) runs as `WHERE`, and so does an
 * ordering by top-level numbers that are never null (`ORDER BY`, ties in log
 * order); the rest runs here over the rows SQL returns. A read without an
 * ordering pages by keyset on the log order. A lag summary is computed in
 * SQL (window functions) when the whole filter runs there.
 *
 * @module
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import * as DomainFilter from "../Filter.ts";
import { detailOf, isJsonObject, isStatementFault, jsonAt } from "../internal.ts";
import * as Metadata from "./Metadata.ts";
import { columnName, generationName, type Logical, type TableSpec } from "./Spec.ts";
import {
  type EncodedRow,
  type Identity,
  identityKey,
  type Implementation,
  type LagSummary,
  type RawReader,
  type ReadRequest,
  RowDecodeFailed,
  SchemaDrift,
  StatementRejected,
  summarizeLag,
  Unavailable,
} from "./Store.ts";

type Dialect = "postgres" | "mysql" | "sqlite" | "clickhouse" | "iceberg";

/** A stored column: its row path, physical name, logical type, and whether it may hold null. */
interface StoredColumn {
  readonly path: string;
  readonly name: string;
  readonly type: Logical;
}

const ORD = "_export_ord";
const JSON_COLUMN = "_export_json";
const GENERATIONS = "_export_generations";
const PROMOTED = "_export_promoted";
/** A row's identity as one string (`Store.identityKey`): what first-write-wins, carry and `get` look up. */
const IDENTITY = "_export_identity";
/** Rows per keyset page while scanning. */
const SCAN_PAGE = 500;
/** Each lag quantile a summary reports, in hundredths: nearest-rank, as `Store.summarizeLag` computes it. */
const LAG_QUANTILES = [50, 95, 99] as const;

/**
 * `@effect/sql-clickhouse`'s `ClientMethod`, by its public key (a reference
 * is its key): declared here so the store does not load the ClickHouse
 * client for the other dialects.
 */
const ClickhouseClientMethod = Context.Reference(
  "@effect/sql-clickhouse/ClickhouseClient/ClientMethod",
  { defaultValue: (): "command" | "insert" | "query" => "query" },
);

/** Each logical type's column type (Postgres, SQLite); SQLite keeps timestamps and dates as their ISO text, which orders as they do. */
const columnTypeOf = (dialect: Dialect, type: Logical): string => {
  if (dialect === "sqlite") {
    return type._tag === "Int" || type._tag === "Bool"
      ? "INTEGER"
      : type._tag === "Float"
        ? "REAL"
        : "TEXT";
  }
  if (dialect === "iceberg") return icebergTypes[type._tag];
  if (dialect === "mysql") return mysqlTypes[type._tag];
  switch (type._tag) {
    case "Int":
      return "BIGINT";
    case "Float":
      return "DOUBLE PRECISION";
    case "Decimal":
      return "NUMERIC";
    case "Bool":
      return "BOOLEAN";
    case "Timestamp":
      return "TIMESTAMPTZ";
    case "Date":
      return "DATE";
    case "Json":
    case "Array":
      return "JSONB";
    default:
      return "TEXT";
  }
};

/**
 * Each logical type's Iceberg type, as DuckDB writes it. JSON, decimals and
 * bytes keep the text the row's JSON holds them as.
 */
const icebergTypes: Record<Logical["_tag"], string> = {
  String: "VARCHAR",
  Enum: "VARCHAR",
  Int: "BIGINT",
  Float: "DOUBLE",
  Decimal: "VARCHAR",
  Bool: "BOOLEAN",
  Timestamp: "TIMESTAMPTZ",
  Date: "DATE",
  Bytes: "VARCHAR",
  Json: "VARCHAR",
  Array: "VARCHAR",
};

/** MySQL text compared and ordered by its UTF-8 bytes, as the other dialects' binary order. */
const mysqlText = "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin";

/** Each logical type's MySQL column type. `DATETIME(3)` holds UTC (`TIMESTAMP` ends in 2038). */
const mysqlTypes: Record<Logical["_tag"], string> = {
  String: mysqlText,
  Enum: mysqlText,
  Int: "BIGINT",
  Float: "DOUBLE",
  Decimal: mysqlText,
  Bool: "BOOLEAN",
  Timestamp: "DATETIME(3)",
  Date: "DATE",
  Bytes: mysqlText,
  Json: "JSON",
  Array: "JSON",
};

/** A canonical instant (`…T…:…:….sssZ`) as a MySQL `DATETIME(3)` value in UTC. */
export const mysqlDateTime = (iso: string) => iso.slice(0, 23).replace("T", " ");

/** A string literal for ClickHouse DDL, where a stored expression cannot take parameters. */
const clickhouseString = (text: string) =>
  `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/**
 * A ClickHouse column computed from the row's JSON at insert
 * (`MATERIALIZED`): the stored JSON stays the one source of every value.
 */
const clickhouseColumnOf = (column: StoredColumn): string => {
  const at = column.path.split(".").map(clickhouseString).join(", ");
  const text = `JSONExtract(_export_json, ${at}, 'Nullable(String)')`;
  switch (column.type._tag) {
    case "Int":
      return `Nullable(Int64) MATERIALIZED JSONExtract(_export_json, ${at}, 'Nullable(Int64)')`;
    case "Float":
      return `Nullable(Float64) MATERIALIZED JSONExtract(_export_json, ${at}, 'Nullable(Float64)')`;
    case "Bool":
      return `Nullable(Bool) MATERIALIZED JSONExtract(_export_json, ${at}, 'Nullable(Bool)')`;
    case "Timestamp":
      return `Nullable(DateTime64(3, 'UTC')) MATERIALIZED parseDateTime64BestEffortOrNull(${text}, 3, 'UTC')`;
    case "Date":
      return `Nullable(Date32) MATERIALIZED toDate32OrNull(${text})`;
    case "Json":
    case "Array":
      return `String MATERIALIZED JSONExtractRaw(_export_json, ${at})`;
    default:
      return `Nullable(String) MATERIALIZED ${text}`;
  }
};
/** Every column a generation's table types: the spec's, then its metadata. */
const storedColumnsOf = (spec: TableSpec): ReadonlyArray<StoredColumn> => [
  ...spec.columns.map((column) => ({
    path: column.path,
    name: columnName(column.path),
    type: column.type,
  })),
  ...spec.metadata.map((column) => ({
    path: column.path,
    name: columnName(column.path),
    type: column.type,
  })),
];

/** A timestamp as the row's JSON holds it (`DateTime.formatIso`): text order is time order. */
const canonicalInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const canonicalDate = /^\d{4}-\d{2}-\d{2}$/;
/** An ASCII operand compares the same in UTF-8 byte order (SQL) and UTF-16 code unit order (JavaScript). */
const isAscii = (text: string) =>
  Array.from(text).every((character) => (character.codePointAt(0) ?? 0) < 0x80);

const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject));

/** Where an Iceberg store's tables live: the attached catalog's alias, and the namespace. */
export interface IcebergPlacement {
  /** The alias the catalog is attached under in DuckDB. */
  readonly catalog: string;
  /** The catalog namespace holding the tables. */
  readonly namespace: string;
}

/** How `Export.Sql.store` names itself, and where an Iceberg store's tables live. */
export interface StoreOptions {
  /**
   * The store's name in its errors.
   * @default "sql" ("iceberg" given `iceberg`)
   */
  readonly name?: string;
  /** Write to an Iceberg catalog DuckDB attached (`Export.Iceberg.store` passes it). */
  readonly iceberg?: IcebergPlacement | undefined;
}

/**
 * A store on the `SqlClient` in context: Postgres, MySQL, SQLite or
 * ClickHouse; given `iceberg`, the client is DuckDB's, with the catalog
 * attached. Fails to build on a client of another dialect. A failed
 * statement is `Unavailable` when its reason may pass (a connection,
 * credentials, a deadlock, a timeout) and a `StatementRejected` defect when
 * it cannot (a syntax error, a violated constraint).
 *
 * ### Exporting to Postgres
 * **Example:** A store on a Postgres client
 * ```typescript
 * import * as Export from "@alchemy.run/domain/Export";
 * import { PgClient } from "@effect/sql-pg";
 * import * as Layer from "effect/Layer";
 *
 * export const WarehouseLive = Warehouse.toLayer(Export.Sql.store()).pipe(
 *   Layer.provide(PgClient.layer({ url })),
 * );
 * ```
 *
 * ### Exporting to MySQL
 * **Example:** A client that reads `DATETIME` as UTC, as the store writes it
 * ```typescript
 * import { MysqlClient } from "@effect/sql-mysql2";
 *
 * export const WarehouseLive = Warehouse.toLayer(Export.Sql.store()).pipe(
 *   Layer.provide(MysqlClient.layer({ url, poolConfig: { timezone: "Z" } })),
 * );
 * ```
 *
 * @layer
 * @title Sql.store
 * @provides Export.Store.Implementation
 */
export const store = (
  options: StoreOptions = {},
): Effect.Effect<Implementation, Unavailable, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const storeName = options.name ?? (options.iceberg === undefined ? "sql" : "iceberg");
    const iceberg = options.iceberg;
    const dialect: Dialect | undefined =
      iceberg !== undefined
        ? "iceberg"
        : sql.onDialectOrElse({
            pg: () => "postgres" as const,
            mysql: () => "mysql" as const,
            sqlite: () => "sqlite" as const,
            clickhouse: () => "clickhouse" as const,
            orElse: () => undefined,
          });
    if (dialect === undefined) {
      return yield* new Unavailable({
        store: storeName,
        operation: "ensure",
        reason: "Export.Sql.store supports Postgres, MySQL, SQLite and ClickHouse clients",
      });
    }
    const isClickhouse = dialect === "clickhouse";
    const isIceberg = dialect === "iceberg";
    /** No unique keys: first-write-wins is kept here, and control rows are appended (the latest wins). */
    const appendOnly = isClickhouse || isIceberg;
    /** A table's name where its generations live: qualified by catalog and namespace in Iceberg. */
    const qualify = (name: string) =>
      iceberg === undefined ? name : `${iceberg.catalog}.${iceberg.namespace}.${name}`;
    const table = (name: string) => sql(qualify(name));
    /** A transaction where the dialect has them; an append-only write instead never needs to roll back. */
    const transactional = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      appendOnly ? effect : sql.withTransaction(effect);
    /** In ClickHouse, a statement that returns no rows (DDL, `INSERT`) runs as a command, not a query. */
    const command = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      isClickhouse ? Effect.provideService(effect, ClickhouseClientMethod, "command") : effect;
    /** The next log position for an append-only dialect: monotonic in this process, below 2^53. */
    let lastOrd = 0;
    const nextOrd = Effect.map(
      Clock.currentTimeMillis,
      (now) => (lastOrd = Math.max(lastOrd + 1, now * 1000)),
    );
    /**
     * A SQL failure as the store reports it: a statement the database refuses
     * for good (a syntax error, a violated constraint) is a defect,
     * `StatementRejected`; every other reason may pass, `Unavailable`.
     */
    const failed = (operation: Unavailable["operation"]) => (cause: SqlError) =>
      isStatementFault(cause)
        ? Effect.die(
            new StatementRejected({
              store: storeName,
              operation,
              code: cause.reason._tag,
              detail: detailOf(cause),
            }),
          )
        : Effect.fail(
            new Unavailable({
              store: storeName,
              operation,
              reason: `${cause.reason._tag}: ${detailOf(cause)}`,
            }),
          );

    // ---------------------------------------------------------------- predicates

    const TRUE = sql.literal(dialect === "postgres" || isIceberg ? "TRUE" : "1");
    const FALSE = sql.literal(dialect === "postgres" || isIceberg ? "FALSE" : "0");
    const and = (parts: ReadonlyArray<Statement.Fragment>) =>
      parts.length === 0 ? TRUE : sql.and(parts);
    const or = (parts: ReadonlyArray<Statement.Fragment>) =>
      parts.length === 0 ? FALSE : sql.or(parts);
    /** SQL's unknown (a comparison with NULL) is false, as `Filter.matches` has it, so `NOT` and `OR` keep their meaning. */
    const twoValued = (predicate: Statement.Fragment) => sql`COALESCE((${predicate}), ${FALSE})`;
    const not = (predicate: Statement.Fragment) => sql`NOT (${predicate})`;
    /** A timestamp or date operand, cast where the column is typed. */
    const temporal = (type: "Timestamp" | "Date", operand: string) =>
      dialect === "sqlite"
        ? sql`${operand}`
        : dialect === "mysql"
          ? sql`${type === "Timestamp" ? mysqlDateTime(operand) : operand}`
          : dialect === "clickhouse"
            ? type === "Timestamp"
              ? sql`parseDateTime64BestEffort(${operand}, 3, 'UTC')`
              : sql`toDate32(${operand})`
            : type === "Timestamp"
              ? sql`${operand}::timestamptz`
              : sql`${operand}::date`;

    /** `Filter.matches`' equality with one scalar, or `undefined` when SQL cannot say the same. */
    const equal = (column: StoredColumn, operand: unknown): Statement.Fragment | undefined => {
      const id = sql(column.name);
      const type = column.type._tag;
      if (type === "Json" || type === "Array" || type === "Decimal") return undefined;
      if (typeof operand === "string") {
        if (type === "String" || type === "Enum" || type === "Bytes")
          return twoValued(sql`${id} = ${operand}`);
        if (type === "Timestamp")
          return canonicalInstant.test(operand)
            ? twoValued(sql`${id} = ${temporal(type, operand)}`)
            : FALSE;
        if (type === "Date")
          return canonicalDate.test(operand)
            ? twoValued(sql`${id} = ${temporal(type, operand)}`)
            : FALSE;
        return FALSE;
      }
      if (typeof operand === "number")
        return type === "Int" || type === "Float" ? twoValued(sql`${id} = ${operand}`) : FALSE;
      if (typeof operand === "boolean") {
        return type === "Bool"
          ? twoValued(sql`${id} = ${dialect === "sqlite" ? Number(operand) : operand}`)
          : FALSE;
      }
      return undefined;
    };

    /** `Filter.matches`' `lt`/`lte`/`gt`/`gte`, where SQL orders as JavaScript does. */
    const compare = (
      column: StoredColumn,
      op: "<" | "<=" | ">" | ">=",
      operand: unknown,
    ): Statement.Fragment | undefined => {
      const id = sql(column.name);
      const type = column.type._tag;
      const symbol = sql.literal(op);
      if (typeof operand === "number" && (type === "Int" || type === "Float"))
        return twoValued(sql`${id} ${symbol} ${operand}`);
      if (typeof operand !== "string") return undefined;
      if ((type === "String" || type === "Enum") && isAscii(operand)) {
        return twoValued(
          dialect === "postgres"
            ? sql`${id} COLLATE "C" ${symbol} ${operand}`
            : sql`${id} ${symbol} ${operand}`,
        );
      }
      if (type === "Timestamp" && canonicalInstant.test(operand))
        return twoValued(sql`${id} ${symbol} ${temporal(type, operand)}`);
      if (type === "Date" && canonicalDate.test(operand))
        return twoValued(sql`${id} ${symbol} ${temporal(type, operand)}`);
      return undefined;
    };

    /** `contains`, `startsWith` and `endsWith`: case-sensitive, by characters. */
    const text = (
      column: StoredColumn,
      op: "contains" | "startsWith" | "endsWith",
      operand: unknown,
    ): Statement.Fragment | undefined => {
      if (
        typeof operand !== "string" ||
        (column.type._tag !== "String" && column.type._tag !== "Enum")
      )
        return undefined;
      const id = sql(column.name);
      if (operand === "") return sql`${id} IS NOT NULL`;
      const value = dialect === "postgres" || isIceberg ? sql`${operand}::text` : sql`${operand}`;
      const predicate =
        dialect === "clickhouse"
          ? op === "contains"
            ? sql`position(${id}, ${value}) > 0`
            : op === "startsWith"
              ? sql`startsWith(${id}, ${value})`
              : sql`endsWith(${id}, ${value})`
          : dialect === "mysql"
            ? op === "contains"
              ? sql`LOCATE(${value}, ${id}) > 0`
              : op === "startsWith"
                ? sql`LEFT(${id}, CHAR_LENGTH(${value})) = ${value}`
                : sql`RIGHT(${id}, CHAR_LENGTH(${value})) = ${value}`
            : op === "contains"
              ? dialect === "postgres" || isIceberg
                ? sql`strpos(${id}, ${value}) > 0`
                : sql`instr(${id}, ${value}) > 0`
              : op === "startsWith"
                ? dialect === "postgres" || isIceberg
                  ? sql`left(${id}, length(${value})) = ${value}`
                  : sql`substr(${id}, 1, length(${value})) = ${value}`
                : dialect === "postgres" || isIceberg
                  ? sql`right(${id}, length(${value})) = ${value}`
                  : sql`substr(${id}, -length(${value})) = ${value}`;
      return twoValued(predicate);
    };

    const allDefined = (
      parts: ReadonlyArray<Statement.Fragment | undefined>,
    ): parts is ReadonlyArray<Statement.Fragment> => parts.every((part) => part !== undefined);

    const operator = (
      column: StoredColumn,
      op: string,
      operand: unknown,
    ): Statement.Fragment | undefined => {
      const id = sql(column.name);
      const isScalar = operand === null || typeof operand !== "object";
      switch (op) {
        case "equals":
          return operand === null
            ? sql`${id} IS NULL`
            : isScalar
              ? equal(column, operand)
              : undefined;
        case "not": {
          if (operand === null) return sql`${id} IS NOT NULL`;
          const equalTo = isScalar ? equal(column, operand) : undefined;
          return equalTo === undefined ? undefined : not(equalTo);
        }
        case "in":
        case "notIn": {
          if (!Array.isArray(operand)) return undefined;
          const parts = operand.map((item) =>
            item === null
              ? sql`${id} IS NULL`
              : typeof item === "object"
                ? undefined
                : equal(column, item),
          );
          if (!allDefined(parts)) return undefined;
          return op === "in" ? or(parts) : not(or(parts));
        }
        case "lt":
          return compare(column, "<", operand);
        case "lte":
          return compare(column, "<=", operand);
        case "gt":
          return compare(column, ">", operand);
        case "gte":
          return compare(column, ">=", operand);
        case "contains":
        case "startsWith":
        case "endsWith":
          return text(column, op, operand);
        default:
          return undefined;
      }
    };

    /** One column's filter, as `matchesField` reads it. */
    const field = (column: StoredColumn, filter: unknown): Statement.Fragment | undefined => {
      if (filter === null) return sql`${sql(column.name)} IS NULL`;
      if (DomainFilter.isOperatorObject(filter)) {
        const parts = Object.entries(filter)
          .filter(([, operand]) => operand !== undefined)
          .map(([op, operand]) => operator(column, op, operand));
        return allDefined(parts) ? and(parts) : undefined;
      }
      return typeof filter === "object" ? undefined : equal(column, filter);
    };

    /** A whole filter over the row's fields below `prefix`, or `undefined` unless all of it translates. */
    const translator = (columns: ReadonlyMap<string, StoredColumn>) => {
      const isPrefix = (path: string) =>
        [...columns.keys()].some((name) => name.startsWith(`${path}.`));
      const entry = (path: string, operand: unknown): Statement.Fragment | undefined => {
        const column = columns.get(path);
        if (column !== undefined) return field(column, operand);
        // A nested filter over a struct the table stores flattened (`envelope`).
        return Predicate.isObject(operand) &&
          !DomainFilter.isOperatorObject(operand) &&
          isPrefix(path)
          ? filterAt(`${path}.`, operand)
          : undefined;
      };
      const filterAt = (
        prefix: string,
        filter: Record<string, unknown>,
      ): Statement.Fragment | undefined => {
        const parts = Object.entries(filter)
          .filter(([, operand]) => operand !== undefined)
          .map(([key, operand]) => {
            if (key === "AND" || key === "OR") {
              if (!Array.isArray(operand)) return undefined;
              const children = operand.map((child) =>
                isJsonObject(child) ? filterAt(prefix, child) : undefined,
              );
              return allDefined(children)
                ? key === "AND"
                  ? and(children)
                  : or(children)
                : undefined;
            }
            if (key === "NOT") {
              const child = Predicate.isObject(operand) ? filterAt(prefix, operand) : undefined;
              return child === undefined ? undefined : not(child);
            }
            return entry(`${prefix}${key}`, operand);
          });
        return allDefined(parts) ? and(parts) : undefined;
      };
      /** Split a filter: the top-level conditions SQL evaluates exactly, and the rest for `Filter.matches`. */
      return (where: ReadRequest["where"]) => {
        const pushed: Array<Statement.Fragment> = [];
        const kept: Array<readonly [string, unknown]> = [];
        for (const [key, operand] of Object.entries(where ?? {})) {
          if (operand === undefined) continue;
          const translated = filterAt("", { [key]: operand });
          if (translated === undefined) kept.push([key, operand]);
          else pushed.push(translated);
        }
        // A cast: some of a Filter's own top-level conditions, unchanged, are still a Filter of the same rows.
        const residual =
          kept.length === 0
            ? undefined
            : (Object.fromEntries(kept) as DomainFilter.Filter<Schema.JsonObject>);
        return { pushed, residual };
      };
    };

    // ---------------------------------------------------------------- control

    const ensureControl = isClickhouse
      ? Effect.all(
          [
            command(
              sql`CREATE TABLE IF NOT EXISTS ${table(GENERATIONS)} (generation String, fingerprint String, ord UInt64) ENGINE = MergeTree ORDER BY (generation, ord)`,
            ),
            command(
              sql`CREATE TABLE IF NOT EXISTS ${table(PROMOTED)} (name String, generation String, ord UInt64) ENGINE = MergeTree ORDER BY (name, ord)`,
            ),
          ],
          { discard: true },
        )
      : isIceberg
        ? Effect.all(
            [
              sql`CREATE SCHEMA IF NOT EXISTS ${sql(`${iceberg!.catalog}.${iceberg!.namespace}`)}`,
              sql`CREATE TABLE IF NOT EXISTS ${table(GENERATIONS)} (generation VARCHAR, fingerprint VARCHAR, ord BIGINT)`,
              sql`CREATE TABLE IF NOT EXISTS ${table(PROMOTED)} (name VARCHAR, generation VARCHAR, ord BIGINT)`,
            ],
            { discard: true },
          )
        : dialect === "mysql"
          ? Effect.all(
              [
                sql`CREATE TABLE IF NOT EXISTS ${table(GENERATIONS)} (generation VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PRIMARY KEY, fingerprint TEXT NOT NULL)`,
                sql`CREATE TABLE IF NOT EXISTS ${table(PROMOTED)} (name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin PRIMARY KEY, generation VARCHAR(255) NOT NULL)`,
              ],
              { discard: true },
            )
          : Effect.all(
              [
                sql`CREATE TABLE IF NOT EXISTS ${table(GENERATIONS)} (generation TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)`,
                sql`CREATE TABLE IF NOT EXISTS ${table(PROMOTED)} (name TEXT PRIMARY KEY, generation TEXT NOT NULL)`,
              ],
              { discard: true },
            );

    /** The generation promoted for the table, if any; when append-only, the latest promotion. */
    const promotedOf = (spec: TableSpec) =>
      (appendOnly
        ? sql<{
            readonly generation: string;
          }>`SELECT generation FROM ${table(PROMOTED)} WHERE name = ${spec.name} ORDER BY ord DESC LIMIT 1`
        : sql<{
            readonly generation: string;
          }>`SELECT generation FROM ${table(PROMOTED)} WHERE name = ${spec.name}`
      ).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]?.generation)));

    const viewExists = (name: string) =>
      dialect === "postgres"
        ? sql<{
            readonly present: boolean;
          }>`SELECT to_regclass(quote_ident(${name})) IS NOT NULL AS present`.pipe(
            Effect.map((rows) => rows[0]?.present === true),
          )
        : dialect === "mysql"
          ? sql<{
              readonly present: number | string;
            }>`SELECT count(*) AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ${name}`.pipe(
              Effect.map((rows) => Number(rows[0]?.present) > 0),
            )
          : dialect === "clickhouse"
            ? sql<{
                readonly present: number | string;
              }>`SELECT count() AS present FROM system.tables WHERE database = currentDatabase() AND name = ${name}`.pipe(
                Effect.map((rows) => Number(rows[0]?.present) > 0),
              )
            : sql<{
                readonly present: number;
              }>`SELECT count(*) AS present FROM sqlite_master WHERE name = ${name}`.pipe(
                Effect.map((rows) => Number(rows[0]?.present) > 0),
              );

    /**
     * A generation's rows as readers see them. In ClickHouse, the first row of
     * each identity, with the typed columns a filter may name (a computed
     * column is not in `SELECT *`).
     */
    const rowsOf = (generation: string, columns: ReadonlyArray<StoredColumn>) =>
      isClickhouse
        ? sql`(SELECT ${sql.csv([
            sql`${sql(ORD)}`,
            ...columns.map((column) => sql`${sql(column.name)}`),
            sql`${sql(IDENTITY)}`,
            sql`${sql(JSON_COLUMN)}`,
          ])} FROM ${table(generation)} ORDER BY ${sql.literal(ORD)} LIMIT 1 BY ${sql.literal(IDENTITY)})`
        : sql`${table(generation)}`;

    /** Point the stable name at a generation. Iceberg keeps no view here (see `stableName`). */
    const pointView = (name: string, generation: string, columns: ReadonlyArray<StoredColumn>) =>
      isIceberg
        ? Effect.void
        : dialect === "mysql"
          ? sql`CREATE OR REPLACE VIEW ${sql(name)} AS SELECT * FROM ${sql(generation)}`
          : isClickhouse
            ? command(
                sql`CREATE OR REPLACE VIEW ${sql(name)} AS SELECT * FROM ${rowsOf(generation, columns)}`,
              )
            : Effect.andThen(
                sql`DROP VIEW IF EXISTS ${sql(name)}`,
                sql`CREATE VIEW ${sql(name)} AS SELECT * FROM ${sql(generation)}`,
              );

    // ---------------------------------------------------------------- rows

    const valueOf = (column: StoredColumn, row: Schema.JsonObject): unknown => {
      const value = jsonAt(row, column.path) ?? null;
      if (value === null) return null;
      if (column.type._tag === "Timestamp" && dialect === "mysql" && typeof value === "string")
        return mysqlDateTime(value);
      if (column.type._tag === "Json" || column.type._tag === "Array") return JSON.stringify(value);
      if (column.type._tag === "Bool" && dialect === "sqlite") return value === true ? 1 : 0;
      return value;
    };

    /** A row's identity; every row the table writes carries its key, route and envelope. */
    const identityOf = (row: Schema.JsonObject): Identity => {
      const key = jsonAt(row, "key");
      const route = jsonAt(row, "route");
      const stream = jsonAt(row, "envelope.stream");
      const seq = jsonAt(row, "envelope.seq");
      return {
        key: typeof key === "string" ? key : "",
        route: typeof route === "string" ? route : undefined,
        stream: typeof stream === "string" ? stream : "",
        seq: typeof seq === "number" ? seq : Number.NaN,
      };
    };

    /**
     * Rows of a generation: the `WHERE` parts, after a log position, in `order`
     * then log order, skipping `offset` rows, at most `limit`.
     */
    const select = (
      generation: string,
      where: ReadonlyArray<Statement.Fragment>,
      after: number | undefined,
      limit: number | undefined,
      columns: ReadonlyArray<StoredColumn> = [],
      order: ReadonlyArray<Statement.Fragment> = [],
      offset = 0,
    ) =>
      sql<{
        readonly ord: number | string;
        readonly json: string;
      }>`SELECT ${sql(ORD)} AS ord, ${sql(JSON_COLUMN)} AS json FROM ${rowsOf(generation, columns)} WHERE ${and(
        [...where, ...(after === undefined ? [] : [sql`${sql(ORD)} > ${after}`])],
      )} ORDER BY ${sql.csv([...order, sql`${sql(ORD)}`])}${sql.literal(
        (limit === undefined ? "" : ` LIMIT ${limit}`) + (offset === 0 ? "" : ` OFFSET ${offset}`),
      )}`.pipe(
        Effect.flatMap(
          Effect.forEach(({ ord, json }) =>
            decodeStored(json).pipe(
              Effect.map((row) => ({ ord: Number(ord), row })),
              Effect.orDie,
            ),
          ),
        ),
      );

    /** `ceil(q / 100 × n)` in SQL's integers, for a count `n` the query names: the dialect's integer division. */
    const rankAt = (q: number) =>
      sql.literal(
        dialect === "mysql"
          ? `(n * ${q} + 99) DIV 100`
          : isClickhouse
            ? `intDiv(n * ${q} + 99, 100)`
            : isIceberg
              ? `(n * ${q} + 99) // 100`
              : `(n * ${q} + 99) / 100`,
      );

    return {
      stableName: isIceberg
        ? (spec) =>
            promotedOf(spec).pipe(
              Effect.map((promoted) =>
                qualify(Option.getOrElse(promoted, () => generationName(spec))),
              ),
              Effect.catchTag("SqlError", failed("read")),
            )
        : undefined,
      // Every method works on the spec it is given, as the memory store does: one target serves any generation.
      target: () => ({
        ensure: (spec) =>
          Effect.gen(function* () {
            const own = generationName(spec);
            const columns = storedColumnsOf(spec);
            yield* ensureControl;
            if (appendOnly) {
              // No unique keys: the first fingerprint recorded for a generation is its own.
              const [recorded] = yield* sql<{
                readonly n: number | string;
              }>`SELECT count(*) AS n FROM ${table(GENERATIONS)} WHERE generation = ${own}`;
              if (Number(recorded?.n ?? 0) === 0)
                yield* command(
                  isClickhouse
                    ? sql`INSERT INTO ${table(GENERATIONS)} (generation, fingerprint, ord) SELECT ${own}, ${spec.fingerprint}, toUInt64(${yield* nextOrd})`
                    : sql`INSERT INTO ${table(GENERATIONS)} (generation, fingerprint, ord) VALUES (${own}, ${spec.fingerprint}, ${yield* nextOrd})`,
                );
            } else {
              yield* dialect === "mysql"
                ? sql`INSERT INTO ${table(GENERATIONS)} (generation, fingerprint) VALUES (${own}, ${spec.fingerprint}) ON DUPLICATE KEY UPDATE generation = generation`
                : sql`INSERT INTO ${table(GENERATIONS)} (generation, fingerprint) VALUES (${own}, ${spec.fingerprint}) ON CONFLICT (generation) DO NOTHING`;
            }
            const [held] = yield* sql<{
              readonly fingerprint: string;
            }>`SELECT fingerprint FROM ${table(GENERATIONS)} WHERE generation = ${own}${sql.literal(appendOnly ? " ORDER BY ord LIMIT 1" : "")}`;
            if (held !== undefined && held.fingerprint !== spec.fingerprint) {
              return yield* new SchemaDrift({
                store: storeName,
                table: spec.table,
                generation: spec.generation,
                breaking: ["the table's columns or metadata"],
              });
            }
            if (isClickhouse) {
              const definitions = [
                sql`${sql(ORD)} UInt64`,
                ...columns.map(
                  (column) => sql`${sql(column.name)} ${sql.literal(clickhouseColumnOf(column))}`,
                ),
                sql`${sql(IDENTITY)} String`,
                sql`${sql(JSON_COLUMN)} String`,
              ];
              yield* command(
                sql`CREATE TABLE IF NOT EXISTS ${table(own)} (${sql.csv(definitions)}) ENGINE = MergeTree ORDER BY ${sql.literal(ORD)}`,
              );
            } else if (isIceberg) {
              const definitions = [
                sql`${sql(ORD)} BIGINT`,
                ...columns.map(
                  (column) =>
                    sql`${sql(column.name)} ${sql.literal(columnTypeOf(dialect, column.type))}`,
                ),
                sql`${sql(IDENTITY)} VARCHAR`,
                sql`${sql(JSON_COLUMN)} VARCHAR`,
              ];
              yield* sql`CREATE TABLE IF NOT EXISTS ${table(own)} (${sql.csv(definitions)})`;
            } else {
              const ord =
                dialect === "postgres"
                  ? "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
                  : dialect === "mysql"
                    ? "BIGINT AUTO_INCREMENT PRIMARY KEY"
                    : "INTEGER PRIMARY KEY AUTOINCREMENT";
              const definitions = [
                sql`${sql(ORD)} ${sql.literal(ord)}`,
                ...columns.map(
                  (column) =>
                    sql`${sql(column.name)} ${sql.literal(columnTypeOf(dialect, column.type))}`,
                ),
                // A key MySQL can index (a TEXT cannot be one); the identity's JSON is far shorter.
                dialect === "mysql"
                  ? sql`${sql(IDENTITY)} VARCHAR(768) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL UNIQUE`
                  : sql`${sql(IDENTITY)} TEXT NOT NULL`,
                dialect === "mysql"
                  ? sql`${sql(JSON_COLUMN)} LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL`
                  : sql`${sql(JSON_COLUMN)} TEXT NOT NULL`,
              ];
              yield* sql`CREATE TABLE IF NOT EXISTS ${table(own)} (${sql.csv(definitions)})`;
              // MySQL has no `CREATE INDEX IF NOT EXISTS`: its key is declared with the column.
              if (dialect !== "mysql")
                yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS ${sql(`${own}_identity`)} ON ${table(own)} (${sql(IDENTITY)})`;
            }
            // Before any promotion, the stable name shows the first generation made.
            if (
              !isIceberg &&
              Option.isNone(yield* promotedOf(spec)) &&
              !(yield* viewExists(spec.name))
            )
              yield* pointView(spec.name, own, columns);
          }).pipe(transactional, Effect.catchTag("SqlError", failed("ensure"))),
        write: (spec, run) =>
          Effect.gen(function* () {
            const own = generationName(spec);
            const columns = storedColumnsOf(spec);
            const rows = run.rows.filter(isJsonObject);
            if (rows.length !== run.rows.length)
              return yield* Effect.die(
                new RowDecodeFailed({ table: spec.table, issue: "a row is not a JSON object" }),
              );
            if (rows.length === 0) return;
            // Writing into a generation that replaces the promoted one: carry each row's run values from there.
            const replaced = Option.filter(
              yield* promotedOf(spec),
              (generation) => generation !== own,
            );
            const previous = new Map<string, Schema.JsonObject>();
            if (Option.isSome(replaced)) {
              const held = yield* select(
                replaced.value,
                [
                  sql`${sql(IDENTITY)} IN ${sql.in(rows.map((row) => identityKey(identityOf(row))))}`,
                ],
                undefined,
                undefined,
              );
              for (const { row } of held) previous.set(identityKey(identityOf(row)), row);
            }
            const prepared = rows.map((row) => {
              const identity = identityKey(identityOf(row));
              const stored: Schema.JsonObject = Object.assign(
                {},
                row,
                Metadata.evaluate(spec.metadata, row, run, previous.get(identity)),
              );
              return { identity, stored };
            });
            // First write wins without a unique key: one row per identity in the run.
            const unique = prepared.filter(
              (entry, index) =>
                prepared.findIndex((other) => other.identity === entry.identity) === index,
            );
            if (isIceberg) {
              // One commit inserting the identities the generation does not hold.
              const values = yield* Effect.forEach(unique, (entry) =>
                Effect.map(
                  nextOrd,
                  (ord) =>
                    sql`(${sql.csv([
                      sql`CAST(${ord} AS BIGINT)`,
                      ...columns.map(
                        (column) =>
                          sql`CAST(${valueOf(column, entry.stored)} AS ${sql.literal(columnTypeOf(dialect, column.type))})`,
                      ),
                      sql`${entry.identity}`,
                      sql`${JSON.stringify(entry.stored)}`,
                    ])})`,
                ),
              );
              const names = [ORD, ...columns.map((column) => column.name), IDENTITY, JSON_COLUMN];
              yield* sql`MERGE INTO ${table(own)} AS t USING (SELECT * FROM (VALUES ${sql.csv(values)}) AS v(${sql.csv(names.map((name) => sql`${sql(name)}`))})) AS s ON (s.${sql(IDENTITY)} = t.${sql(IDENTITY)}) WHEN NOT MATCHED THEN INSERT`;
              return;
            }
            if (isClickhouse) {
              // Skip what the generation holds.
              const held = new Set(
                (yield* select(
                  own,
                  [sql`${sql(IDENTITY)} IN ${sql.in(unique.map((entry) => entry.identity))}`],
                  undefined,
                  undefined,
                )).map(({ row }) => identityKey(identityOf(row))),
              );
              const fresh = unique.filter((entry) => !held.has(entry.identity));
              if (fresh.length === 0) return;
              const selects = yield* Effect.forEach(fresh, (entry) =>
                Effect.map(
                  nextOrd,
                  (ord) =>
                    sql`SELECT toUInt64(${ord}), ${entry.identity}, ${JSON.stringify(entry.stored)}`,
                ),
              );
              yield* command(
                sql`INSERT INTO ${table(own)} (${sql(ORD)}, ${sql(IDENTITY)}, ${sql(JSON_COLUMN)}) ${sql.join(" UNION ALL ", false)(selects)}`,
              );
              return;
            }
            const [first, ...rest] = prepared.map(({ identity, stored }) => ({
              ...Object.fromEntries(
                columns.map((column) => [column.name, valueOf(column, stored)]),
              ),
              [IDENTITY]: identity,
              [JSON_COLUMN]: JSON.stringify(stored),
            }));
            if (first === undefined) return;
            // Rows take log positions in run order; a row already held keeps its first write.
            yield* dialect === "mysql"
              ? sql`INSERT INTO ${table(own)} ${sql.insert([first, ...rest])} ON DUPLICATE KEY UPDATE ${sql(IDENTITY)} = ${sql(IDENTITY)}`
              : sql`INSERT INTO ${table(own)} ${sql.insert([first, ...rest])} ON CONFLICT (${sql(IDENTITY)}) DO NOTHING`;
          }).pipe(transactional, Effect.catchTag("SqlError", failed("write"))),
        promote: (spec) =>
          Effect.gen(function* () {
            const own = generationName(spec);
            if (isClickhouse)
              yield* command(
                sql`INSERT INTO ${table(PROMOTED)} (name, generation, ord) SELECT ${spec.name}, ${own}, toUInt64(${yield* nextOrd})`,
              );
            else if (isIceberg)
              yield* sql`INSERT INTO ${table(PROMOTED)} (name, generation, ord) VALUES (${spec.name}, ${own}, ${yield* nextOrd})`;
            else if (dialect === "mysql")
              yield* sql`INSERT INTO ${table(PROMOTED)} (name, generation) VALUES (${spec.name}, ${own}) AS promoted ON DUPLICATE KEY UPDATE generation = promoted.generation`;
            else
              yield* sql`INSERT INTO ${table(PROMOTED)} (name, generation) VALUES (${spec.name}, ${own}) ON CONFLICT (name) DO UPDATE SET generation = excluded.generation`;
            yield* pointView(spec.name, own, storedColumnsOf(spec));
          }).pipe(transactional, Effect.catchTag("SqlError", failed("promote"))),
      }),
      reader: (spec) => {
        const columns = storedColumnsOf(spec);
        const split = translator(new Map(columns.map((column) => [column.path, column])));
        /** What readers see: the promoted generation, or the spec's own before any promotion. */
        const visible = promotedOf(spec).pipe(
          Effect.map(Option.getOrElse(() => generationName(spec))),
        );
        /**
         * The columns SQL orders exactly as `Filter.sort` does: top-level
         * numbers that are never null. `Filter.sort` compares with
         * JavaScript's `<`, under which a null equals every string and is 0
         * beside a number, and text compares by UTF-16 code units, which no
         * SQL collation shares; those orderings stay here.
         */
        const orderable = new Set(
          spec.columns
            .filter(
              (column) =>
                !column.path.includes(".") &&
                !column.nullable &&
                (column.type._tag === "Int" || column.type._tag === "Float"),
            )
            .map((column) => column.path),
        );
        /**
         * The request's `orderBy` as SQL, or `undefined` when SQL could order
         * otherwise. Ties keep log order, as `Filter.sort` (a stable sort of
         * rows in log order) does.
         */
        const orderOf = (orderBy: ReadRequest["orderBy"]) => {
          const order: Array<Statement.Fragment> = [];
          for (const [path, direction] of Object.entries(orderBy ?? {})) {
            if (!orderable.has(path)) return undefined;
            order.push(
              sql`${sql(columnName(path))} ${sql.literal(direction === "desc" ? "DESC" : "ASC")}`,
            );
          }
          return order;
        };
        /** Every row a request selects, in its order: SQL's part of the filter, then the rest and the order here. */
        const everyRow = (request: ReadRequest) =>
          Effect.gen(function* () {
            const { pushed, residual } = split(request.where);
            const rows = (yield* select(yield* visible, pushed, undefined, undefined, columns)).map(
              ({ row }) => row,
            );
            return DomainFilter.sort(
              rows.filter((row) => DomainFilter.matches(residual, row)),
              request.orderBy,
            );
          });
        /**
         * The lag summary SQL computes over the rows `pushed` selects: the
         * count, and the lag at each nearest rank (the first, each quantile's,
         * the last), at most five rows back.
         */
        const lagInSql = (pushed: ReadonlyArray<Statement.Fragment>) =>
          Effect.gen(function* () {
            const lag = sql(Metadata.lagColumn);
            // `lag_ms`, not `lag`: LAG is a reserved word in MySQL 8.
            const ranked = sql`SELECT ${lag} AS lag_ms, ROW_NUMBER() OVER (ORDER BY ${lag}) AS rn, COUNT(*) OVER () AS n FROM ${rowsOf(
              yield* visible,
              columns,
            )} WHERE ${and([...pushed, sql`${lag} IS NOT NULL`])}`;
            const ranks = yield* sql<{
              readonly lag_ms: number | string;
              readonly rn: number | string;
              readonly n: number | string;
            }>`SELECT lag_ms, rn, n FROM (${ranked}) ranked WHERE ${or([
              sql`rn = 1`,
              sql`rn = n`,
              ...LAG_QUANTILES.map((q) => sql`rn = ${rankAt(q)}`),
            ])}`;
            // A BIGINT may come back as text.
            const count = Number(ranks[0]?.n ?? 0);
            const at = (rank: number) => {
              const found = ranks.find((row) => Number(row.rn) === rank);
              return found === undefined ? null : Number(found.lag_ms);
            };
            const [p50, p95, p99] = LAG_QUANTILES.map((q) =>
              at(Math.floor((count * q + 99) / 100)),
            );
            return {
              count,
              min: at(1),
              p50: p50 ?? null,
              p95: p95 ?? null,
              p99: p99 ?? null,
              max: at(count),
            } satisfies LagSummary;
          });
        return {
          get: (identity) =>
            Effect.gen(function* () {
              const [found] = yield* select(
                yield* visible,
                [sql`${sql(IDENTITY)} = ${identityKey(identity)}`],
                undefined,
                1,
                columns,
              );
              return Option.map(Option.fromNullishOr(found), ({ row }): EncodedRow => row);
            }).pipe(Effect.catchTag("SqlError", failed("read"))),
          list: (request, { after, take }) =>
            Effect.gen(function* () {
              const { pushed, residual } = split(request.where);
              const order = orderOf(request.orderBy);
              if (residual === undefined && order !== undefined && order.length === 0) {
                // Keyset on the log order: the cursor is the last row's position.
                const page = yield* select(
                  yield* visible,
                  pushed,
                  after === undefined ? undefined : Number(after),
                  take + 1,
                  columns,
                );
                const entries = page.slice(0, take);
                const last = entries[entries.length - 1];
                return {
                  entries: entries.map(({ row }): EncodedRow => row),
                  cursor: page.length > take && last !== undefined ? String(last.ord) : null,
                };
              }
              // Ordered: the cursor is an offset into the selection, which SQL pages when it
              // filters and orders the whole of it.
              const start = after === undefined ? 0 : Number(after);
              if (residual === undefined && order !== undefined) {
                const page = yield* select(
                  yield* visible,
                  pushed,
                  undefined,
                  take + 1,
                  columns,
                  order,
                  start,
                );
                return {
                  entries: page.slice(0, take).map(({ row }): EncodedRow => row),
                  cursor: page.length > take ? String(start + take) : null,
                };
              }
              // Filtered or ordered here: page the whole selection.
              const rows = yield* everyRow(request);
              return {
                entries: rows.slice(start, start + take),
                cursor: start + take < rows.length ? String(start + take) : null,
              };
            }).pipe(Effect.catchTag("SqlError", failed("read"))),
          scan: (request) => {
            const { pushed, residual } = split(request.where);
            const order = orderOf(request.orderBy);
            if (order === undefined)
              return Stream.unwrap(Effect.map(everyRow(request), Stream.fromIterable)).pipe(
                Stream.catchTag("SqlError", (cause) =>
                  cause.pipe(failed("read"), Stream.fromEffect),
                ),
              );
            // Pages in SQL's order, by keyset on the log order or by offset when ordered;
            // the part of the filter SQL cannot evaluate drops rows from each page.
            return Stream.unwrap(
              Effect.map(visible, (generation) =>
                Stream.paginate(undefined as number | undefined, (cursor) =>
                  Effect.map(
                    order.length === 0
                      ? select(generation, pushed, cursor, SCAN_PAGE, columns)
                      : select(generation, pushed, undefined, SCAN_PAGE, columns, order, cursor),
                    (
                      page,
                    ): readonly [ReadonlyArray<EncodedRow>, Option.Option<number | undefined>] => [
                      page
                        .map(({ row }) => row)
                        .filter((row) => DomainFilter.matches(residual, row)),
                      page.length < SCAN_PAGE
                        ? Option.none()
                        : Option.some(
                            order.length === 0
                              ? page[page.length - 1]?.ord
                              : (cursor ?? 0) + SCAN_PAGE,
                          ),
                    ],
                  ),
                ),
              ),
            ).pipe(
              Stream.catchTag("SqlError", (cause) => cause.pipe(failed("read"), Stream.fromEffect)),
            );
          },
          lag: (request) => {
            const { pushed, residual } = split(request.where);
            return (
              residual === undefined
                ? lagInSql(pushed)
                : everyRow({ where: request.where }).pipe(
                    Effect.map((rows) =>
                      // A Postgres BIGINT may come back as text; the summary counts numbers.
                      summarizeLag(
                        rows.map((row) => {
                          const lag = row[Metadata.lagColumn];
                          return {
                            [Metadata.lagColumn]:
                              lag === null || lag === undefined ? null : Number(lag),
                          };
                        }),
                      ),
                    ),
                  )
            ).pipe(Effect.catchTag("SqlError", failed("read")));
          },
        } satisfies RawReader;
      },
    } satisfies Implementation;
  });
