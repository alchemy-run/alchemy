import * as path from "node:path";
import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Effect from "effect/Effect";

/**
 * A Neon project whose migration creates `sales.orders` (three rows), and
 * a validated Galaxy PostgreSQL catalog over it: a real schema and table
 * for the discovery, data quality and binding tests. Galaxy reads the
 * catalog's schemas and tables without a cluster.
 */
export const Warehouse = Effect.gen(function* () {
  const project = yield* Neon.Project("WarehouseDb", {
    migrations: path.join(import.meta.dirname, "warehouse"),
    // The free plan's ceiling.
    historyRetentionSeconds: 21600,
  });
  return yield* StarburstGalaxy.PostgresqlCatalog("Warehouse", {
    endpoint: project.origin.host,
    databaseName: project.origin.database,
    username: project.origin.user,
    password: project.origin.password,
  });
});

/** The schema and table the warehouse migration creates. */
export const SALES = { schemaName: "sales", tableName: "orders" } as const;
