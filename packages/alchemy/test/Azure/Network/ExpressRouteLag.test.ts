import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLag = (resourceGroupName: string, expressRouteLagName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetExpressRouteLag({
      subscriptionId,
      resourceGroupName,
      expressRouteLagName,
    }),
  );

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const lag = yield* Azure.Network.ExpressRouteLag("Lag", {
      resourceGroup: group.resourceGroupName,
      // Ashburn-DC2 reported no free 10 Gbps ports for a LAG
      // (GetExpressRoutePortsLocation availableBandwidths: []).
      peeringLocation: "Equinix-Chicago-CH1",
      bandwidthInGbps: 10,
      numberOfPorts: 2,
      tags: props.tags,
    });
    return { group, lag };
  });

// The trial allocates ExpressRoute Direct LAGs (a probe LAG got physical
// ports at Equinix-Ashburn-DC2) and they bill like ER Direct ports
// (≈ $5,000+/month per 10 Gbps pair, ≈ $7/hour). Run with
// AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete an ExpressRoute Direct LAG",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lag } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(lag.numberOfPorts).toEqual(2);
      const observed = yield* getLag(
        group.resourceGroupName,
        lag.expressRouteLagName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.lag.expressRouteLagId).toEqual(lag.expressRouteLagId);
      const reobserved = yield* getLag(
        group.resourceGroupName,
        lag.expressRouteLagName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getLag(group.resourceGroupName, lag.expressRouteLagName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
