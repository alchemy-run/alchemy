import { PrismaPg } from "@prisma/adapter-pg";
import type { SqlDriverAdapterFactory } from "@prisma/client/runtime/client";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { EffectPrismaClient, PrismaClientLike } from "./Client.ts";
import { client } from "./Client.ts";

/** `@prisma/adapter-pg` declares its options type without exporting it. */
type PrismaPgOptions = ConstructorParameters<typeof PrismaPg>[1];

/**
 * Open a Prisma client over any Postgres connection string using the
 * `@prisma/adapter-pg` driver adapter — Cloudflare Hyperdrive, Neon,
 * PlanetScale Postgres, or a plain Postgres database.
 *
 * Pass your generated `PrismaClient` class and an Effect yielding the
 * connection string. Every query is an Effect; the client (and its `pg`
 * pool) is built lazily on first query and memoized per execution, closing
 * when the request settles:
 *
 * ```typescript
 * import { PrismaClient } from "./generated/client.ts";
 *
 * const hd = yield* Cloudflare.Hyperdrive.Connect(Hyperdrive);
 * const prisma = yield* Prisma.postgres(PrismaClient, hd.connectionString);
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* prisma.user.findMany();
 * });
 * ```
 *
 * @binding
 */
export const postgres = <C extends PrismaClientLike, E = never, R = never>(
  Client: new (options: { adapter: SqlDriverAdapterFactory }) => C,
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
  options?: PrismaPgOptions,
): Effect.Effect<EffectPrismaClient<C>> =>
  client(
    Effect.gen(function* () {
      const url = Redacted.value(yield* connectionString);
      return new Client({ adapter: new PrismaPg(url, options) });
    }) as Effect.Effect<C>,
  );
