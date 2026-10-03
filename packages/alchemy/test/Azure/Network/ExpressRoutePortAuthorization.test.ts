import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAuthorization = (
  resourceGroupName: string,
  expressRoutePortName: string,
  authorizationName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetExpressRoutePortAuthorization({
      subscriptionId,
      resourceGroupName,
      expressRoutePortName,
      authorizationName,
    }),
  );

const program = (props: { authorizationName: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const port = yield* Azure.Network.ExpressRoutePort("Port", {
      resourceGroup: group.resourceGroupName,
      peeringLocation: "Equinix-Ashburn-DC2",
      bandwidthInGbps: 10,
    });
    const authorization = yield* Azure.Network.ExpressRoutePortAuthorization(
      "Tenant",
      {
        resourceGroup: group.resourceGroupName,
        expressRoutePort: port.expressRoutePortName,
        name: props.authorizationName,
      },
    );
    return { group, port, authorization };
  });

// Needs an ExpressRoute Direct port (≈ $5,000+/month from creation,
// ≈ $7/hour). Run with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, replace, and delete an ExpressRoute port authorization",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, port, authorization } = yield* stack.deploy(
        program({ authorizationName: "tenant-a" }),
      );
      expect(authorization.authorizationKey).toBeDefined();
      const observed = yield* getAuthorization(
        group.resourceGroupName,
        port.expressRoutePortName,
        "tenant-a",
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      yield* stack.deploy(program({ authorizationName: "tenant-b" }));
      expect(
        yield* untilGone(
          getAuthorization(
            group.resourceGroupName,
            port.expressRoutePortName,
            "tenant-a",
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getAuthorization(
            group.resourceGroupName,
            port.expressRoutePortName,
            "tenant-b",
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
