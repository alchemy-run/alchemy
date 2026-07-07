import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Planetscale from "@/Planetscale/index.ts";
import * as Effect from "effect/Effect";

/**
 * Shared Planetscale + Cloudflare wiring used by the Hyperdrive
 * fixture worker. A long-lived staging Postgres database (named
 * deterministically so reruns adopt the same resource) owns a feature
 * branch + role. The live Hyperdrive config points at the direct
 * `role.origin`; local dev bypasses Hyperdrive, so it uses
 * `role.pooledOrigin` to avoid one direct connection per worker request.
 */
export const PlanetscaleDb = Effect.gen(function* () {
  const database = yield* Planetscale.PostgresDatabase("HyperdriveTestDb", {
    name: "alchemy-postgres-hyperdrive",
    region: { slug: "us-east" },
    clusterSize: "PS_10",
  });

  const branch = yield* Planetscale.PostgresBranch("HyperdriveTestBranch", {
    database,
    migrationsDir:
      "./packages/alchemy/test/Planetscale/Postgres/fixtures/migrations",
  });

  const role = yield* Planetscale.PostgresRole("HyperdriveTestRole", {
    database,
    branch,
    inheritedRoles: ["postgres"],
  });

  return { database, branch, role };
});

export const Hyperdrive = Effect.gen(function* () {
  const { role } = yield* PlanetscaleDb;
  return yield* Cloudflare.Hyperdrive.Connection("HyperdriveTestEdge", {
    origin: role.origin,
    dev: role.pooledOrigin,
    // The test asserts read-your-writes across separate HTTP requests;
    // Hyperdrive's query cache (60s default) would serve stale SELECTs.
    caching: { disabled: true },
  });
});
