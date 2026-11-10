// `@effect/sql-pg` (and pg underneath) are optional peers — value imports
// are deferred to the call so `@alchemy.run/drizzle` resolves without them
// installed.
import type * as PgClient from "@effect/sql-pg/PgClient";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectDrizzlePgConfig } from "drizzle-orm/pg-core/effect/utils";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";

/**
 * Open a Drizzle/Postgres database from a connection URL using the
 * `drizzle-orm/effect-postgres` integration.
 *
 * Resolve it once at Construction phase and use it from any handler:
 *
 * ```typescript
 * const db = yield* Drizzle.Postgres(hd.connectionString);
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The database is a real `EffectPgDatabase`. Queries, subqueries, CTEs and
 * `sql` fragments are built by drizzle's own code, with no connection.
 * Running a query opens the pool. The pool is opened at most once per
 * execution — a Worker `fetch`/`queue`/`scheduled` event, a Durable Object
 * call, a Workflow run, or a Lambda invocation — and reused by every query
 * and `task` step in it. The connection string resolves then too, so deploy
 * / plan-time invocations (where `WorkerEnvironment` isn't provided) never
 * connect.
 *
 * The pool belongs to the execution's `Scope` and closes when the request /
 * run settles. Wrapping queries in a nested `Effect.scoped` gives that block
 * its own pool, closed when the block ends.
 *
 * `@effect/sql-pg` client options are passed via `config.client`. Behind a
 * transaction-mode pooler such as Hyperdrive, turn off named prepared
 * statements, since a later query can reach a backend session that never
 * prepared them:
 *
 * ```typescript
 * const db = yield* Drizzle.Postgres(hd.connectionString, {
 *   client: { prepare: false },
 * });
 * ```
 *
 * @binding
 */
export const Postgres = Effect.fn(function* <
  TRelations extends AnyRelations = EmptyRelations,
  E = never,
  R = never,
>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
  config?: EffectDrizzlePgConfig<TRelations> & {
    /**
     * Overrides for the underlying `@effect/sql-pg` client — `prepare`,
     * `ssl`, pool limits, and friends. The URL comes from `connectionString`.
     */
    readonly client?: Omit<PgClient.PgPoolConfig, "url">;
  },
) {
  const [{ PgClient }, PgDrizzle, SQL] = yield* Effect.promise(() =>
    Promise.all([
      import("@effect/sql-pg/PgClient"),
      import("drizzle-orm/effect-postgres"),
      import("@alchemy.run/sql/Postgres"),
    ]),
  );
  const { client, ...drizzleConfig } = config ?? {};
  return yield* PgDrizzle.makeWithDefaults(drizzleConfig as EffectDrizzlePgConfig<TRelations>).pipe(
    Effect.provideServiceEffect(PgClient, SQL.Postgres({ ...client, url: connectionString })),
  );
});
