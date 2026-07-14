import { PrismaNeon } from "@prisma/adapter-neon";
import type { SqlDriverAdapterFactory } from "@prisma/client/runtime/client";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { EffectPrismaClient, PrismaClientLike } from "./Client.ts";
import { client } from "./Client.ts";

/** `@prisma/adapter-neon` declares its options type without exporting it. */
type PrismaNeonOptions = ConstructorParameters<typeof PrismaNeon>[1];

/**
 * Open a Prisma client over Neon's serverless driver
 * (`@prisma/adapter-neon`), which speaks to Neon over WebSockets — use this
 * to reach Neon directly from a Worker without a Hyperdrive in front. With
 * Hyperdrive, prefer `alchemy/Prisma/Postgres` instead.
 *
 * ```typescript
 * import { PrismaClient } from "./generated/client.ts";
 *
 * const prisma = yield* Prisma.neon(PrismaClient, connectionString);
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* prisma.user.findMany();
 * });
 * ```
 *
 * @binding
 */
export const neon = <C extends PrismaClientLike, E = never, R = never>(
  Client: new (options: { adapter: SqlDriverAdapterFactory }) => C,
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
  options?: PrismaNeonOptions,
): Effect.Effect<EffectPrismaClient<C>> =>
  client(
    Effect.gen(function* () {
      const url = Redacted.value(yield* connectionString);
      return new Client({
        adapter: new PrismaNeon({ connectionString: url }, options),
      });
    }) as Effect.Effect<C>,
  );
