import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import type * as Mysql from "mysql2";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Sql from "effect/unstable/sql/SqlClient";
import { makeExecutionMemo } from "../Runtime/ExecutionMemo.ts";
import { proxyChain } from "../Util/proxy-chain.ts";

/**
 * Options for {@link MySQL}: `@effect/sql-mysql2`'s client configuration,
 * with `url` widened to also accept an Effect (e.g. a Hyperdrive connection
 * string, which resolves from the Worker environment at runtime).
 *
 * The `url` is always parsed into discrete `host`/`port`/`database`/
 * `username`/`password` fields before it reaches the driver — mysql2's
 * URI code path ignores `poolConfig`, and the Workers-safe defaults below
 * are applied through `poolConfig`. Explicit fields in the config override
 * the parsed URL parts; query-string parameters (e.g. `?ssl=...`) are
 * parsed into `poolConfig` the same way mysql2's own URI parser does.
 */
export type MySQLConfig<E = never, R = never> = Omit<
  MysqlClient.MysqlClientConfig,
  "url"
> & {
  readonly url:
    | Redacted.Redacted<string>
    | Effect.Effect<Redacted.Redacted<string>, E, R>;
};

/**
 * Detect the Cloudflare Workers runtime (workerd). Two Workers-specific
 * defaults hinge on this:
 *
 * - workerd forbids runtime code generation, so mysql2's eval-based row
 *   parsers must be disabled (`poolConfig.disableEval`).
 * - MySQL reaches workerd through Hyperdrive, whose proxy speaks only the
 *   text protocol (no `COM_STMT_PREPARE`), so prepared statements must be
 *   disabled (`disablePreparedStatements`).
 */
const isWorkerd = () =>
  (globalThis as { navigator?: { userAgent?: string } }).navigator
    ?.userAgent === "Cloudflare-Workers" || "WebSocketPair" in globalThis;

/**
 * Parse a `mysql://user:password@host:port/database?...` connection URL into
 * the discrete fields of `MysqlClientConfig`. Query-string parameters are
 * JSON-parsed into `poolConfig` entries (mysql2's own URI convention), so
 * URLs like `mysql://...?ssl={"rejectUnauthorized":true}` keep working.
 */
const parseMySQLUrl = (url: Redacted.Redacted<string>) =>
  Effect.try({
    try: () => {
      const u = new URL(Redacted.value(url));
      const poolConfig: Record<string, unknown> = {};
      for (const [key, value] of u.searchParams) {
        try {
          poolConfig[key] = JSON.parse(value);
        } catch {
          poolConfig[key] = value;
        }
      }
      const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
      return {
        host: u.hostname,
        port: u.port === "" ? 3306 : Number(u.port),
        database: database === "" ? undefined : database,
        username:
          u.username === "" ? undefined : decodeURIComponent(u.username),
        password:
          u.password === ""
            ? undefined
            : Redacted.make(decodeURIComponent(u.password)),
        poolConfig: poolConfig as Mysql.PoolOptions,
      };
    },
    catch: (cause) =>
      new Error(`SQL.MySQL: failed to parse connection url: ${cause}`),
  }).pipe(Effect.orDie);

/**
 * Resolve a {@link MySQLConfig} into the concrete `MysqlClientConfig` handed
 * to `@effect/sql-mysql2`: yields the `url` if it is an Effect, parses it
 * into discrete connection fields, and applies the Workers-safe defaults
 * (`poolConfig.disableEval` and `disablePreparedStatements` on workerd).
 * Explicit config fields always win over parsed / defaulted values.
 *
 * Exported for reuse by `alchemy/Drizzle`'s MySQL driver; most applications
 * use {@link MySQL} or {@link MySQLLayer} instead.
 */
