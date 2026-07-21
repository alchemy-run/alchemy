import * as Mysql2Client from "@effect/sql-mysql2/MysqlClient";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectMysql2Database } from "drizzle-orm/effect-mysql2";
import * as MySqlDrizzle from "drizzle-orm/effect-mysql2";
import type { EffectDrizzleMySqlConfig } from "drizzle-orm/mysql-core/effect/utils";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, UnknownError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";
import * as Mysql from "mysql2";
import { makeExecutionMemo } from "../Runtime/ExecutionMemo.ts";
import { proxyChain } from "../Util/proxy-chain.ts";

export type EffectDrizzleMysqlConfig<
  TRelations extends AnyRelations = EmptyRelations,
> = EffectDrizzleMySqlConfig<TRelations> & {
  /**
   * Options forwarded to the underlying MySQL client (everything except
   * `url`, which comes from the connection string). Use `client.poolConfig`
   * for raw mysql2 pool options.
   */
  client?: Omit<Mysql2Client.MysqlClientConfig, "url">;
};

const sqlError = (cause: unknown, message: string, operation: string) =>
  new SqlError({
    reason: new UnknownError({ cause, message, operation }),
  });

/**
 * A `MysqlClient`-compatible client that drives every query through mysql2's
 * **text protocol** (`connection.query`) instead of prepared statements
 * (`connection.execute` / `COM_STMT_PREPARE`).
 *
 * Cloudflare Hyperdrive does not proxy MySQL prepared statements, so the
 * upstream `@effect/sql-mysql2` client — which prepares by default — fails
 * with `Hyperdrive does not currently support MySQL COM_STMT_PREPARE
 * messages` on every query. mysql2 still escapes interpolated values
 * client-side on the text path, so parameterization is preserved.
 */
const makeTextProtocolMysqlClient = (
  options: Mysql2Client.MysqlClientConfig,
): Effect.Effect<
  Mysql2Client.MysqlClient,
  SqlError,
  Scope.Scope | Reactivity.Reactivity
> =>
  Effect.gen(function* () {
    const compiler = Mysql2Client.makeCompiler(options.transformQueryNames);
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined;

    const pool = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Mysql.createPool({
          // mysql2's row parsers JIT via `new Function(...)`, which
          // Cloudflare Workers' isolate disallows. Static parsers by
          // default; override via `poolConfig` off-workerd if you want the
          // JIT back.
          disableEval: true,
          ...options.poolConfig,
          host: options.host,
          port: options.port,
          database: options.database,
          user: options.username,
          password: options.password
            ? Redacted.value(options.password)
            : undefined,
          multipleStatements: true,
          supportBigNumbers: true,
          connectionLimit: options.maxConnections,
          idleTimeout: options.connectionTTL
            ? Duration.toMillis(Duration.fromInputUnsafe(options.connectionTTL))
            : undefined,
        }),
      ),
      (pool) =>
        Effect.callback<void>((resume) => {
          pool.end(() => resume(Effect.void));
        }),
    );

    class TextProtocolConnection implements Connection {
      constructor(private readonly conn: Mysql.Pool | Mysql.PoolConnection) {}

      private runRaw(
        sql: string,
        values: ReadonlyArray<unknown>,
        rowsAsArray = false,
      ): Effect.Effect<unknown, SqlError> {
        return Effect.callback((resume) => {
          this.conn.query(
            { sql, values: values as Array<unknown>, rowsAsArray },
            (cause, results) => {
              if (cause) {
                resume(
                  Effect.fail(
                    sqlError(
                      cause,
                      "Failed to execute statement",
                      "executeUnprepared",
                    ),
                  ),
                );
              } else {
                resume(Effect.succeed(results as unknown));
              }
            },
          );
        });
      }

      private run(
        sql: string,
        values: ReadonlyArray<unknown>,
        rowsAsArray = false,
      ): Effect.Effect<ReadonlyArray<any>, SqlError> {
        return Effect.map(this.runRaw(sql, values, rowsAsArray), (results) =>
          Array.isArray(results) ? results : [],
        );
      }

      execute(
        sql: string,
        params: ReadonlyArray<unknown>,
        transform:
          | (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>)
          | undefined,
      ) {
        return transform
          ? Effect.map(this.run(sql, params), transform)
          : this.run(sql, params);
      }
      executeRaw(sql: string, params: ReadonlyArray<unknown>) {
        return this.runRaw(sql, params);
      }
      executeValues(sql: string, params: ReadonlyArray<unknown>) {
        return this.run(sql, params, true) as Effect.Effect<
          ReadonlyArray<ReadonlyArray<unknown>>,
          SqlError
        >;
      }
      executeValuesUnprepared(sql: string, params: ReadonlyArray<unknown>) {
        return this.executeValues(sql, params);
      }
      executeUnprepared(
        sql: string,
        params: ReadonlyArray<unknown>,
        transform:
          | (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>)
          | undefined,
      ) {
        return this.execute(sql, params, transform);
      }
      executeStream(
        sql: string,
        params: ReadonlyArray<unknown>,
        transform:
          | (<A extends object>(row: ReadonlyArray<A>) => ReadonlyArray<A>)
          | undefined,
      ) {
        // Text-protocol "streaming": run the query fully, then emit the rows.
        // Fine for Worker-sized result sets; use a direct (Hyperdrive-free)
        // connection with the upstream client if you need true row streaming.
        return Stream.unwrap(
          Effect.map(this.execute(sql, params, transform), (rows) =>
            Stream.fromIterable(rows),
          ),
        );
      }
    }

    // Verify connectivity up-front so a bad URL fails the first query with a
    // connect error instead of a confusing statement error.
    yield* Effect.callback<void, SqlError>((resume) => {
      pool.query("SELECT 1", (cause) => {
        if (cause) {
          resume(
            Effect.fail(
              sqlError(cause, "MysqlClient: Failed to connect", "connect"),
            ),
          );
        } else {
          resume(Effect.void);
        }
      });
    });

    const poolConnection = new TextProtocolConnection(pool);

    // Transactions pin a dedicated connection for BEGIN/COMMIT visibility.
    const transactionAcquirer = Effect.map(
      Effect.acquireRelease(
        Effect.callback<Mysql.PoolConnection, SqlError>((resume) => {
          pool.getConnection((cause, conn) => {
            if (cause) {
              resume(
                Effect.fail(
                  sqlError(
                    cause,
                    "Failed to acquire connection",
                    "acquireConnection",
                  ),
                ),
              );
            } else {
              resume(Effect.succeed(conn));
            }
          });
        }),
        (conn) => Effect.sync(() => conn.release()),
      ),
      (conn) => new TextProtocolConnection(conn),
    );

    const client = yield* SqlClient.make({
      acquirer: Effect.succeed(poolConnection),
      transactionAcquirer,
      compiler,
      spanAttributes: [
        ...(options.spanAttributes
          ? Object.entries(options.spanAttributes)
          : []),
        ["db.system.name", "mysql"],
        ["server.address", options.host ?? "localhost"],
        ["server.port", options.port ?? 3306],
      ],
      transformRows,
    });

    return Object.assign(client, {
      [Mysql2Client.TypeId]: Mysql2Client.TypeId,
      config: options,
    }) as Mysql2Client.MysqlClient;
  });

