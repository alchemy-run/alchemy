import type { MySQLConfig } from "@alchemy.run/sql/MySQL";
// `@effect/sql-mysql2` (and mysql2 underneath) are optional peers — value
// imports are deferred to the call so `@alchemy.run/drizzle` resolves without
// them installed.
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectDrizzleMySqlConfig } from "drizzle-orm/mysql-core/effect/utils";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

/**
 * Open a Drizzle/MySQL database from a connection URL using the
 * `drizzle-orm/effect-mysql2` integration.
 *
 * ```typescript
 * const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 * const db = yield* Drizzle.MySQL(conn.connectionString, { relations });
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The database is a real `EffectMysql2Database`. Queries, subqueries, CTEs
 * and `sql` fragments are built by drizzle's own code, with no connection.
 * Running a query opens the pool. The pool is opened at most once per
 * execution and closes when the event settles. The connection string
 * resolves then too, so deploy / plan-time invocations never connect.
 * Workers defaults (`resolveMySQLConfig`) are overridden via `config.client`:
 *
 * ```typescript
 * const db = yield* Drizzle.MySQL(connectionString, {
 *   relations,
 *   client: { poolConfig: { ssl: { rejectUnauthorized: true } } },
 * });
 * ```
 *
 * @binding
 */
export const MySQL = Effect.fn(function* <
  TRelations extends AnyRelations = EmptyRelations,
  E = never,
  R = never,
>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
  config?: EffectDrizzleMySqlConfig<TRelations> & {
    /**
     * Overrides for the underlying `@effect/sql-mysql2` client — pool
     * options (e.g. `poolConfig.ssl` for a direct TLS connection),
     * `disablePreparedStatements`, `maxConnections`, and friends.
     */
    readonly client?: Omit<MySQLConfig, "url">;
  },
) {
  const [{ MysqlClient }, MySqlDrizzle, SQL] = yield* Effect.promise(() =>
    Promise.all([
      import("@effect/sql-mysql2/MysqlClient"),
      import("drizzle-orm/effect-mysql2"),
      import("@alchemy.run/sql/MySQL"),
    ]),
  );
  const { client, ...drizzleConfig } = config ?? {};
  return yield* MySqlDrizzle.makeWithDefaults(
    drizzleConfig as EffectDrizzleMySqlConfig<TRelations>,
  ).pipe(Effect.provideServiceEffect(MysqlClient, SQL.MySQL({ ...client, url: connectionString })));
});
