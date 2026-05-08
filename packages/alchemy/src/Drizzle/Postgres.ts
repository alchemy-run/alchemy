import * as PgClient from "@effect/sql-pg/PgClient";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import {
  drizzle as nodePgDrizzle,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
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
 * Behind the scenes the actual connect work is wrapped in `Effect.cached`,
 * so the pool is built at most once per JS realm. Yielding the
 * connection string is also deferred until first query, so deploy /
 * plan-time invocations (where `WorkerEnvironment` isn't provided)
 * never trigger a real connection attempt.
 *
 * The PgClient pool is built against an isolated, never-closing `Scope`
 * so it outlives whatever scope this helper is yielded under. In a
 * Cloudflare Worker the surrounding `Cloudflare.Worker` runs init
 * inside `Effect.scoped`, which closes after returning the exports
 * object — without an isolated scope, the pool's `end` finalizer
 * would fire there and every subsequent request would see "Cannot
 * use a pool after end".
 *
 * The returned object also exposes a `.raw` Effect that resolves to a
 * vanilla `drizzle-orm/node-postgres` instance backed by the same
 * connection string. Use it for libraries that expect a regular
 * promise-shaped drizzle (e.g. better-auth's `drizzleAdapter`):
 *
 * ```typescript
 * const db = yield* Drizzle.postgres(hd.connectionString);
 * const raw = yield* db.raw;
 *
 * const auth = betterAuth({
 *   database: drizzleAdapter(raw, { provider: "pg", schema }),
 * });
 * ```
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
    const effectSymbol = Symbol();
    const rawSymbol = Symbol();

    const effectDb = proxyChain<
      EffectPgDatabase<TRelations> & {
        $client: PgClient.PgClient;
      }
    >(
      Effect.gen(function* () {
        const ctx = yield* ExecutionContext;
        return yield* (ctx.cache[effectSymbol] ??= yield* Effect.gen(
          function* () {
            const pgCtx = yield* Layer.buildWithScope(
              PgClient.layer({ url: yield* connectionString }),
              ctx.scope,
            );
            return yield* PgDrizzle.makeWithDefaults(config).pipe(
              Effect.provideContext(pgCtx),
            );
          },
        ).pipe(Effect.cached));
      }) as Effect.Effect<
        EffectPgDatabase<TRelations> & {
          $client: PgClient.PgClient;
        }
      >,
    );

    const raw = Effect.gen(function* () {
      const ctx = yield* ExecutionContext;
      return yield* (ctx.cache[rawSymbol] ??= yield* Effect.gen(function* () {
        const url = Redacted.value(yield* connectionString);
        return nodePgDrizzle<TRelations>(url);
      }).pipe(Effect.cached));
    }) as Effect.Effect<NodePgDatabase<TRelations>, E, R | ExecutionContext>;

    return new Proxy(effectDb as any, {
      get(target, prop, receiver) {
        if (prop === "raw") return raw;
        return Reflect.get(target, prop, receiver);
      },
    }) as EffectPgDatabase<TRelations> & {
      $client: PgClient.PgClient;
      raw: Effect.Effect<NodePgDatabase<TRelations>, E, R | ExecutionContext>;
    };
  });
