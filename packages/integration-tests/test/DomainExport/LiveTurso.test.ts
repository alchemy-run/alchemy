/**
 * Live (opt-in: `TURSO_TEST=1` and `--tags export-live`): the SQL store
 * and engine on a Turso (libSQL) database this file deploys, destroyed when
 * the file ends.
 */
import * as Turso from "@alchemy.run/turso";
import { LibsqlClient } from "@effect/sql-libsql";
import * as Effect from "effect/Effect";
import { liveSqlSuite } from "./fixtures/live.ts";

liveSqlSuite({
  file: import.meta.url,
  label: "Turso",
  gate: "TURSO_TEST",
  providerTags: ["provider:turso", "provider:turso:database"],
  options: { providers: Turso.providers() },
  deploy: Effect.gen(function* () {
    const group = yield* Turso.Group("Exports", { location: "aws-us-east-1" });
    const database = yield* Turso.Database("Exports", { group: group.name });
    const token = yield* Turso.DatabaseToken("Writer", { database: database.name });
    return { url: database.url, token: token.token };
  }),
  client: ({ url, token }) => LibsqlClient.layer({ url, authToken: token }),
  dialect: "sqlite",
});
