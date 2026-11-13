/**
 * Live (opt-in: `PLANETSCALE_TEST=1` and `--tags export-live`): the SQL
 * store and engine on a PlanetScale MySQL (Vitess) database this file
 * deploys, over TLS, destroyed when the file ends.
 */
import * as Planetscale from "@alchemy.run/planetscale";
import { MysqlClient } from "@effect/sql-mysql2";
import * as Effect from "effect/Effect";
import { liveSqlSuite } from "./fixtures/live.ts";

liveSqlSuite({
  file: import.meta.url,
  label: "PlanetScale MySQL",
  gate: "PLANETSCALE_TEST",
  providerTags: ["provider:planetscale", "provider:planetscale:mysql"],
  options: { providers: Planetscale.providers() },
  deploy: Effect.gen(function* () {
    const database = yield* Planetscale.MySQLDatabase("Exports", { clusterSize: "PS_10" });
    return yield* Planetscale.MySQLPassword("Writer", { database, role: "admin" });
  }),
  client: (password) =>
    MysqlClient.layer({
      host: password.host,
      database: password.database,
      username: password.username,
      password: password.password,
      poolConfig: { ssl: { rejectUnauthorized: true }, timezone: "Z" },
    }),
  dialect: "mysql",
});
