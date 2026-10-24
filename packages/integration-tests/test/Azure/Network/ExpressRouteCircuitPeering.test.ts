import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPeering = (resourceGroupName: string, circuitName: string, peeringName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetExpressRouteCircuitPeering({
      subscriptionId,
      resourceGroupName,
      circuitName,
      peeringName,
    }),
  );

const program = (props: { vlanId: number; peerAsn: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const circuit = yield* Azure.Network.ExpressRouteCircuit("Circuit", {
      resourceGroup: group.resourceGroupName,
      serviceProviderName: "Equinix",
      peeringLocation: "Washington DC",
      bandwidthInMbps: 50,
    });
    const peering = yield* Azure.Network.ExpressRouteCircuitPeering("Private", {
      resourceGroup: group.resourceGroupName,
      circuit: circuit.circuitName,
      peeringType: "AzurePrivatePeering",
      peerAsn: props.peerAsn,
      primaryPeerAddressPrefix: "192.168.10.0/30",
      secondaryPeerAddressPrefix: "192.168.10.4/30",
      vlanId: props.vlanId,
    });
    return { group, circuit, peering };
  });

// Azure accepts the peering configuration before the provider provisions
// the circuit. An unprovisioned 50 Mbps metered circuit bills ≈ $55/month
// prorated: a few cents for the ~10 minutes this test holds it.
test.provider(
  "create, update, and delete an ExpressRoute private peering",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, circuit, peering } = yield* stack.deploy(
        program({ vlanId: 100, peerAsn: 65010 }),
      );
      expect(peering.peeringName).toEqual("AzurePrivatePeering");
      expect(peering.azureAsn).toEqual(12076);
      const observed = yield* getPeering(
        group.resourceGroupName,
        circuit.circuitName,
        peering.peeringName,
      );
      expect(observed.properties?.vlanId).toEqual(100);
      expect(observed.properties?.peerASN).toEqual(65010);

      const updated = yield* stack.deploy(program({ vlanId: 200, peerAsn: 65020 }));
      expect(updated.peering.peeringId).toEqual(peering.peeringId);
      const reobserved = yield* getPeering(
        group.resourceGroupName,
        circuit.circuitName,
        peering.peeringName,
      );
      expect(reobserved.properties?.vlanId).toEqual(200);
      expect(reobserved.properties?.peerASN).toEqual(65020);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPeering(group.resourceGroupName, circuit.circuitName, peering.peeringName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_200_000 },
);
