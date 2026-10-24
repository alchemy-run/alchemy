import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { routeServer } from "./gatewayFixtures.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPeering = (resourceGroupName: string, virtualRouterName: string, peeringName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualRouterPeering({
      subscriptionId,
      resourceGroupName,
      virtualRouterName,
      peeringName,
    }),
  );

const program = (peerAsn: number) =>
  Effect.gen(function* () {
    const { group, router } = yield* routeServer("test");
    // The peer is an address in the VNet; no NVA needs to answer for the
    // peering resource to provision.
    const peering = yield* Azure.Network.VirtualRouterPeering("Nva", {
      resourceGroup: group.resourceGroupName,
      virtualRouter: router.virtualRouterName,
      peerAsn,
      peerIp: "10.80.1.4",
    });
    return { group, router, peering };
  });

// ~$0.50/run, 30-45 min: the router bills ~$0.45/hour and takes ~20
// minutes to create and ~10 minutes to delete.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a virtual router peering",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, router, peering } = yield* stack.deploy(program(65010));
      expect(peering.peerAsn).toEqual(65010);
      expect(peering.peerIp).toEqual("10.80.1.4");
      const observed = yield* getPeering(
        group.resourceGroupName,
        router.virtualRouterName,
        peering.peeringName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      const updated = yield* stack.deploy(program(65020));
      expect(updated.peering.peeringId).toEqual(peering.peeringId);
      const reobserved = yield* getPeering(
        group.resourceGroupName,
        router.virtualRouterName,
        peering.peeringName,
      );
      expect(reobserved.properties?.peerAsn).toEqual(65020);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPeering(group.resourceGroupName, router.virtualRouterName, peering.peeringName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);
