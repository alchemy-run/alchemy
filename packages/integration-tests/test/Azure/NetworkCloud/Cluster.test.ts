import * as Azure from "@alchemy.run/azure";
import * as nc from "@distilled.cloud/azure/networkcloud";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { bogusCustomLocation, logLevel, nexus, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const get = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* nc.GetCluster({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName: name,
    });
  });

const program = (props: { env: string; clusterLocation: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.NetworkCloud.Cluster("Cluster", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      customLocationId: nexus.managerCustomLocationId,
      clusterType: "SingleRack",
      clusterVersion: nexus.clusterVersion,
      networkFabricId: nexus.networkFabricId,
      aggregatorOrSingleRackDefinition: {
        networkRackId: nexus.rackId,
        rackSerialNumber: nexus.rackSerialNumber,
        rackSkuId: nexus.rackSkuId,
      },
      clusterLocation: props.clusterLocation,
      tags: { env: props.env },
    });
    return { group, res };
  });

const hasRacks =
  !!nexus.managerCustomLocationId &&
  !!nexus.networkFabricId &&
  !!nexus.rackId &&
  !!nexus.rackSkuId &&
  !!nexus.rackSerialNumber &&
  !!nexus.clusterVersion;

// Billed as part of the Nexus platform; 30-60 min to register the racks
// (the multi-hour bare-metal deploy action is not run). Needs a cluster
// manager and an undeployed Network Fabric with certified on-premises racks
// (AZURE_NEXUS_MANAGER_CUSTOM_LOCATION_ID, AZURE_NEXUS_FABRIC_ID,
// AZURE_NEXUS_RACK_ID, AZURE_NEXUS_RACK_SKU_ID, AZURE_NEXUS_RACK_SERIAL,
// AZURE_NEXUS_CLUSTER_VERSION). The racks hold one cluster at a time, so
// there is no create-before-delete replacement step.
test.provider.skipIf(!runPaidOnly || !hasRacks)(
  "create, update, and delete a Nexus cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program({ env: "a", clusterLocation: "Site A" }));
      const observed = yield* get(group.resourceGroupName, res.clusterName);
      expect(observed.properties.clusterType).toEqual("SingleRack");
      expect(observed.properties.clusterLocation).toEqual("Site A");
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(program({ env: "b", clusterLocation: "Site B" }));
      expect(updated.res.clusterId).toEqual(res.clusterId);
      const reobserved = yield* get(group.resourceGroupName, res.clusterName);
      expect(reobserved.properties.clusterLocation).toEqual("Site B");
      expect(reobserved.tags?.env).toEqual("b");

      yield* stack.destroy();
      expect(yield* waitGone(get(group.resourceGroupName, res.clusterName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 5_400_000 },
);

// Ungated probe: the trial has no Nexus cluster manager, so the RP rejects
// a PUT against a custom location that does not exist. Only a resource group
// is created ($0, ~1 minute).
test.provider(
  "the trial rejects a Nexus cluster without a cluster manager custom location",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const resourceGroupName = group.resourceGroupName;
      const pre = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers`;
      const error = yield* nc
        .ClustersCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          location: "eastus",
          clusterName: "probe",
          extendedLocation: bogusCustomLocation(subscriptionId, resourceGroupName),
          properties: {
            clusterType: "SingleRack",
            clusterVersion: "3.10.0",
            networkFabricId: `${pre}/Microsoft.ManagedNetworkFabric/networkFabrics/nofab`,
            aggregatorOrSingleRackDefinition: {
              networkRackId: `${pre}/Microsoft.ManagedNetworkFabric/networkRacks/norack`,
              rackSerialNumber: "AA1234",
              rackSkuId: `/subscriptions/${subscriptionId}/providers/Microsoft.NetworkCloud/rackSkus/nosku`,
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");
      expect(error.message).toContain("custom location was not found");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