const textProtocolLayer = (options: Mysql2Client.MysqlClientConfig) =>
  Layer.effectContext(
    Effect.map(makeTextProtocolMysqlClient(options), (client) =>
      Context.make(Mysql2Client.MysqlClient, client).pipe(
        Context.add(SqlClient.SqlClient, client),
      ),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

/**
 * Open a Drizzle/MySQL database from a connection URL using the
 * `drizzle-orm/effect-mysql2` integration.
 *
 * Returns a chainable Proxy over `EffectMysql2Database` (via `proxyChain`) —
 * every property read records a step, every call records args, and the
 * chain is replayed against the resolved drizzle db when it's finally
 * yielded as an Effect. Callers don't need a separate `yield* conn` step:
 *
 * ```typescript
 * const conn = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 * const db = yield* Drizzle.mysql(conn.connectionString, { relations });
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The connect work is deferred until the first query and memoized on the
 * current execution's `Scope` (via {@link makeExecutionMemo}), so the pool
 * is built at most once per execution — a Worker `fetch`/`queue`/`scheduled`
 * event, a Durable Object call, a Workflow run, or a Lambda invocation — and
 * reused across every query in that execution, then torn down when the
 * execution's scope closes. Yielding the connection string is likewise
 * deferred, so deploy / plan-time invocations never trigger a real
 * connection attempt.
 *
 * Queries run over mysql2's **text protocol** (`query`, not `execute`):
 * Cloudflare Hyperdrive does not proxy MySQL prepared statements
 * (`COM_STMT_PREPARE`), and the text path also avoids mysql2's
 * `new Function(...)` JIT parsers that Workers' isolate disallows. Values
 * are still escaped client-side, so parameterization is preserved.
 *
 * @binding
 */
export const mysql = <
  TRelations extends AnyRelations = EmptyRelations,
  E = never,
  R = never,
>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
  config?: EffectDrizzleMysqlConfig<TRelations>,
) => {
  const { client, ...drizzleConfig } = config ?? {};
  return Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const url = yield* Effect.map(
          connectionString,
          (s) => new URL(Redacted.value(s)),
        );
        const mysqlCtx = yield* Layer.build(
          textProtocolLayer({
            ...client,
            host: url.hostname,
            port: url.port === "" ? undefined : Number(url.port),
            database:
              url.pathname.replace(/^\//, "") === ""
                ? undefined
                : decodeURIComponent(url.pathname.replace(/^\//, "")),
            username: decodeURIComponent(url.username),
            password: Redacted.make(decodeURIComponent(url.password)),
          }),
        );
        return yield* MySqlDrizzle.makeWithDefaults(
          drizzleConfig as EffectDrizzleMySqlConfig<TRelations>,
        ).pipe(Effect.provideContext(mysqlCtx));
      }),
    ),
    (db) =>
      proxyChain<
        EffectMysql2Database<TRelations> & {
          $client: Mysql2Client.MysqlClient;
        }
      >(
        db as Effect.Effect<
          EffectMysql2Database<TRelations> & {
            $client: Mysql2Client.MysqlClient;
          }
        >,
      ),
  );
};
