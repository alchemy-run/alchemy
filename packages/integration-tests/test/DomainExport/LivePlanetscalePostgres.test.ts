/**
 * Live (opt-in: `PLANETSCALE_TEST=1` and `--tags export-live`): the SQL
 * store and engine on a PlanetScale Postgres database this file deploys,
 * destroyed when the file ends.
 */
import * as Planetscale from "@alchemy.run/planetscale";
import { PgClient } from "@effect/sql-pg";
import * as Effect from "effect/Effect";
import { liveSqlSuite } from "./fixtures/live.ts";

liveSqlSuite({
  file: import.meta.url,
  label: "PlanetScale Postgres",
  gate: "PLANETSCALE_TEST",
  providerTags: ["provider:planetscale", "provider:planetscale:postgres"],
  options: { providers: Planetscale.providers() },
  deploy: Effect.gen(function* () {
    const database = yield* Planetscale.PostgresDatabase("Exports", { clusterSize: "PS_10" });
    return yield* Planetscale.PostgresRole("Writer", { database, inheritedRoles: ["postgres"] });
  }),
  client: (role) => PgClient.layer({ url: role.connectionUrl }),
  dialect: "postgres",
});
