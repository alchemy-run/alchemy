/**
 * Live (opt-in: `NEON_TEST=1` and `--tags export-live`): the SQL store
 * and engine on a Neon project this file deploys, destroyed when the file
 * ends.
 */
import * as Neon from "@alchemy.run/neon";
import { PgClient } from "@effect/sql-pg";
import * as Redacted from "effect/Redacted";
import { liveSqlSuite } from "./fixtures/live.ts";

liveSqlSuite({
  file: import.meta.url,
  label: "Neon",
  gate: "NEON_TEST",
  providerTags: ["provider:neon", "provider:neon:project"],
  options: { providers: Neon.providers() },
  deploy: Neon.Project("Exports"),
  client: (project) => PgClient.layer({ url: Redacted.make(project.connectionUri) }),
  dialect: "postgres",
});
