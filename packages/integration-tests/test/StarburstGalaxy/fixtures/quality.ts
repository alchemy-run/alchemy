import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { SALES, Warehouse } from "./warehouse.ts";

// Yearly: no evaluation starts the cluster unless a test asks for one.
const YEARLY = "0 0 1 1 *";

/**
 * The warehouse, a free cluster that suspends after a minute with the
 * warehouse attached, and a role that may use the cluster and read the
 * warehouse. The table's yearly data quality schedule runs as that role,
 * which is the role Galaxy runs SQL checks as: without the schedule, a
 * SQL check is refused with "Access Denied: Cannot select from columns".
 */
export const QualityWarehouse = Effect.gen(function* () {
  const catalog = yield* Warehouse;
  const cluster = yield* StarburstGalaxy.Cluster.Cluster("Quality", {
    cloudRegionId: "aws-us-east1",
    catalogs: [catalog.catalogId],
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
    entity: { kind: "Table", catalogId: catalog.catalogId, schemaName: "sales", tableName: "*" },
  });
  const schedule = yield* StarburstGalaxy.DataQuality.DataQualitySchedule("Orders", {
    catalogId: catalog.catalogId,
    ...SALES,
    clusterId: cluster.clusterId,
    roleId: readWarehouse.roleId,
    schedule: YEARLY,
  });
  return { catalog, cluster, role, schedule };
});

/**
 * Evaluate a check now and wait for an evaluation that started after the
 * call (the cluster may have to start first: up to ten minutes).
 */
export const evaluateNow = (dataQualityCheckId: string, clusterId?: string) =>
  Effect.gen(function* () {
    const requestedAt = new Date();
    yield* galaxy.dataQuality.evaluateDataQualityCheck({
      dataQualityCheckId,
      body: { dataQualityCheckId, clusterId },
    });
    return yield* galaxy.dataQuality
      .getLatestDataQualityCheckEvaluation({ dataQualityCheckId })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds").pipe(Schedule.upTo({ duration: "10 minutes" })),
          until: (check) =>
            check.latestEvaluation !== undefined &&
            new Date(check.latestEvaluation.evaluatedAt) >= requestedAt,
        }),
      );
  });
