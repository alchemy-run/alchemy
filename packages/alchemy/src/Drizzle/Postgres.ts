import * as PgClient from "@effect/sql-pg/PgClient";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ExecutionContext } from "../ExecutionContext.ts";
import { proxyChain } from "../Util/proxy-chain.ts";

/**
 * Open a Drizzle/Postgres database from a connection URL using the
 * `drizzle-orm/effect-postgres` integration.
 *
 * Returns a chainable Proxy over `EffectPgDatabase` (via `proxyChain`) —
 * every property read records a step, every call records args, and the
 * chain is replayed against the resolved drizzle db when it's finally
 * yielded as an Effect. Callers don't need a separate `yield* conn` step:
 *
 * ```typescript
 * const db = yield* Drizzle.postgres(hd.connectionString);
 *
 * fetch: Effect.gen(function* () {
 *   const rows = yield* db.select().from(users);
 * });
 * ```
 *
 * The connect work is deferred until the first query and memoized on the
 * current `ExecutionContext` (`ctx.cache`), so the pool is built at most
 * once per execution — a Worker `fetch`/`queue`/`scheduled` event or a
 * Workflow run — and reused across every query and `task` step in that
 * execution. Yielding the connection string is likewise deferred, so
 * deploy / plan-time invocations (where `WorkerEnvironment` isn't
 * provided) never trigger a real connection attempt.
 *
 * The pool is built against the execution's `Scope` (`ctx.scope`), so its
 * `end` finalizer fires when that scope closes — when the request / run
 * settles, not when the `Cloudflare.Worker` init scope closes. Init runs
 * inside `Effect.scoped` and closes after returning the exports object;
 * building lazily against `ctx.scope` (rather than that init scope) is
 * what keeps later requests from seeing "Cannot use a pool after end".
 *
 * @binding
 */

export const postgres = <
  TRelations extends AnyRelations = EmptyRelations,
  E = never,
  R = never,
>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
  config?: PgDrizzle.EffectDrizzlePgConfig<TRelations>,
) =>
  Effect.sync(function () {
    const symbol = Symbol();

    return proxyChain<
      EffectPgDatabase<TRelations> & {
        $client: PgClient.PgClient;
      }
    >(
      Effect.gen(function* () {
        const ctx = yield* ExecutionContext;
        return yield* (ctx.cache[symbol] ??= yield* Effect.gen(function* () {
          const pgCtx = yield* Layer.buildWithScope(
            PgClient.layer({ url: yield* connectionString }),
            ctx.scope,
          );
          return yield* PgDrizzle.makeWithDefaults(config).pipe(
            Effect.provideContext(pgCtx),
          );
        }).pipe(Effect.cached));
      }) as Effect.Effect<
        EffectPgDatabase<TRelations> & {
          $client: PgClient.PgClient;
        }
      >,
    );
  });
