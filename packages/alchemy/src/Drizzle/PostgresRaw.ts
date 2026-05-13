import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import {
  drizzle as nodePgDrizzle,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ExecutionContext } from "../ExecutionContext.ts";

/**
 * Open a vanilla `drizzle-orm/node-postgres` database from a connection
 * URL. Returns a regular promise-shaped drizzle client — use this for
 * libraries that expect that shape (e.g. better-auth's `drizzleAdapter`).
 *
 * For the Effect-flavored client (chainable, integrates with the
 * Effect runtime), use `Drizzle.postgres` instead. The two live in
 * separate modules so apps that only need one don't pay the bundle
 * cost of the other.
 *
 * The drizzle client is cached per-`ExecutionContext` — the pool is
 * built at most once per request.
 *
 * @section Opening a connection
 * @example From a Cloudflare Hyperdrive binding
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Drizzle from "alchemy/Drizzle";
 *
 * const hd = yield* Cloudflare.Hyperdrive.bind(MyHyperdrive);
 * const db = yield* Drizzle.postgresRaw(hd.connectionString);
 *
 * const users = await db.select().from(usersTable);
 * ```
 *
 * @example From a connection URL
 * ```typescript
 * import * as Drizzle from "alchemy/Drizzle";
 * import * as Effect from "effect/Effect";
 * import * as Redacted from "effect/Redacted";
 *
 * const db = yield* Drizzle.postgresRaw(
 *   Effect.succeed(Redacted.make(process.env.DATABASE_URL!)),
 * );
 * ```
 *
 * @section Plugging into better-auth
 * @example Pass the raw client to `drizzleAdapter`
 * ```typescript
 * import { betterAuth } from "better-auth";
 * import { drizzleAdapter } from "better-auth/adapters/drizzle";
 *
 * const raw = yield* Drizzle.postgresRaw(hd.connectionString);
 *
 * const auth = betterAuth({
 *   database: drizzleAdapter(raw, { provider: "pg", schema }),
 * });
 * ```
 *
 * @binding
 */
export const postgresRaw = <
  TRelations extends AnyRelations = EmptyRelations,
  E = never,
  R = never,
>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
) => {
  const symbol = Symbol();
  return Effect.gen(function* () {
    const ctx = yield* ExecutionContext;
    return yield* (ctx.cache[symbol] ??= yield* Effect.gen(function* () {
      const url = Redacted.value(yield* connectionString);
      return nodePgDrizzle<TRelations>(url);
    }).pipe(Effect.cached));
  }) as Effect.Effect<NodePgDatabase<TRelations>, E, R | ExecutionContext>;
};