export const resolveMySQLConfig = <E = never, R = never>(
  config: MySQLConfig<E, R>,
): Effect.Effect<MysqlClient.MysqlClientConfig, E, R> =>
  Effect.gen(function* () {
    const { url, ...overrides } = config;
    const resolved = Effect.isEffect(url) ? yield* url : url;
    const parsed = yield* parseMySQLUrl(resolved);
    const workerd = yield* Effect.sync(isWorkerd);
    return {
      ...overrides,
      host: overrides.host ?? parsed.host,
      port: overrides.port ?? parsed.port,
      database: overrides.database ?? parsed.database,
      username: overrides.username ?? parsed.username,
      password: overrides.password ?? parsed.password,
      poolConfig: {
        ...(workerd ? { disableEval: true } : {}),
        ...parsed.poolConfig,
        ...overrides.poolConfig,
      },
      disablePreparedStatements: overrides.disablePreparedStatements ?? workerd,
    } satisfies MysqlClient.MysqlClientConfig;
  });

/**
 * Open an `@effect/sql-mysql2` client (a connection pool) from a connection
 * URL.
 *
 * Accepts a plain `Redacted` URL or an Effect of one — e.g.
 * `Cloudflare.Hyperdrive.Connect(...)`'s `connectionString` — and returns a
 * `MysqlClient` (which implements the generic `SqlClient` interface) wrapped
 * in a chainable Proxy, so it can be resolved once at init and used from any
 * handler:
 *
 * ```typescript
 * import * as SQL from "alchemy/SQL/MySQL";
 *
 * const hd = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 * const sql = yield* SQL.MySQL({ url: hd.connectionString });
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* sql`SELECT * FROM users`;
 * });
 * ```
 *
 * On Cloudflare Workers two mysql2 quirks are defaulted away: eval-based row
 * parsers are disabled (workerd forbids runtime code generation) and queries
 * use the text protocol instead of prepared statements (Hyperdrive's MySQL
 * proxy does not support `COM_STMT_PREPARE`). Both defaults can be
 * overridden via `poolConfig.disableEval` / `disablePreparedStatements`.
 *
 * The pool is built lazily on the first query and memoized on the current
 * execution's `Scope` (via {@link makeExecutionMemo}), so it's created at
 * most once per execution — a Worker `fetch`/`queue`/`scheduled` event, a
 * Durable Object call, a Workflow run, or a Lambda invocation — and its
 * `end` finalizer fires when the event settles. Yielding the connection URL
 * is likewise deferred, so deploy / plan-time invocations never connect.
 *
 * @binding
 */
export const MySQL = <E = never, R = never>(config: MySQLConfig<E, R>) =>
  Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const resolved = yield* resolveMySQLConfig(config);
        const mysqlCtx = yield* Layer.build(MysqlClient.layer(resolved));
        return Context.get(mysqlCtx, MysqlClient.MysqlClient);
      }),
    ),
    (client) => proxyChain<MysqlClient.MysqlClient>(client),
  );

/**
 * Provide an `@effect/sql-mysql2` client as the `MysqlClient` and generic
 * `SqlClient` services, so cloud-agnostic services written against
 * `SqlClient.SqlClient` (or drizzle's `effect-mysql2` driver, which depends
 * on `MysqlClient`) run on the configured pool:
 *
 * ```typescript
 * const hd = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 * const app = yield* makeApp.pipe(
 *   Effect.provide(SQL.MySQLLayer({ url: hd.connectionString })),
 * );
 * ```
 *
 * The layer itself builds synchronously at init; the underlying pool is
 * created lazily per execution (see {@link MySQL}).
 */
export const MySQLLayer = <E = never, R = never>(config: MySQLConfig<E, R>) =>
  // Derive SqlClient from the single MysqlClient build so both tags share
  // one per-execution pool.
  Layer.effect(
    Sql.SqlClient,
    Effect.gen(function* () {
      return yield* MysqlClient.MysqlClient;
    }),
  ).pipe(
    Layer.provideMerge(Layer.effect(MysqlClient.MysqlClient, MySQL(config))),
  );
