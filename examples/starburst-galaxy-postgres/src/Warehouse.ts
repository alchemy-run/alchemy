import * as path from "node:path";
import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Effect from "effect/Effect";

/**
 * A Neon Postgres database with a `shop.orders` table, connected to
 * Galaxy as a catalog. Galaxy checks the connection on every deploy.
 */
export const Warehouse = Effect.gen(function* () {
  const db = yield* Neon.Project("ShopDb", {
    migrations: path.join(import.meta.dirname, "..", "migrations"),
    // The Neon free plan keeps at most six hours of history.
    historyRetentionSeconds: 21600,
  });
  return yield* StarburstGalaxy.Catalog.PostgresqlCatalog("Shop", {
    endpoint: db.origin.host,
    databaseName: db.origin.database,
    username: db.origin.user,
    password: db.origin.password,
  });
});
