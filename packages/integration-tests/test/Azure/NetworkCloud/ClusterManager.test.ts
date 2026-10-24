import * as Azure from "@alchemy.run/azure";
import * as nc from "@distilled.cloud/azure/networkcloud";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, nexus, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const get = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    return yield* nc.GetClusterManager({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterManagerName: name,
    });
  });

const program = (props: { env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const res = yield* Azure.NetworkCloud.ClusterManager("Manager", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      fabricControllerId: nexus.fabricControllerId,
      tags: { env: props.env },
    });
    return { group, res };
  });

// ~$0 beyond the Nexus platform fee, 30-60 min. Needs an Operator Nexus
// Network Fabric controller (AZURE_NEXUS_FABRIC_CONTROLLER_ID), which only
// operator subscriptions with on-premises racks have. A fabric controller
// pairs with one manager, so there is no create-before-delete replacement step.
test.provider.skipIf(!runPaidOnly || !nexus.fabricControllerId)(
  "create, update, and delete a Nexus cluster manager",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(program({ env: "a" }));
      const observed = yield* get(group.resourceGroupName, res.clusterManagerName);
      expect(observed.properties.fabricControllerId.toLowerCase()).toEqual(
        nexus.fabricControllerId.toLowerCase(),
      );
      expect(observed.tags?.env).toEqual("a");

      // In place.
      const updated = yield* stack.deploy(program({ env: "b" }));
      expect(updated.res.clusterManagerId).toEqual(res.clusterManagerId);
      const reobserved = yield* get(group.resourceGroupName, res.clusterManagerName);
      expect(reobserved.tags?.env).toEqual("b");

      yield* stack.destroy();
      expect(yield* waitGone(get(group.resourceGroupName, res.clusterManagerName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 5_400_000 },
);

// Ungated probe ($0, ~3 minutes): ARM accepts a cluster manager paired with
// a fabric controller that does not exist, then provisioning ends `Failed`
// within about a minute. The provider surfaces Azure.ProvisioningFailed, and
// destroy removes the failed manager.
test.provider(
  "a Nexus cluster manager without a fabric controller fails provisioning",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscriptionId = yield* subscription;
      const fabricControllerId = `/subscriptions/${subscriptionId}/resourceGroups/alchemy-nexus-missing/providers/Microsoft.ManagedNetworkFabric/networkFabricControllers/nofc`;

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const group = yield* Azure.Resources.ResourceGroup("Group", {
              location: "eastus",
            });
            const res = yield* Azure.NetworkCloud.ClusterManager("Manager", {
              resourceGroup: group.resourceGroupName,
              name: "probe",
              location: "eastus",
              fabricControllerId,
            });
            return { group, res };
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Azure.ProvisioningFailed");
      expect(JSON.stringify(error)).toContain("Nexus cluster manager probe");

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      // Removing the manager from the stack deletes the failed manager.
      expect(yield* waitGone(get(group.resourceGroupName, "probe"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 1_200_000 },
);
