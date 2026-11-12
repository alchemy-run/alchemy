import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import type * as Redacted from "effect/Redacted";
import * as Sql from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { makeDeferredClient } from "./DeferredClient.ts";
import { resolveConnectionOptions } from "./PostgresTls.ts";

/**
 * Options for {@link Postgres}: `@effect/sql-pg`'s pool configuration, with
 * `url` widened to also accept an Effect (e.g. a Hyperdrive connection
 * string, which resolves from the Worker environment at runtime).
 */
export type PostgresConfig<E, R> = Omit<PgClient.PgPoolConfig, "url"> & {
  readonly url: Redacted.Redacted<string> | Effect.Effect<Redacted.Redacted<string>, E, R>;
};

// The fragment `PgClient.json` builds. `@effect/sql-pg` keeps the
// constructor private; its compiler matches on the kind.
const pgJson = Statement.custom<Statement.Custom<"PgJson", unknown>>("PgJson");

/**
 * Open an `@effect/sql-pg` client (a connection pool) from a connection URL.
 *
 * Accepts a plain `Redacted` URL or an Effect of one — e.g.
 * `Cloudflare.Hyperdrive.Connect(...)` or `Fly.ConnectPostgres(...)`'s
 * `connectionString` — and returns a `PgClient` (which implements the
 * generic `SqlClient` interface). Resolve it once at Construction phase and
 * use it from any handler:
 *
 * ```typescript
 * import * as SQL from "@alchemy.run/sql/Postgres";
 *
 * const hd = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 * const sql = yield* SQL.Postgres({ url: hd.connectionString });
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* sql`SELECT * FROM users`;
 * });
 * ```
 *
 * The client is a real `PgClient`: `` sql`...` ``, `sql.insert`, `sql.and`
 * and `sql.json` build and compile statements with `@effect/sql-pg`'s own
 * code, with no connection. Running a statement opens the pool. The pool is
 * opened at most once per execution — a Worker `fetch`/`queue`/`scheduled`
 * event, a Durable Object call, a Workflow run, or a Lambda invocation — and
 * closes when the event settles. The connection URL resolves then too, so
 * deploy / plan-time invocations never connect.
 *
 * @binding
 */
export const Postgres = Effect.fn(function* <E = never, R = never>(config: PostgresConfig<E, R>) {
  const { url, ...pool } = config;
  const { client, connected } = yield* makeDeferredClient({
    driver: "pg",
    compiler: PgClient.makeCompiler(pool.transformQueryNames, pool.transformJson),
    transformRows: pool.transformResultNames
      ? Statement.defaultTransforms(pool.transformResultNames, pool.transformJson).array
      : undefined,
    // The database, host and port are in the URL, which resolves on connect.
    spanAttributes: [
      ...Object.entries(pool.spanAttributes ?? {}),
      ["db.system.name", "postgresql"],
    ],
    connect: Effect.gen(function* () {
      const resolved = Effect.isEffect(url) ? yield* url : url;
      return yield* PgClient.make({
        ...pool,
        ...resolveConnectionOptions(resolved, pool.ssl),
      }).pipe(Effect.provideServiceEffect(Reactivity.Reactivity, Reactivity.make));
    }),
  });
  return Object.assign(client, {
    [PgClient.TypeId]: PgClient.TypeId,
    // The options known at Construction phase. The URL resolves on connect.
    config: pool,
    json: (value: unknown) => Statement.fragment([pgJson(value, undefined, undefined)]),
    listen: (channel: string) => Effect.flatMap(connected, (real) => real.listen(channel)),
    notify: (channel: string, payload: string) =>
      Effect.flatMap(connected, (real) => real.notify(channel, payload)),
    poolStats: Effect.flatMap(Effect.orDie(connected), (real) => real.poolStats),
  }) satisfies PgClient.PgClient as PgClient.PgClient & Sql.SqlClient;
});

/**
 * Provide an `@effect/sql-pg` client as the `PgClient` and generic
 * `SqlClient` services, so cloud-agnostic services written against
 * `SqlClient.SqlClient` (or drizzle's `effect-postgres` driver, which
 * depends on `PgClient`) run on the configured pool:
 *
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 * const app = yield* makeApp.pipe(
 *   Effect.provide(SQL.PostgresLayer({ url: hd.connectionString })),
 * );
 * ```
 *
 * The layer itself builds synchronously at Construction phase; the
 * underlying pool is created lazily per execution (see {@link Postgres}).
 */
export const PostgresLayer = <E = never, R = never>(config: PostgresConfig<E, R>) =>
  // Derive SqlClient from the single PgClient build so both tags share one
  // per-execution pool.
  Layer.effect(Sql.SqlClient, PgClient.PgClient).pipe(
    Layer.provideMerge(Layer.effect(PgClient.PgClient, Postgres(config))),
  );
