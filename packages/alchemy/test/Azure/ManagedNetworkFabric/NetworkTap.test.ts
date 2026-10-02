import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });
const packetBrokerId = process.env.AZURE_NEXUS_PACKET_BROKER_ID ?? "";

const get = (resourceGroupName: string, networkTapName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetNetworkTap({
      subscriptionId: yield* subscription,
      resourceGroupName,
      networkTapName,
    });
  });

const program = (props: { pollingType: "Pull" | "Push" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const neighbors = yield* Azure.ManagedNetworkFabric.NeighborGroup(
      "Neighbors",
      {
        resourceGroup: group.resourceGroupName,
        destination: { ipv4Addresses: ["10.10.10.10"] },
      },
    );
    const rule = yield* Azure.ManagedNetworkFabric.NetworkTapRule("Rule", {
      resourceGroup: group.resourceGroupName,
      configurationType: "Inline",
      matchConfigurations: [
        {
          matchConfigurationName: "tcp",
          sequenceNumber: 10,
          ipAddressType: "IPv4",
          matchConditions: [{ protocolTypes: ["TCP"] }],
          actions: [{ type: "Count" }],
        },
      ],
    });
    const res = yield* Azure.ManagedNetworkFabric.NetworkTap("Tap", {
      resourceGroup: group.resourceGroupName,
      networkPacketBrokerId: packetBrokerId,
      pollingType: props.pollingType,
      destinations: [
        {
          name: "neighbors",
          destinationType: "Direct",
          destinationId: neighbors.neighborGroupId,
          destinationTapRuleId: rule.networkTapRuleId,
        },
      ],
    });
    return { group, res };
  });

// Needs the packet broker of an Operator Nexus Network Fabric
// (AZURE_NEXUS_PACKET_BROKER_ID); the trial cannot create one. ~$0 once it exists.
test.provider.skipIf(!runPaidOnly || !packetBrokerId)(
  "create, update, and delete a network tap",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, res } = yield* stack.deploy(
        program({ pollingType: "Pull" }),
      );
      const observed = yield* get(group.resourceGroupName, res.networkTapName);
      expect(observed.properties.destinations[0]?.name).toEqual("neighbors");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place.
      const updated = yield* stack.deploy(program({ pollingType: "Push" }));
      expect(updated.res.networkTapId).toEqual(res.networkTapId);
      const reobserved = yield* get(
        group.resourceGroupName,
        res.networkTapName,
      );
      expect(reobserved.properties.pollingType).toEqual("Push");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(group.resourceGroupName, res.networkTapName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the trial has no Operator Nexus deployment, so the RP
// rejects the PUT. Only a resource group is created ($0, ~1-2 minutes).
test.provider(
  "the trial rejects a network tap without a packet broker",
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
      const base = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ManagedNetworkFabric`;
      const error = yield* mnf
        .CreateNetworkTap({
          subscriptionId,
          resourceGroupName,
          networkTapName: "probe",
          location: "eastus",
          properties: {
            networkPacketBrokerId: `${base}/networkPacketBrokers/nonpb`,
            destinations: [
              {
                name: "d",
                destinationType: "Direct",
                destinationId: `${base}/networkFabrics/nofabric/networkToNetworkInterconnects/nonni`,
                destinationTapRuleId: `${base}/networkTapRules/norule`,
              },
            ],
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain("networkPacketBrokers/nonpb");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
