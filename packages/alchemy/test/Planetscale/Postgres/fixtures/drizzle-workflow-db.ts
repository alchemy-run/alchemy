import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Planetscale from "@/Planetscale/index.ts";
import * as Effect from "effect/Effect";

/**
 * Planetscale + Cloudflare wiring for the Drizzle-in-Workflow regression
 * test. Its own deterministically-named database (separate from the
 * Hyperdrive fixture's) so the two Postgres suites never contend for the
 * same branch/role when both run. Reuses the shared `schema.ts` + migrations
 * (the `alchemy_postgres_widgets` table) since they only define a table.
 */
export const PlanetscaleDb = Effect.gen(function* () {
  const database = yield* Planetscale.PostgresDatabase("DrizzleWorkflowDb", {
    name: "alchemy-postgres-drizzle-workflow",
    region: { slug: "us-east" },
    clusterSize: "PS_10",
  });

  const branch = yield* Planetscale.PostgresBranch("DrizzleWorkflowBranch", {
    database,
    migrationsDir:
      "./packages/alchemy/test/Planetscale/Postgres/fixtures/migrations",
  });

  const role = yield* Planetscale.PostgresRole("DrizzleWorkflowRole", {
    database,
    branch,
    inheritedRoles: ["postgres"],
  });

  return { database, branch, role };
});

export const Hyperdrive = Effect.gen(function* () {
  const { role } = yield* PlanetscaleDb;
  return yield* Cloudflare.Hyperdrive("DrizzleWorkflowEdge", {
    origin: role.origin,
  });
});
