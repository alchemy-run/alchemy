/** Opt-in (`--tags export-versions`): the SQL suites on MySQL 8.0. */
import { images } from "./fixtures/docker.ts";
import { sqlServerSuite } from "./fixtures/sql.ts";

sqlServerSuite({
  file: import.meta.url,
  server: "mysql",
  image: images.mysql80,
  version: "8.0",
  optIn: true,
});
