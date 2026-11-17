import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Reactivity from "effect/reactivity/Reactivity";
import type * as Redacted from "effect/Redacted";
import * as Sql from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { makeDeferredClient } from "./DeferredClient.ts";

/**
 * Where to reach a libSQL database: its URL and (for remote databases) an
 * auth token, as plain values or Effects of them. Structurally matches the
 * client returned by `Turso.Connect(db)`, so it can be passed straight in.
 */
export interface LibSQLSource<E = never, R = never> {
  readonly url: string | Effect.Effect<string, E, R>;
  readonly authToken?: Redacted.Redacted<string> | Effect.Effect<Redacted.Redacted<string>, E, R>;
}

/**
 * Options forwarded to `@effect/sql-libsql`'s `LibsqlClient` (everything
 * except the connection, which comes from the {@link LibSQLSource}).
 */
export type LibSQLConfig = Omit<
  Extract<LibsqlClient.LibsqlClientConfig, { readonly url: unknown }>,
  "url" | "authToken"
>;

const resolve = <A, E, R>(value: A | Effect.Effect<A, E, R>) =>
  Effect.isEffect(value) ? value : Effect.succeed(value);

/**
 * Resolve a {@link LibSQLSource} and {@link LibSQLConfig} into the
 * `LibsqlClientConfig` handed to `@effect/sql-libsql`.
 */
export const resolveLibSQLConfig = Effect.fn(function* <E = never, R = never>(
  source: LibSQLSource<E, R>,
  config?: LibSQLConfig,
) {
  const url = yield* resolve(source.url);
  const authToken = source.authToken === undefined ? undefined : yield* resolve(source.authToken);
  return { ...config, url, authToken } satisfies LibsqlClient.LibsqlClientConfig;
});

/**
 * Open an `@effect/sql-libsql` client over a SQLite database through
 * libSQL — a Turso database, any other libSQL server, or a local
 * `file:` database.
 *
 * Accepts the client returned by `Turso.Connect(db)` (or any
 * `{ url, authToken }`) and returns a `LibsqlClient` (which implements the
 * generic `SqlClient` interface). Resolve it once at Construction phase and
 * use it from any handler:
 *
 * ```typescript
 * import * as SQL from "@alchemy.run/sql/SQLite";
 *
 * const conn = yield* Turso.Connect(Db);
 * const sql = yield* SQL.LibSQL(conn);
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* sql`SELECT * FROM users`;
 * });
 * ```
 *
 * The client is a real `LibsqlClient`: `` sql`...` ``, `sql.insert` and
 * `sql.and` build and compile statements with `@effect/sql-libsql`'s own
 * code, with no connection. Running a statement opens the database. It is
 * opened at most once per execution — a Worker `fetch`/`queue`/`scheduled`
 * event, a Durable Object call, a Workflow run, or a Lambda invocation — and
 * closed when the event settles. The URL and token resolve then too, so
 * deploy / plan-time invocations never connect.
 *
 * @binding
 */
export const LibSQL = Effect.fn(function* <E = never, R = never>(
  source: LibSQLSource<E, R>,
  config?: LibSQLConfig,
) {
  const { client } = yield* makeDeferredClient({
    driver: "libsql",
    compiler: Statement.makeCompilerSqlite(config?.transformQueryNames),
    transformRows: config?.transformResultNames
      ? Statement.defaultTransforms(config.transformResultNames).array
      : undefined,
    spanAttributes: [...Object.entries(config?.spanAttributes ?? {}), ["db.system.name", "sqlite"]],
    connect: Effect.flatMap(resolveLibSQLConfig(source, config), (resolved) =>
      LibsqlClient.make(resolved).pipe(
        Effect.provideServiceEffect(Reactivity.Reactivity, Reactivity.make),
      ),
    ),
  });
  return Object.assign(client, {
    [LibsqlClient.TypeId]: LibsqlClient.TypeId,
    // The options known at Construction phase. The URL and token resolve
    // on connect.
    config: { ...config } as LibsqlClient.LibsqlClientConfig,
  }) satisfies LibsqlClient.LibsqlClient as LibsqlClient.LibsqlClient & Sql.SqlClient;
});

/**
 * Provide an `@effect/sql-libsql` client as the `LibsqlClient` and generic
 * `SqlClient` services, so cloud-agnostic services written against
 * `SqlClient.SqlClient` (or drizzle's `effect-libsql` driver, which depends
 * on `LibsqlClient`) run on a libSQL database:
 *
 * ```typescript
 * const conn = yield* Turso.Connect(Db);
 * const app = yield* makeApp.pipe(Effect.provide(SQL.LibSQLLayer(conn)));
 * ```
 *
 * The layer itself builds synchronously at Construction phase; the underlying client is
 * created lazily per execution (see {@link LibSQL}).
 */
export const LibSQLLayer = <E = never, R = never>(
  source: LibSQLSource<E, R>,
  config?: LibSQLConfig,
) =>
  // Derive SqlClient from the single LibsqlClient build so both tags share
  // one per-execution client.
  Layer.effect(Sql.SqlClient, LibsqlClient.LibsqlClient).pipe(
    Layer.provideMerge(Layer.effect(LibsqlClient.LibsqlClient, LibSQL(source, config))),
  );
