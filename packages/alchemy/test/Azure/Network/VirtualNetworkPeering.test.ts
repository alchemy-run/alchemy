import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPeering = (
  resourceGroupName: string,
  virtualNetworkName: string,
  virtualNetworkPeeringName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualNetworkPeering({
      subscriptionId,
      resourceGroupName,
      virtualNetworkName,
      virtualNetworkPeeringName,
    }),
  );

// VNets and peerings are free (peering bills only for traffic).
const program = (props: { allowForwardedTraffic: boolean }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const hub = yield* Azure.Network.VirtualNetwork("Hub", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.10.0.0/16"],
    });
    const spoke = yield* Azure.Network.VirtualNetwork("Spoke", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.20.0.0/16"],
    });
    const hubToSpoke = yield* Azure.Network.VirtualNetworkPeering(
      "HubToSpoke",
      {
        resourceGroup: group.resourceGroupName,
        virtualNetwork: hub.virtualNetworkName,
        remoteVirtualNetworkId: spoke.virtualNetworkId,
      },
    );
    const spokeToHub = yield* Azure.Network.VirtualNetworkPeering(
      "SpokeToHub",
      {
        resourceGroup: group.resourceGroupName,
        virtualNetwork: spoke.virtualNetworkName,
        remoteVirtualNetworkId: hub.virtualNetworkId,
        allowForwardedTraffic: props.allowForwardedTraffic,
      },
    );
    return { group, hub, spoke, hubToSpoke, spokeToHub };
  });

test.provider(
  "create, update, and delete a bidirectional virtual network peering",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hub, spoke, hubToSpoke, spokeToHub } = yield* stack.deploy(
        program({ allowForwardedTraffic: false }),
      );
      expect(hubToSpoke.remoteVirtualNetworkId.toLowerCase()).toEqual(
        spoke.virtualNetworkId.toLowerCase(),
      );
      // Both directions exist, so both read Connected.
      const connected = yield* getPeering(
        group.resourceGroupName,
        hub.virtualNetworkName,
        hubToSpoke.peeringName,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (p) => p.properties?.peeringState === "Connected",
          times: 12,
        }),
      );
      expect(connected.properties?.peeringState).toEqual("Connected");
      expect(connected.properties?.remoteAddressSpace?.addressPrefixes).toEqual(
        ["10.20.0.0/16"],
      );
      const reverse = yield* getPeering(
        group.resourceGroupName,
        spoke.virtualNetworkName,
        spokeToHub.peeringName,
      );
      expect(reverse.properties?.peeringState).toEqual("Connected");
      expect(reverse.properties?.allowForwardedTraffic).toEqual(false);

      const updated = yield* stack.deploy(
        program({ allowForwardedTraffic: true }),
      );
      expect(updated.spokeToHub.peeringId).toEqual(spokeToHub.peeringId);
      const reobserved = yield* getPeering(
        group.resourceGroupName,
        spoke.virtualNetworkName,
        spokeToHub.peeringName,
      );
      expect(reobserved.properties?.allowForwardedTraffic).toEqual(true);
      expect(reobserved.properties?.peeringState).toEqual("Connected");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPeering(
            group.resourceGroupName,
            hub.virtualNetworkName,
            hubToSpoke.peeringName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
