import * as Neon from "@alchemy.run/neon";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SALES, Warehouse } from "../fixtures/warehouse.ts";
import { freshStack } from "../helpers.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(StarburstGalaxy.providers(), Neon.providers()),
});

test.provider(
  "schedule a table's checks, move the schedule, and remove it",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const app = (schedule?: { cron: string; timezone?: string }) =>
        Effect.gen(function* () {
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
          // The schedule's role must see the table: Galaxy answers NotFound
          // "Table: [...] not found" for a role that may not read it.
          const readOrders = yield* StarburstGalaxy.Role.RolePrivilege("QualityReadsOrders", {
            role: useCluster.roleId,
            privilege: "Select",
            entity: { kind: "Table", catalogId: catalog.catalogId, ...SALES },
          });
          const scheduled =
            schedule === undefined
              ? undefined
              : yield* StarburstGalaxy.DataQuality.DataQualitySchedule("Orders", {
                  catalogId: catalog.catalogId,
                  ...SALES,
                  clusterId: cluster.clusterId,
                  roleId: readOrders.roleId,
                  schedule: schedule.cron,
                  timezone: schedule.timezone,
                });
          return { catalog, cluster, role, scheduled };
        });

      // Yearly, so no evaluation starts the cluster during the test.
      const created = yield* stack.deploy(app({ cron: "0 0 1 1 *" }));
      const ids = {
        catalogId: created.catalog.catalogId,
        schemaId: SALES.schemaName,
        tableId: SALES.tableName,
      };
      const live = yield* galaxy.dataQualitySchedule.getDataQualitySchedule(ids);
      expect(live.cronExpression).toBe("0 0 1 1 *");
      expect(live.timezone).toBe("UTC");
      expect(live.clusterId).toBe(created.cluster.clusterId);
      expect(live.roleId).toBe(created.role.roleId);

      const moved = yield* stack.deploy(app({ cron: "0 0 1 7 *", timezone: "Europe/Paris" }));
      expect(moved.scheduled?.dataQualityScheduleId).toBe(created.scheduled?.dataQualityScheduleId);
      const movedLive = yield* galaxy.dataQualitySchedule.getDataQualitySchedule(ids);
      expect(movedLive.cronExpression).toBe("0 0 1 7 *");
      expect(movedLive.timezone).toBe("Europe/Paris");

      // Removing the resource removes the schedule.
      yield* stack.deploy(app());
      const gone = yield* galaxy.dataQualitySchedule.getDataQualitySchedule(ids).pipe(Effect.flip);
      expect(gone._tag).toBe("NotFound");

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: [
      "provider:starburst-galaxy",
      "provider:starburst-galaxy:data-quality",
      "provider:neon",
      "live",
    ],
    timeout: 600_000,
  },
);
