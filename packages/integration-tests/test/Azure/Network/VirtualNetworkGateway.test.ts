import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive, withPublicIps } from "../gates.ts";
import { vpnGateway } from "./gatewayFixtures.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGateway = (resourceGroupName: string, virtualNetworkGatewayName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualNetworkGateway({
      subscriptionId,
      resourceGroupName,
      virtualNetworkGatewayName,
    }),
  );

// ~$0.50/run, 60-90 min: VpnGw1AZ (~$0.19/hour) takes 30-45 minutes to
// create and 10-20 minutes to delete.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a VPN gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, subnet, gateway } = yield* stack.deploy(
        vpnGateway({ sku: "VpnGw1AZ", tags: { env: "test" } }),
      );
      expect(gateway.gatewayType).toEqual("Vpn");
      expect(gateway.vpnType).toEqual("RouteBased");
      expect(gateway.sku).toEqual("VpnGw1AZ");
      expect(gateway.subnetId?.toLowerCase()).toEqual(subnet.subnetId.toLowerCase());
      const observed = yield* getGateway(
        group.resourceGroupName,
        gateway.virtualNetworkGatewayName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.vpnGatewayGeneration).toEqual("Generation2");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(vpnGateway({ sku: "VpnGw1AZ", tags: { env: "prod" } }));
      expect(updated.gateway.virtualNetworkGatewayId).toEqual(gateway.virtualNetworkGatewayId);
      const reobserved = yield* getGateway(
        group.resourceGroupName,
        gateway.virtualNetworkGatewayName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getGateway(group.resourceGroupName, gateway.virtualNetworkGatewayName)),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), logLevel),
  { tags, timeout: 10_800_000 },
);
