import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { spokeVnet, standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPeer = (
  resourceGroupName: string,
  virtualHubName: string,
  connectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualHubBgpConnection({
      subscriptionId,
      resourceGroupName,
      virtualHubName,
      connectionName,
    }),
  );

const program = (peerAsn: number) =>
  Effect.gen(function* () {
    const { group, wan, hub } = yield* standardHub;
    const spoke = yield* spokeVnet(group.resourceGroupName, "10.1.0.0/16");
    const connection = yield* Azure.Network.HubVirtualNetworkConnection(
      "SpokeConnection",
      {
        resourceGroup: group.resourceGroupName,
        virtualHub: hub.virtualHubName,
        remoteVirtualNetworkId: spoke.virtualNetworkId,
      },
    );
    // The peer need not exist: the session simply stays down.
    const peer = yield* Azure.Network.VirtualHubBgpConnection("Nva", {
      resourceGroup: group.resourceGroupName,
      virtualHub: hub.virtualHubName,
      peerAsn,
      peerIp: "10.1.0.4",
      hubVirtualNetworkConnectionId: connection.connectionId,
    });
    return { group, wan, hub, spoke, connection, peer };
  });

// Needs a Standard hub (~$0.25/hour, 15-30 min) and a VNet connection:
// ≈$0.40 and ~45 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete a virtual hub BGP connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hub, peer } = yield* stack.deploy(program(65010));
      expect(peer.peerAsn).toEqual(65010);
      const observed = yield* getPeer(
        group.resourceGroupName,
        hub.virtualHubName,
        peer.connectionName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // Azure rejects an in-place peer ASN change: it replaces the peering.
      const updated = yield* stack.deploy(program(65020));
      expect(updated.peer.connectionId).not.toEqual(peer.connectionId);
      const reobserved = yield* getPeer(
        group.resourceGroupName,
        hub.virtualHubName,
        updated.peer.connectionName,
      );
      expect(reobserved.properties?.peerAsn).toEqual(65020);
      expect(
        yield* untilGone(
          getPeer(group.resourceGroupName, hub.virtualHubName, peer.connectionName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPeer(
            group.resourceGroupName,
            hub.virtualHubName,
            updated.peer.connectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);
