import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Sql from "effect/sql/SqlClient";
import { makeExecutionMemo } from "../Runtime/ExecutionMemo.ts";
import { proxyChain } from "../Util/proxy-chain.ts";

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
 * Open an `@effect/sql-libsql` client over a libSQL database — a Turso
 * database, or any other libSQL server.
 *
 * Accepts the client returned by `Turso.Connect(db)` (or any
 * `{ url, authToken }`) and returns a `LibsqlClient` (which implements the
 * generic `SqlClient` interface) wrapped in a chainable Proxy, so it can be
 * resolved once at init and used from any handler:
 *
 * ```typescript
 * import * as SQL from "alchemy/SQL/LibSQL";
 *
 * const conn = yield* Turso.Connect(Db);
 * const sql = yield* SQL.LibSQL(conn);
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* sql`SELECT * FROM users`;
 * });
 * ```
 *
 * The client is built lazily on the first query and memoized on the
 * current execution's `Scope` (via {@link makeExecutionMemo}), so it's
 * created at most once per execution — a Worker `fetch`/`queue`/`scheduled`
 * event, a Durable Object call, a Workflow run, or a Lambda invocation — and
 * closed when the event settles. Resolving the URL and token is likewise
 * deferred, so deploy / plan-time invocations never connect.
 *
 * @binding
 */
export const LibSQL = <E = never, R = never>(source: LibSQLSource<E, R>, config?: LibSQLConfig) =>
  Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const url = yield* resolve(source.url);
        const authToken =
          source.authToken === undefined ? undefined : yield* resolve(source.authToken);
        const ctx = yield* Layer.build(LibsqlClient.layer({ ...config, url, authToken }));
        return Context.get(ctx, LibsqlClient.LibsqlClient);
      }),
    ),
    (client) => proxyChain<LibsqlClient.LibsqlClient>(client),
  );

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
 * The layer itself builds synchronously at init; the underlying client is
 * created lazily per execution (see {@link LibSQL}).
 */
export const LibSQLLayer = <E = never, R = never>(
  source: LibSQLSource<E, R>,
  config?: LibSQLConfig,
) =>
  // Derive SqlClient from the single LibsqlClient build so both tags share
  // one per-execution client.
  Layer.effect(
    Sql.SqlClient,
    Effect.gen(function* () {
      return yield* LibsqlClient.LibsqlClient;
    }),
  ).pipe(Layer.provideMerge(Layer.effect(LibsqlClient.LibsqlClient, LibSQL(source, config))));
