import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as Prisma from "@/Prisma/index.ts";
import * as Effect from "effect/Effect";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prisma + Neon + Cloudflare wiring for the Prisma-over-Hyperdrive e2e test.
 * A Prisma.Schema resource generates migration SQL from `schema.prisma`, a
 * Neon project + branch applies those migrations on deploy, and a Cloudflare
 * Hyperdrive fronts the branch's Postgres origin.
 */
export const Schema = Effect.gen(function* () {
  // Resolved inside the effect (not at module scope) so it only runs at
  // deploy time — `import.meta.url` is undefined in the bundled worker.
  const fixtureDir = yield* Effect.sync(() =>
    path.join(import.meta.url ? fileURLToPath(import.meta.url) : ".", ".."),
  );

  return yield* Prisma.Schema("PrismaWorkerSchema", {
    schema: path.join(fixtureDir, "schema.prisma"),
    out: path.join(fixtureDir, "migrations"),
    // The generated client is checked in (see ./generated); regenerating it
    // on deploy would churn the checked-in fixture. Effect-schema emission
    // is exercised by the D1 fixture; keep this one client-only.
    generateClient: false,
    effectSchemas: false,
  });
});

export const NeonDb = Effect.gen(function* () {
  const schema = yield* Schema;

  const project = yield* Neon.Project("PrismaWorkerProject", {
    region: "aws-us-east-1",
  });

  const branch = yield* Neon.Branch("PrismaWorkerBranch", {
    project,
    migrationsDir: schema.out,
  });

  return { project, branch };
});

export const Hyperdrive = Effect.gen(function* () {
  const { branch } = yield* NeonDb;
  return yield* Cloudflare.Hyperdrive.Connection("PrismaWorkerEdge", {
    origin: branch.origin,
    // The test asserts read-after-write (PUT then GET). Hyperdrive's default
    // SELECT caching (~60s TTL) can serve a pre-insert empty result — and
    // keep serving it across retries — so caching is disabled.
    caching: { disabled: true },
  });
});
