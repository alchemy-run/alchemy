import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Prisma from "@/Prisma/index.ts";
import * as Effect from "effect/Effect";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prisma schema + D1 database wiring for the Prisma-over-D1 e2e test.
 *
 * `Prisma.Schema` regenerates migration SQL (offline, via `prisma migrate
 * diff`) whenever `schema.prisma` drifts from the latest checked-in snapshot;
 * the D1 database consumes the generated directory through `migrationsDir`,
 * so pending migrations are applied as part of the same deploy.
 */
export const Db = Effect.gen(function* () {
  // Resolved inside the effect (not at module scope) so it only runs at
  // deploy time — `import.meta.url` is undefined in the bundled worker.
  const dir = yield* Effect.sync(() =>
    import.meta.url ? path.dirname(fileURLToPath(import.meta.url)) : ".",
  );

  const schema = yield* Prisma.Schema("PrismaD1Schema", {
    schema: path.join(dir, "schema.prisma"),
    out: path.join(dir, "migrations"),
    // The generated client is checked in (see ./generated); regenerating it
    // during deploy would only churn the checkout.
    generateClient: false,
  });

  return yield* Cloudflare.D1.Database("PrismaD1Database", {
    migrationsDir: schema.out,
  });
});
