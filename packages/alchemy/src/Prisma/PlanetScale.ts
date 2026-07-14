import { PrismaPlanetScale } from "@prisma/adapter-planetscale";
import type { SqlDriverAdapterFactory } from "@prisma/client/runtime/client";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { EffectPrismaClient, PrismaClientLike } from "./Client.ts";
import { client } from "./Client.ts";

/** Credentials for PlanetScale's fetch-based MySQL driver. */
export interface PlanetScaleConfig {
  host: string;
  username: string;
  password: Redacted.Redacted<string>;
}

/**
 * Open a Prisma client over a PlanetScale MySQL database using the
 * `@prisma/adapter-planetscale` driver adapter, which speaks PlanetScale's
 * fetch-based protocol — no TCP socket and no Hyperdrive required, so it
 * works from any Worker.
 *
 * Pass your generated `PrismaClient` class and an Effect yielding the branch
 * credentials (a `Planetscale.MySQLPassword`'s `host` / `username` /
 * `password`):
 *
 * ```typescript
 * import { PrismaClient } from "./generated/client.ts";
 *
 * const prisma = yield* Prisma.planetscale(PrismaClient, credentials);
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* prisma.user.findMany();
 * });
 * ```
 *
 * Use a `mysql` datasource in `schema.prisma`. For PlanetScale **Postgres**
 * branches, use `alchemy/Prisma/Postgres` with the role's `connectionUrl`
 * instead.
 *
 * @binding
 */
export const planetscale = <C extends PrismaClientLike, E = never, R = never>(
  Client: new (options: { adapter: SqlDriverAdapterFactory }) => C,
  config: Effect.Effect<PlanetScaleConfig, E, R>,
): Effect.Effect<EffectPrismaClient<C>> =>
  client(
    Effect.gen(function* () {
      const { host, username, password } = yield* config;
      return new Client({
        adapter: new PrismaPlanetScale({
          host,
          username,
          password: Redacted.value(password),
        }),
      });
    }) as Effect.Effect<C>,
  );
