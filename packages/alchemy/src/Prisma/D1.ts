import type * as runtime from "@cloudflare/workers-types";
import { PrismaD1 } from "@prisma/adapter-d1";
import type { SqlDriverAdapterFactory } from "@prisma/client/runtime/client";
import * as Effect from "effect/Effect";
import type { EffectPrismaClient, PrismaClientLike } from "./Client.ts";
import { client } from "./Client.ts";

/**
 * Open a Prisma client over a Cloudflare D1 database using the
 * `@prisma/adapter-d1` driver adapter.
 *
 * Pass your generated `PrismaClient` class and the raw `D1Database` binding
 * — the `raw` field of the `Cloudflare.D1.QueryDatabase` binding client:
 *
 * ```typescript
 * import { PrismaClient } from "./generated/client.ts";
 *
 * const db = yield* Cloudflare.D1.QueryDatabase(Database);
 * const prisma = yield* Prisma.d1(PrismaClient, db.raw);
 *
 * fetch: Effect.gen(function* () {
 *   const users = yield* prisma.user.findMany();
 * });
 * ```
 *
 * Use a `sqlite` datasource in `schema.prisma` and feed `Prisma.Schema`'s
 * `out` into the database's `migrationsDir` so migrations apply on deploy.
 *
 * @binding
 */
export const d1 = <C extends PrismaClientLike, E = never, R = never>(
  Client: new (options: { adapter: SqlDriverAdapterFactory }) => C,
  database: Effect.Effect<runtime.D1Database, E, R>,
): Effect.Effect<EffectPrismaClient<C>> =>
  client(
    Effect.gen(function* () {
      const db = yield* database;
      return new Client({ adapter: new PrismaD1(db) });
    }) as Effect.Effect<C>,
  );
