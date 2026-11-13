/** Tier B: `Export.Sql.store` and the SQL engine on ClickHouse 25.8 LTS, with `clickhouse-client` reading the stable name. */
import { images } from "./fixtures/docker.ts";
import { sqlServerSuite } from "./fixtures/sql.ts";

sqlServerSuite({
  file: import.meta.url,
  server: "clickhouse",
  image: images.clickhouse,
  version: "25.8",
});
