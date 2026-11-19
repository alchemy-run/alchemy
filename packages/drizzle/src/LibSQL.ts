import type { LibSQLConfig, LibSQLSource } from "@alchemy.run/sql/SQLite";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectDrizzleSQLiteConfig } from "drizzle-orm/sqlite-core/effect/utils";
import * as Effect from "effect/Effect";

/**
 * Open a Drizzle database over a libSQL database (e.g. Turso) using the
 * `drizzle-orm/effect-libsql` integration.
 *
 * Accepts the client returned by `Turso.Connect(db)` — or any
 * `{ url, authToken }`. Resolve it once at Construction phase and use it
 * from any handler:
 *
 * ```typescript
 * const conn = yield* Turso.Connect(Db);
 * const db = yield* Drizzle.LibSQL(conn, { relations });
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The database is a real `EffectLibsqlDatabase`. Queries, subqueries, CTEs
 * and `sql` fragments are built by drizzle's own code, with no connection.
 * Running a query opens the client. It is opened at most once per execution
 * — a Worker `fetch`/`queue`/`scheduled` event, a Durable Object call, a
 * Workflow run, or a Lambda invocation — and closed when that execution
 * settles. The URL and token resolve then too, so deploy / plan-time
 * invocations never connect.
 *
 * `@effect/sql-libsql` client options (e.g. `intMode`) are passed via
 * `config.client`.
 *
 * @binding
 */
export const LibSQL = Effect.fn(function* <
  TRelations extends AnyRelations = EmptyRelations,
  E = never,
  R = never,
>(
  source: LibSQLSource<E, R>,
  config?: EffectDrizzleSQLiteConfig<TRelations> & {
    /** Overrides for the underlying `@effect/sql-libsql` client. */
    readonly client?: LibSQLConfig;
  },
) {
  // `@effect/sql-libsql` (and @libsql/client underneath) are optional peers —
  // value imports are deferred to the call so `@alchemy.run/drizzle` resolves
  // without them installed.
  const [{ LibsqlClient }, LibsqlDrizzle, SQL] = yield* Effect.promise(() =>
    Promise.all([
      import("@effect/sql-libsql/LibsqlClient"),
      import("drizzle-orm/effect-libsql"),
      import("@alchemy.run/sql/SQLite"),
    ]),
  );
  const { client, ...drizzleConfig } = config ?? {};
  return yield* LibsqlDrizzle.makeWithDefaults(
    drizzleConfig as EffectDrizzleSQLiteConfig<TRelations>,
  ).pipe(Effect.provideServiceEffect(LibsqlClient, SQL.LibSQL(source, client)));
});
