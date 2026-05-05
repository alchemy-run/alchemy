import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { proxyChain } from "../Util/proxy-chain.ts";

type Db =
  ReturnType<typeof PgDrizzle.makeWithDefaults> extends Effect.Effect<
    infer A,
    any,
    any
  >
    ? A
    : never;

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
 * @binding
 */
export const postgres = <E, R>(connectionString: Effect.Effect<string, E, R>) =>
  Effect.gen(function* () {
    const cached = yield* Effect.cached(
      Effect.gen(function* () {
        const url = yield* connectionString;
        const detachedScope = yield* Scope.make();
        const pgCtx = yield* Layer.buildWithScope(
          PgClient.layer({ url: Redacted.make(url) }),
          detachedScope,
        );
        return yield* PgDrizzle.makeWithDefaults().pipe(
          Effect.provideContext(pgCtx),
        );
      }),
    );
    return proxyChain<Db>(cached);
  });
