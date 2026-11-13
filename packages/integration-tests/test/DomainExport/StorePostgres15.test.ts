/** Opt-in (`--tags export-versions`): the SQL suites on Postgres 15. */
import { images } from "./fixtures/docker.ts";
import { sqlServerSuite } from "./fixtures/sql.ts";

sqlServerSuite({
  file: import.meta.url,
  server: "postgres",
  image: images.postgres15,
  version: "15",
  optIn: true,
});
