import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { withPublicIps, withVcpus } from "../gates.ts";
import {
  getCluster,
  logLevel,
  tags,
  testCluster,
  untilGone,
} from "./cluster.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfig = (
  resourceGroupName: string,
  resourceName: string,
  configName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetMaintenanceConfiguration({
      subscriptionId,
      resourceGroupName,
      resourceName,
      configName,
    });
  });

const program = (dayOfWeek: "Sunday" | "Saturday", withConfig = true) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* testCluster("westus2");
    const config = withConfig
      ? yield* Azure.ContainerService.MaintenanceConfiguration("Upgrades", {
          resourceGroup: group.resourceGroupName,
          cluster: cluster.clusterName,
          name: "aksManagedAutoUpgradeSchedule",
          maintenanceWindow: {
            schedule: { weekly: { intervalWeeks: 1, dayOfWeek } },
            durationHours: 4,
            startTime: "02:00",
            utcOffset: "+00:00",
          },
        })
      : undefined;
    return { group, cluster, config };
  });

// Test cluster (~6 min create, ~5 min delete, ~$0.03); the configuration
// itself is a synchronous, free PUT.
test.provider(
  "create, update, and delete a maintenance configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program("Sunday"));
      const { group, cluster, config } = created;
      expect(config?.configName).toEqual("aksManagedAutoUpgradeSchedule");
      const observed = yield* getConfig(
        group.resourceGroupName,
        cluster.clusterName,
        "aksManagedAutoUpgradeSchedule",
      );
      expect(
        observed.properties?.maintenanceWindow?.schedule.weekly?.dayOfWeek,
      ).toEqual("Sunday");
      expect(observed.properties?.maintenanceWindow?.durationHours).toEqual(4);

      yield* stack.deploy(program("Saturday"));
      const reobserved = yield* getConfig(
        group.resourceGroupName,
        cluster.clusterName,
        "aksManagedAutoUpgradeSchedule",
      );
      expect(
        reobserved.properties?.maintenanceWindow?.schedule.weekly?.dayOfWeek,
      ).toEqual("Saturday");

      // Removing the configuration deletes it while the cluster stays.
      yield* stack.deploy(program("Saturday", false));
      expect(
        yield* untilGone(
          getConfig(
            group.resourceGroupName,
            cluster.clusterName,
            "aksManagedAutoUpgradeSchedule",
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getCluster(group.resourceGroupName, cluster.clusterName),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), withVcpus(2), logLevel),
  { tags: [...tags], timeout: 900_000 },
);
