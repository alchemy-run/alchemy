/**
 * An engine over any Effect `SqlClient`: Postgres (including Alchemy's
 * `@alchemy.run/sql` clients), MySQL, SQLite, libSQL, D1, ClickHouse. A
 * query runs through the client's own compiler, so quoting and placeholders
 * are the client's, and the engine's dialect is read from the client rather
 * than declared twice. Postgres, MySQL, ClickHouse and Durable Object SQLite
 * clients stream rows; libSQL and D1 clients cannot, so give them
 * `stream: "collect"`.
 *
 * Instants come back as instants: ClickHouse is asked for ISO text with its
 * zone (`date_time_output_format`), and a MySQL client must read `DATETIME`
 * as UTC (`poolConfig: { timezone: "Z" }`), as the store writes it; the
 * engine fails to build on a client that reads it in its local zone.
 *
 * @module
 */
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import { detailOf, isStatementFault, rowToJson } from "../internal.ts";
import {
  ClientTimeZone,
  type Dialect,
  EngineUnavailable,
  type Implementation,
  QueryFailed,
  QueryRefused,
  UnsupportedDialect,
} from "./Engine.ts";

/**
 * `@effect/sql-clickhouse`'s `ClickhouseSettings`, by its public key (a
 * reference is its key): declared here so the engine does not load the
 * ClickHouse client for the other dialects.
 */
const ClickhouseSettings = Context.Reference(
  "@effect/sql-clickhouse/ClickhouseClient/ClickhouseSettings",
  { defaultValue: (): Readonly<Record<string, unknown>> => ({}) },
);

/** The engine dialect a client speaks, or none it can serve. */
const dialectOf = (sql: SqlClient): Dialect | undefined =>
  sql.onDialectOrElse({
    pg: (): Dialect => "postgres",
    mysql: (): Dialect => "mysql",
    sqlite: (): Dialect => "sqlite",
    clickhouse: (): Dialect => "clickhouse",
    orElse: () => undefined,
  });

/** How `Export.Sql.engine` runs on its client. */
export interface EngineOptions {
  /**
   * The name each table is read under; by default its stable name (a view
   * the store keeps on the promoted generation).
   */
  readonly name?: Implementation["name"];
  /**
   * `"collect"` runs a streamed query whole and emits its rows, for clients
   * that cannot stream (libSQL, D1).
   * @default "native"
   */
  readonly stream?: "native" | "collect" | undefined;
}

/**
 * An engine on the `SqlClient` in context: its dialect is the client's.
 * Fails with `UnsupportedDialect` on a client that speaks none an engine
 * declares (`mssql`), and with `ClientTimeZone` on a MySQL client that reads
 * `DATETIME` in its own zone. A failed query is `QueryRefused` when the
 * statement itself is at fault (a syntax error, a violated constraint), and
 * `EngineUnavailable` otherwise.
 *
 * ### Querying Postgres
 * **Example:** The engine over a Postgres client
 * ```typescript
 * import * as Export from "@alchemy.run/domain/Export";
 * import { PgClient } from "@effect/sql-pg";
 * import * as Layer from "effect/Layer";
 *
 * export const AnalyticsLive = Analytics.toLayer(Export.Sql.engine()).pipe(
 *   Layer.provide(PgClient.layer({ url })),
 * );
 * ```
 *
 * ### Querying ClickHouse
 * **Example:** The engine over a ClickHouse client
 * ```typescript
 * import * as Export from "@alchemy.run/domain/Export";
 * import { ClickhouseClient } from "@effect/sql-clickhouse";
 * import * as Layer from "effect/Layer";
 *
 * export class Fast extends Export.Engine("Fast", { stores: [Warehouse], dialect: "clickhouse" }) {}
 *
 * export const FastLive = Fast.toLayer(Export.Sql.engine()).pipe(
 *   Layer.provide(ClickhouseClient.layer({ url })),
 * );
 * ```
 *
 * ### Querying libSQL or D1
 * **Example:** A client that cannot stream
 * ```typescript
 * export const AnalyticsLive = Analytics.toLayer(Export.Sql.engine({ stream: "collect" })).pipe(
 *   Layer.provide(LibsqlClient.layer({ url })),
 * );
 * ```
 *
 * @layer
 * @title Sql.engine
 * @provides Export.Engine.Implementation
 */
export const engine = (
  options: EngineOptions = {},
): Effect.Effect<Implementation, QueryFailed, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const dialect = dialectOf(sql);
    if (dialect === undefined) {
      return yield* new QueryFailed({
        reason: new UnsupportedDialect(),
        detail: "Export.Sql.engine serves Postgres, MySQL, SQLite and ClickHouse clients",
      });
    }
    const failedWith = (cause: SqlError) =>
      new QueryFailed({
        reason: isStatementFault(cause)
          ? new QueryRefused({ code: cause.reason._tag })
          : new EngineUnavailable({ code: cause.reason._tag }),
        detail: detailOf(cause),
        cause,
      });
    if (dialect === "mysql") {
      // A `DATETIME` names no zone: the store writes UTC, and a client reading it in its own zone shifts every instant.
      const [probe] = yield* sql<{
        readonly epoch: unknown;
      }>`SELECT CAST('1970-01-01 00:00:00' AS DATETIME(3)) AS epoch`.pipe(
        Effect.mapError(failedWith),
      );
      const epoch = probe === undefined ? undefined : rowToJson(probe).epoch;
      if (epoch !== "1970-01-01T00:00:00.000Z") {
        const reason = new ClientTimeZone({ epoch: JSON.stringify(epoch) });
        return yield* new QueryFailed({ reason, detail: reason.message });
      }
    }
    /** The caller's ClickHouse settings, with instants as ISO text carrying their zone. */
    const isoSettings = Effect.map(Effect.service(ClickhouseSettings), (settings) => ({
      ...settings,
      date_time_output_format: "iso",
    }));
    const run: Implementation["run"] = (query) =>
      (dialect === "clickhouse"
        ? Effect.flatMap(isoSettings, (settings) =>
            Effect.provideService(
              sql<Record<string, unknown>>`${query}`,
              ClickhouseSettings,
              settings,
            ),
          )
        : sql<Record<string, unknown>>`${query}`
      ).pipe(Effect.map(Arr.map(rowToJson)), Effect.mapError(failedWith));
    const rows = (query: Statement.Fragment) => sql<Record<string, unknown>>`${query}`.stream;
    return {
      dialect,
      name: options.name,
      run,
      stream: (query) =>
        options.stream === "collect"
          ? Stream.unwrap(Effect.map(run(query), Stream.fromIterable))
          : (dialect === "clickhouse"
              ? Stream.unwrap(
                  Effect.map(isoSettings, (settings) =>
                    rows(query).pipe(Stream.provideService(ClickhouseSettings, settings)),
                  ),
                )
              : rows(query)
            ).pipe(Stream.map(rowToJson), Stream.mapError(failedWith)),
    } satisfies Implementation;
  });

export { store } from "./SqlStore.ts";
