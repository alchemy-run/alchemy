import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAuthorization = (
  resourceGroupName: string,
  circuitName: string,
  authorizationName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetExpressRouteCircuitAuthorization({
      subscriptionId,
      resourceGroupName,
      circuitName,
      authorizationName,
    }),
  );

const program = (props: { authorizationName: string; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const circuit = yield* Azure.Network.ExpressRouteCircuit("Circuit", {
      resourceGroup: group.resourceGroupName,
      serviceProviderName: "Equinix",
      peeringLocation: "Washington DC",
      bandwidthInMbps: 50,
      tags: { env: props.env },
    });
    const authorization = yield* Azure.Network.ExpressRouteCircuitAuthorization(
      "Spoke",
      {
        resourceGroup: group.resourceGroupName,
        circuit: circuit.circuitName,
        name: props.authorizationName,
      },
    );
    return { group, circuit, authorization };
  });

// Unprovisioned 50 Mbps metered circuit (≈ $55/month prorated): cents.
test.provider(
  "create, replace, and delete an ExpressRoute circuit authorization",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, circuit, authorization } = yield* stack.deploy(
        program({ authorizationName: "spoke-a", env: "test" }),
      );
      expect(authorization.authorizationKey).toBeDefined();
      expect(authorization.authorizationUseStatus).toEqual("Available");
      const observed = yield* getAuthorization(
        group.resourceGroupName,
        circuit.circuitName,
        "spoke-a",
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // A circuit PUT (tag change) must not drop the authorization.
      const updated = yield* stack.deploy(
        program({ authorizationName: "spoke-a", env: "prod" }),
      );
      expect(updated.authorization.authorizationId).toEqual(
        authorization.authorizationId,
      );
      expect(updated.circuit.authorizationIds.length).toEqual(1);

      const replaced = yield* stack.deploy(
        program({ authorizationName: "spoke-b", env: "prod" }),
      );
      expect(replaced.authorization.authorizationName).toEqual("spoke-b");
      expect(
        yield* untilGone(
          getAuthorization(
            group.resourceGroupName,
            circuit.circuitName,
            "spoke-a",
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getAuthorization(
            group.resourceGroupName,
            circuit.circuitName,
            "spoke-b",
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
