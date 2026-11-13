/** Opt-in (`--tags export-versions`): the SQL suites on ClickHouse 25.3 LTS. */
import { images } from "./fixtures/docker.ts";
import { sqlServerSuite } from "./fixtures/sql.ts";

sqlServerSuite({
  file: import.meta.url,
  server: "clickhouse",
  image: images.clickhouse253,
  version: "25.3",
  optIn: true,
});
