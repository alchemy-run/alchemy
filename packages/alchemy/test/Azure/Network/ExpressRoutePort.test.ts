import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPort = (resourceGroupName: string, expressRoutePortName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetExpressRoutePort({
      subscriptionId,
      resourceGroupName,
      expressRoutePortName,
    }),
  );

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const port = yield* Azure.Network.ExpressRoutePort("Port", {
      resourceGroup: group.resourceGroupName,
      peeringLocation: "Equinix-Ashburn-DC2",
      bandwidthInGbps: 10,
      encapsulation: "Dot1Q",
      tags: props.tags,
    });
    return { group, port };
  });

// ExpressRoute Direct ports are creatable on the trial (a probe LAG was
// allocated physical ports) but bill ≈ $5,000+/month for a 10 Gbps pair
// from creation (≈ $7/hour, possibly a monthly minimum). Run with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete an ExpressRoute Direct port",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, port } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(port.linkNames.length).toBeGreaterThan(0);
      const observed = yield* getPort(
        group.resourceGroupName,
        port.expressRoutePortName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.port.expressRoutePortId).toEqual(port.expressRoutePortId);
      const reobserved = yield* getPort(
        group.resourceGroupName,
        port.expressRoutePortName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPort(group.resourceGroupName, port.expressRoutePortName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
