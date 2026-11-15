import type { BigQueryCatalog } from "./BigQueryCatalog.ts";
import type { CassandraCatalog } from "./CassandraCatalog.ts";
import type { GcsCatalog } from "./GcsCatalog.ts";
import type { MongoDBCatalog } from "./MongoDBCatalog.ts";
import type { MySQLCatalog } from "./MySQLCatalog.ts";
import type { OpenSearchCatalog } from "./OpenSearchCatalog.ts";
import type { PostgresqlCatalog } from "./PostgresqlCatalog.ts";
import type { RedshiftCatalog } from "./RedshiftCatalog.ts";
import type { S3Catalog } from "./S3Catalog.ts";
import type { SnowflakeCatalog } from "./SnowflakeCatalog.ts";
import type { SqlServerCatalog } from "./SqlServerCatalog.ts";

/** Any Galaxy catalog resource, deployed or looked up: what catalog bindings bind to. */
export type AnyCatalog =
  | BigQueryCatalog
  | CassandraCatalog
  | GcsCatalog
  | MongoDBCatalog
  | MySQLCatalog
  | OpenSearchCatalog
  | PostgresqlCatalog
  | RedshiftCatalog
  | S3Catalog
  | SnowflakeCatalog
  | SqlServerCatalog;
