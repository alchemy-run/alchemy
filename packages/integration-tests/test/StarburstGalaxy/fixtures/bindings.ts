import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Each binding suite's warehouse catalog has an explicit name: the suite
 * deploys it in a stack of its own (`deployWarehouse` in
 * `bindings-warehouse.ts`), and the host binds it with
 * `PostgresqlCatalog.lookup`, which keeps the Neon provider that creates
 * the database out of the Worker's bundle.
 */
export const WAREHOUSES = {
  discovery: "alchemy_test_discovery_warehouse",
  quality: "alchemy_test_quality_warehouse",
  sqlJob: "alchemy_test_sql_job_warehouse",
} as const;

/** A binding suite's warehouse catalog, as a host binds it. */
export const warehouseLookup = (name: string) =>
  StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name });

/**
 * Binding suites deploy a Cloudflare Worker, so they need Cloudflare
 * credentials: run them with STARBURST_GALAXY_TEST_CLOUDFLARE=1 and a
 * profile (ALCHEMY_PROFILE) whose Cloudflare account may host the Worker.
 */
export const cloudflareSkipReason = process.env.STARBURST_GALAXY_TEST_CLOUDFLARE
  ? undefined
  : "STARBURST_GALAXY_TEST_CLOUDFLARE is not set (the Worker host needs Cloudflare credentials)";

/**
 * A SQL job that deletes the orders with a negative ID (there are none):
 * Galaxy runs only update statements as SQL jobs ("SQL is not an update
 * statement: SELECT 1"). It runs on a free cluster with the warehouse
 * attached, as a role that may use the cluster and read and delete the
 * warehouse's orders, scheduled yearly so it runs only when a test runs it.
 */
export const PRUNE_ORDERS = `DELETE FROM ${WAREHOUSES.sqlJob}.sales.orders WHERE id < 0`;

export const PruneOrders = Effect.gen(function* () {
  const warehouse = warehouseLookup(WAREHOUSES.sqlJob);
  const cluster = yield* StarburstGalaxy.Cluster.Cluster("JobCluster", {
    cloudRegionId: "aws-us-east1",
    catalogs: [warehouse.catalogId],
    autoSuspend: "1 minute",
  });
  const runner = yield* StarburstGalaxy.Role.Role("JobRunner", {});
  const orders = {
    kind: "Table",
    catalogId: warehouse.catalogId,
    schemaName: "sales",
    tableName: "orders",
  } as const;
  const useCluster = yield* StarburstGalaxy.Role.RolePrivilege("JobUsesCluster", {
    role: runner.roleId,
    privilege: "UseCluster",
    entity: { kind: "Cluster", clusterId: cluster.clusterId },
  });
  const read = yield* StarburstGalaxy.Role.RolePrivilege("JobReadsOrders", {
    role: useCluster.roleId,
    privilege: "Select",
    entity: orders,
  });
  const prune = yield* StarburstGalaxy.Role.RolePrivilege("JobDeletesOrders", {
    role: read.roleId,
    privilege: "Delete",
    entity: orders,
  });
  return yield* StarburstGalaxy.SqlJob.SqlJob("PruneOrders", {
    role: prune.roleId,
    cluster: cluster.clusterId,
    schedule: "0 0 1 1 *",
    queries: [PRUNE_ORDERS],
  });
});

/**
 * A lakehouse catalog over a public AWS Open Data bucket with keys that
 * are never valid: Galaxy stores it, but cannot read or write the bucket.
 */
export const UnreadableLake = StarburstGalaxy.Catalog.S3Catalog("UnreadableLake", {
  accessKey: "AKIAALCHEMYTESTONLY0",
  secretKey: Redacted.make("alchemy-test-lake"),
  metastore: { type: "galaxy", defaultBucket: "noaa-ghcn-pds", defaultDataLocation: "warehouse" },
  externalTableCreationEnabled: true,
  validate: false,
});

/**
 * A SQL data quality check on the binding warehouse's orders, with what
 * Galaxy needs to run it: a free cluster with the warehouse attached, and
 * the table's yearly schedule, whose role may use the cluster and read
 * the warehouse (Galaxy runs SQL checks as that role).
 */
export const OrdersCheck = Effect.gen(function* () {
  const BindingsWarehouse = warehouseLookup(WAREHOUSES.quality);
  const cluster = yield* StarburstGalaxy.Cluster.Cluster("QualityCluster", {
    cloudRegionId: "aws-us-east1",
    catalogs: [BindingsWarehouse.catalogId],
    autoSuspend: "1 minute",
  });
  const role = yield* StarburstGalaxy.Role.Role("QualityRunner", {});
  const useCluster = yield* StarburstGalaxy.Role.RolePrivilege("QualityUsesCluster", {
    role: role.roleId,
    privilege: "UseCluster",
    entity: { kind: "Cluster", clusterId: cluster.clusterId },
  });
  const readWarehouse = yield* StarburstGalaxy.Role.RolePrivilege("QualityReadsWarehouse", {
    role: useCluster.roleId,
    privilege: "Select",
    entity: {
      kind: "Table",
      catalogId: BindingsWarehouse.catalogId,
      schemaName: "sales",
      tableName: "*",
    },
  });
  const schedule = yield* StarburstGalaxy.DataQuality.DataQualitySchedule("Orders", {
    catalogId: BindingsWarehouse.catalogId,
    schemaName: "sales",
    tableName: "orders",
    clusterId: cluster.clusterId,
    roleId: readWarehouse.roleId,
    schedule: "0 0 1 1 *",
  });
  return yield* StarburstGalaxy.DataQuality.DataQualityCheck("OrdersPresent", {
    catalogId: schedule.catalogId,
    schemaName: "sales",
    tableName: "orders",
    kind: "SqlQuery",
    query: `SELECT count(*) > 0 FROM ${WAREHOUSES.quality}.sales.orders`,
    clusterId: cluster.clusterId,
    severity: "High",
    category: "Completeness",
  });
});
