import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGateway = (resourceGroupName: string, gatewayName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVpnGateway({ subscriptionId, resourceGroupName, gatewayName }),
  );

const program = (scaleUnit: number, env: string) =>
  Effect.gen(function* () {
    const { group, wan, hub } = yield* standardHub;
    const gateway = yield* Azure.Network.VpnGateway("S2s", {
      resourceGroup: group.resourceGroupName,
      virtualHubId: hub.virtualHubId,
      scaleUnit,
      tags: { env },
    });
    return { group, wan, hub, gateway };
  });

// Standard hub (~$0.25/hour, 15-30 min) + VPN gateway (~$0.36-0.72/hour,
// 30+ min): ≈$1 and over an hour per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Virtual WAN VPN gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, gateway } = yield* stack.deploy(program(1, "test"));
      expect(gateway.scaleUnit).toEqual(1);
      expect(gateway.bgpAsn).toEqual(65515);
      const observed = yield* getGateway(
        group.resourceGroupName,
        gateway.vpnGatewayName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      const updated = yield* stack.deploy(program(2, "prod"));
      expect(updated.gateway.vpnGatewayId).toEqual(gateway.vpnGatewayId);
      const reobserved = yield* getGateway(
        group.resourceGroupName,
        gateway.vpnGatewayName,
      );
      expect(reobserved.properties?.vpnGatewayScaleUnit).toEqual(2);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGateway(group.resourceGroupName, gateway.vpnGatewayName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
