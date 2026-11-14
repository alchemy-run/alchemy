// `@alchemy.run/cloudflare` is an optional peer — its value import is
// deferred to the call so `@alchemy.run/drizzle` resolves without it.
import type { D1DatabaseSource } from "@alchemy.run/cloudflare/D1/SQL";
import * as D1Client from "@effect/sql-d1/D1Client";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import * as SQLiteD1Drizzle from "drizzle-orm/effect-d1";
import * as Effect from "effect/Effect";

/**
 * Open a Drizzle database over a Cloudflare D1 binding using the
 * `drizzle-orm/effect-d1` integration (which drives queries through
 * `@effect/sql-d1`'s `D1Client`).
 *
 * Accepts the client returned by `Cloudflare.D1.QueryDatabase(db)` — or its
 * `raw` effect directly. Resolve it once at Construction phase and use it
 * from any handler:
 *
 * ```typescript
 * const d1 = yield* Cloudflare.D1.QueryDatabase(Db);
 * const db = yield* Drizzle.D1(d1, { relations });
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The database is a real `EffectSQLiteD1Database`. Queries, subqueries, CTEs
 * and `sql` fragments are built by drizzle's own code, without the binding.
 * Running a query resolves the binding. The `D1Client` over it (and its
 * prepared-statement cache) is built at most once per execution — a Worker
 * `fetch`/`queue`/`scheduled` event, a Durable Object call, or a Workflow
 * run — and reused by every query in it. Deploy / plan-time invocations
 * (where `WorkerEnvironment` isn't provided) never touch D1.
 *
 * The client belongs to the execution's `Scope` and is released when the
 * request / run settles. Wrapping queries in a nested `Effect.scoped` gives
 * that block its own client, released when the block ends.
 *
 * @binding
 */
export const D1 = Effect.fn(function* <
  TRelations extends AnyRelations = EmptyRelations,
  E = never,
  R = never,
>(
  database: D1DatabaseSource<E, R>,
  config?: SQLiteD1Drizzle.EffectDrizzleSQLiteD1Config<TRelations>,
) {
  const SQL = yield* Effect.promise(() => import("@alchemy.run/cloudflare/D1/SQL"));
  return yield* SQLiteD1Drizzle.makeWithDefaults(
    config ?? ({} as SQLiteD1Drizzle.EffectDrizzleSQLiteD1Config<TRelations>),
  ).pipe(Effect.provideServiceEffect(D1Client.D1Client, SQL.D1(database)));
});
