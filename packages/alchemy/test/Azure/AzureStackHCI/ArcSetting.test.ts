import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hci from "@distilled.cloud/azure/azurestackhci";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getArcSetting = (resourceGroupName: string, clusterName: string) =>
  Effect.gen(function* () {
    return yield* hci.GetArcSettings({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      arcSettingName: "default",
    });
  });

const program = (props: { useInfraGroup: boolean; connectivity: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Both candidate Arc instance groups stay deployed across the
    // replacement step.
    const infra = yield* Azure.Resources.ResourceGroup("Infra", {
      location: "eastus",
    });
    const cluster = yield* Azure.AzureStackHCI.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
    });
    const arc = yield* Azure.AzureStackHCI.ArcSetting("Arc", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      arcInstanceResourceGroup: props.useInfraGroup
        ? infra.resourceGroupName
        : group.resourceGroupName,
      connectivityProperties: { enabled: props.connectivity },
    });
    return { group, infra, cluster, arc };
  });

// Cluster record + Arc setting without hardware: free, seconds to create.
test.provider(
  "create, update, replace, and delete Arc settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, arc } = yield* stack.deploy(
        program({ useInfraGroup: false, connectivity: false }),
      );
      const get = () =>
        getArcSetting(group.resourceGroupName, cluster.clusterName);
      expect(arc.arcSettingName).toEqual("default");
      const observed = yield* get();
      expect(
        observed.properties?.arcInstanceResourceGroup?.toLowerCase(),
      ).toEqual(group.resourceGroupName.toLowerCase());
      expect(observed.properties?.connectivityProperties?.enabled).toEqual(
        false,
      );

      // In place: enable Arc connectivity.
      const updated = yield* stack.deploy(
        program({ useInfraGroup: false, connectivity: true }),
      );
      expect(updated.arc.arcSettingId).toEqual(arc.arcSettingId);
      expect(updated.arc.connectivityEnabled).toEqual(true);
      const reobserved = yield* get();
      expect(reobserved.properties?.connectivityProperties?.enabled).toEqual(
        true,
      );

      // Replacement: the Arc instance resource group is immutable.
      const replaced = yield* stack.deploy(
        program({ useInfraGroup: true, connectivity: true }),
      );
      const replacedObserved = yield* get();
      expect(
        replacedObserved.properties?.arcInstanceResourceGroup?.toLowerCase(),
      ).toEqual(replaced.infra.resourceGroupName.toLowerCase());

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
