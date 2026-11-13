/** Tier B: `Export.Sql.store` and the SQL engine on Postgres 17, with `psql` reading the stable name. */
import { images } from "./fixtures/docker.ts";
import { sqlServerSuite } from "./fixtures/sql.ts";

sqlServerSuite({
  file: import.meta.url,
  server: "postgres",
  image: images.postgres,
  version: "17",
});
