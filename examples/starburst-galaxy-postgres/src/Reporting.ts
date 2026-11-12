import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Effect from "effect/Effect";
import { Warehouse } from "./Warehouse.ts";

/**
 * A free cluster over the warehouse, and a reporting login: a role that
 * may use the cluster and read the `shop` schema, and a service account
 * with that role and a Trino password.
 */
export const Reporting = Effect.gen(function* () {
  const shop = yield* Warehouse;

  // It suspends after a minute without queries; the next query resumes it.
  const cluster = yield* StarburstGalaxy.Cluster.Cluster("Analytics", {
    cloudRegionId: "aws-us-east1",
    catalogs: [shop.catalogId],
    autoSuspend: "1 minute",
  });

  const reporting = yield* StarburstGalaxy.Role.Role("Reporting", {
    description: "Reads the shop schema",
  });
  yield* StarburstGalaxy.Role.RolePrivilege("ReportingUsesCluster", {
    role: reporting.roleId,
    privilege: "UseCluster",
    entity: { kind: "Cluster", clusterId: cluster.clusterId },
  });
  yield* StarburstGalaxy.Role.RolePrivilege("ReportingReadsShop", {
    role: reporting.roleId,
    privilege: "Select",
    entity: { kind: "Table", catalogId: shop.catalogId, schemaName: "shop", tableName: "*" },
  });

  const reporter = yield* StarburstGalaxy.ServiceAccount.ServiceAccount("Reporter", {
    role: reporting.roleId,
  });
  const password = yield* StarburstGalaxy.ServiceAccount.ServiceAccountPassword(
    "ReporterPassword",
    {
      serviceAccount: reporter.serviceAccountId,
    },
  );

  return { shop, cluster, reporting, reporter, password };
});
