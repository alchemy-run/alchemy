/** Opt-in (`--tags export-versions`): the SQL suites on Postgres 16. */
import { images } from "./fixtures/docker.ts";
import { sqlServerSuite } from "./fixtures/sql.ts";

sqlServerSuite({
  file: import.meta.url,
  server: "postgres",
  image: images.postgres16,
  version: "16",
  optIn: true,
});
