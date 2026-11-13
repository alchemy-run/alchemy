/** Tier B: `Export.Sql.store` and the SQL engine on MySQL 8.4 LTS, with `mysql` reading the stable name. */
import { images } from "./fixtures/docker.ts";
import { sqlServerSuite } from "./fixtures/sql.ts";

sqlServerSuite({ file: import.meta.url, server: "mysql", image: images.mysql, version: "8.4" });
