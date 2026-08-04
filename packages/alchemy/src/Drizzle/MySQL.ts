import * as MysqlClient from "@effect/sql-mysql2/MysqlClient";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectMysql2Database } from "drizzle-orm/effect-mysql2";
import * as MySqlDrizzle from "drizzle-orm/effect-mysql2";
import type { EffectDrizzleMySqlConfig } from "drizzle-orm/mysql-core/effect/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { makeExecutionMemo } from "../Runtime/ExecutionMemo.ts";
import { resolveMySQLConfig, type MySQLConfig } from "../SQL/MySQL.ts";
import { proxyChain } from "../Util/proxy-chain.ts";

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
 * const db = yield* Drizzle.MySQL(hd.connectionString);
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * On Cloudflare Workers the underlying `@effect/sql-mysql2` client defaults
 * to mysql2's eval-free row parsers (workerd forbids runtime code
 * generation) and the text protocol instead of prepared statements
 * (Hyperdrive's MySQL proxy does not support `COM_STMT_PREPARE`). Override
 * either via `config.client`.
 *
 * The connect work is deferred until the first query and memoized on the
 * current execution's `Scope` (via {@link makeExecutionMemo}), so the pool
 * is built at most once per execution — a Worker `fetch`/`queue`/`scheduled`
 * event, a Durable Object call, a Workflow run, or a Lambda invocation — and
 * reused across every query and `task` step in that execution. Yielding the
 * connection string is likewise deferred, so deploy / plan-time invocations
 * (where `WorkerEnvironment` isn't provided) never trigger a real connection
 * attempt.
 *
 * The pool is built against that same execution scope, so its `end`
 * finalizer fires when the scope closes — when the request / run settles,
 * not when the Worker's isolate-lifetime init completes. Wrapping queries in
 * a nested `Effect.scoped` narrows both the memo and the pool's lifetime to
 * that block: memo key and finalizer target are always the same scope
 * object, so they cannot disagree.
 *
 * @binding
 */

export const MySQL = <
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
) =>
  Effect.map(
    makeExecutionMemo(
      Effect.gen(function* () {
        const { client, ...drizzleConfig } = config ?? {};
        const mysqlCtx = yield* Layer.build(
          MysqlClient.layer(
            yield* resolveMySQLConfig({ ...client, url: connectionString }),
          ),
        );
        return yield* MySqlDrizzle.makeWithDefaults(
          drizzleConfig as EffectDrizzleMySqlConfig<TRelations>,
        ).pipe(Effect.provideContext(mysqlCtx));
      }),
    ),
    (db) =>
      proxyChain<
        EffectMysql2Database<TRelations> & {
          $client: MysqlClient.MysqlClient;
        }
      >(
        db as Effect.Effect<
          EffectMysql2Database<TRelations> & {
            $client: MysqlClient.MysqlClient;
          }
        >,
      ),
  );
