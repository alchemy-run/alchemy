/** Opt-in (`--tags export-versions`): the SQL suites on Postgres 14. */
import { images } from "./fixtures/docker.ts";
import { sqlServerSuite } from "./fixtures/sql.ts";

sqlServerSuite({
  file: import.meta.url,
  server: "postgres",
  image: images.postgres14,
  version: "14",
  optIn: true,
});
