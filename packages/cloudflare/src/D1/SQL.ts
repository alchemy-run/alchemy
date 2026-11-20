import { makeDeferredClient } from "@alchemy.run/sql/DeferredClient";
import type * as runtime from "@cloudflare/workers-types";
import * as D1Client from "@effect/sql-d1/D1Client";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Sql from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

/**
 * A source of the raw Cloudflare `D1Database` binding. Structurally matches
 * the client returned by `Cloudflare.D1.QueryDatabase(db)` (its `raw`
 * accessor), so both the client and a bare effect are accepted.
 */
export type D1DatabaseSource<E, R> =
  | Effect.Effect<runtime.D1Database, E, R>
  | { readonly raw: Effect.Effect<runtime.D1Database, E, R> };

/**
 * Options forwarded to `@effect/sql-d1`'s `D1Client` (everything except the
 * `db` binding itself, which alchemy resolves from the Worker environment).
 */
export type D1Config = Omit<D1Client.D1ClientConfig, "db">;

/**
 * Open an `@effect/sql-d1` client over a Cloudflare D1 binding.
 *
 * Accepts the client returned by `Cloudflare.D1.QueryDatabase(db)` — or its
 * `raw` effect directly — and returns a `D1Client` (which implements the
 * generic `SqlClient` interface). Resolve it once at Construction phase and
 * use it from any handler:
 *
 * ```typescript
 * import * as SQL from "@alchemy.run/cloudflare/D1/SQL";
 *
 * const d1 = yield* Cloudflare.D1.QueryDatabase(Db);
 * const sql = yield* SQL.D1(d1);
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* sql`SELECT * FROM users`;
 * });
 * ```
 *
 * The client is a real `D1Client`: `` sql`...` ``, `sql.insert` and
 * `sql.and` build and compile statements with `@effect/sql-d1`'s own code,
 * without the binding. Running a statement resolves the binding. The
 * `D1Client` over it (and its prepared-statement cache) is built at most
 * once per execution — a Worker `fetch`/`queue`/`scheduled` event, a Durable
 * Object call, or a Workflow run — and released when the event settles.
 * Deploy / plan-time invocations never touch D1.
 *
 * @binding
 * @title SQL
 */
export const D1 = Effect.fn(function* <E = never, R = never>(
  database: D1DatabaseSource<E, R>,
  config?: D1Config,
) {
  const { client, connected } = yield* makeDeferredClient({
    driver: "d1",
    compiler: Statement.makeCompilerSqlite(config?.transformQueryNames),
    transformRows: config?.transformResultNames
      ? Statement.defaultTransforms(config.transformResultNames).array
      : undefined,
    spanAttributes: [...Object.entries(config?.spanAttributes ?? {}), ["db.system.name", "sqlite"]],
    connect: Effect.flatMap(Effect.isEffect(database) ? database : database.raw, (db) =>
      D1Client.make({ ...config, db }).pipe(
        Effect.provideServiceEffect(Reactivity.Reactivity, Reactivity.make),
      ),
    ),
  });
  const batch: D1Client.D1Client["batch"] = (statements) =>
    Effect.flatMap(connected, (real) => real.batch(statements));
  // Typed as `@effect/sql-d1` types its own client: D1 has no `updateValues`,
  // which `D1Client` declares `never`.
  return Object.assign(client as D1Client.D1Client & Sql.SqlClient, {
    [D1Client.TypeId]: D1Client.TypeId,
    // The options known at Construction phase. The binding (`db`) resolves
    // on the first statement of an execution.
    config: { ...config } as D1Client.D1ClientConfig,
    batch,
  });
});

/**
 * Provide an `@effect/sql-d1` client as the `D1Client` and generic
 * `SqlClient` services, so cloud-agnostic services written against
 * `SqlClient.SqlClient` (or drizzle's `effect-d1` driver, which depends on
 * `D1Client`) run on a bound D1 database:
 *
 * ```typescript
 * const d1 = yield* Cloudflare.D1.QueryDatabase(Db);
 * const app = yield* makeApp.pipe(Effect.provide(SQL.D1Layer(d1)));
 * ```
 *
 * The layer itself builds synchronously at Construction phase; the
 * underlying `D1Client` is created lazily per execution (see {@link D1}).
 */
export const D1Layer = <E = never, R = never>(
  database: D1DatabaseSource<E, R>,
  config?: D1Config,
) =>
  // Derive SqlClient from the single D1Client build so both tags share one
  // per-execution client (and one prepared-statement cache).
  Layer.effect(Sql.SqlClient, D1Client.D1Client).pipe(
    Layer.provideMerge(Layer.effect(D1Client.D1Client, D1(database, config))),
  );
