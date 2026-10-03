import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCircuit = (resourceGroupName: string, circuitName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetExpressRouteCircuit({
      subscriptionId,
      resourceGroupName,
      circuitName,
    }),
  );

const program = (props: {
  tier: "Standard" | "Premium";
  peeringLocation: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const circuit = yield* Azure.Network.ExpressRouteCircuit("Circuit", {
      resourceGroup: group.resourceGroupName,
      tier: props.tier,
      serviceProviderName: "Equinix",
      peeringLocation: props.peeringLocation,
      bandwidthInMbps: 50,
      tags: props.tags,
    });
    return { group, circuit };
  });

// An unprovisioned 50 Mbps metered circuit bills ≈ $55/month (Premium
// ≈ $130/month) prorated: a few cents for the minutes this test holds it.
test.provider(
  "create, update, replace, and delete an ExpressRoute circuit",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, circuit } = yield* stack.deploy(
        program({
          tier: "Standard",
          peeringLocation: "Washington DC",
          tags: { env: "test" },
        }),
      );
      expect(circuit.serviceKey).toBeDefined();
      expect(circuit.serviceProviderProvisioningState).toEqual(
        "NotProvisioned",
      );
      const observed = yield* getCircuit(
        group.resourceGroupName,
        circuit.circuitName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.sku?.tier).toEqual("Standard");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({
          tier: "Premium",
          peeringLocation: "Washington DC",
          tags: { env: "prod" },
        }),
      );
      expect(updated.circuit.circuitId).toEqual(circuit.circuitId);
      const reobserved = yield* getCircuit(
        group.resourceGroupName,
        circuit.circuitName,
      );
      expect(reobserved.sku?.tier).toEqual("Premium");
      expect(reobserved.tags?.env).toEqual("prod");

      const replaced = yield* stack.deploy(
        program({
          tier: "Premium",
          peeringLocation: "Silicon Valley",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.circuit.circuitName).not.toEqual(circuit.circuitName);
      expect(replaced.circuit.peeringLocation).toEqual("Silicon Valley");
      expect(
        yield* untilGone(
          getCircuit(group.resourceGroupName, circuit.circuitName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getCircuit(group.resourceGroupName, replaced.circuit.circuitName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
