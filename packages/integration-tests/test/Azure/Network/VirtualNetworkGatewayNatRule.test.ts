import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive, withPublicIps } from "../gates.ts";
import { vpnGateway } from "./gatewayFixtures.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  virtualNetworkGatewayName: string,
  natRuleName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetVirtualNetworkGatewayNatRule({
      subscriptionId,
      resourceGroupName,
      virtualNetworkGatewayName,
      natRuleName,
    }),
  );

const program = (externalPrefix: string) =>
  Effect.gen(function* () {
    // NAT rules need a VpnGw2 (or higher) gateway.
    const { group, gateway } = yield* vpnGateway({ sku: "VpnGw2AZ" });
    const rule = yield* Azure.Network.VirtualNetworkGatewayNatRule("Egress", {
      resourceGroup: group.resourceGroupName,
      virtualNetworkGateway: gateway.virtualNetworkGatewayName,
      mode: "EgressSnat",
      internalMappings: [{ addressSpace: "10.70.0.0/24" }],
      externalMappings: [{ addressSpace: externalPrefix }],
    });
    return { group, gateway, rule };
  });

// ~$1/run, 60-90 min: VpnGw2AZ (~$0.49/hour) takes 30-45 minutes to
// create and 10-20 minutes to delete.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a VPN gateway NAT rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, gateway, rule } = yield* stack.deploy(program("192.168.21.0/24"));
      expect(rule.type).toEqual("Static");
      expect(rule.mode).toEqual("EgressSnat");
      const observed = yield* getRule(
        group.resourceGroupName,
        gateway.virtualNetworkGatewayName,
        rule.natRuleName,
      );
      expect(observed.properties?.externalMappings?.[0]?.addressSpace).toEqual("192.168.21.0/24");

      const updated = yield* stack.deploy(program("192.168.22.0/24"));
      expect(updated.rule.natRuleId).toEqual(rule.natRuleId);
      const reobserved = yield* getRule(
        group.resourceGroupName,
        gateway.virtualNetworkGatewayName,
        rule.natRuleName,
      );
      expect(reobserved.properties?.externalMappings?.[0]?.addressSpace).toEqual("192.168.22.0/24");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRule(group.resourceGroupName, gateway.virtualNetworkGatewayName, rule.natRuleName),
        ),
      ).toEqual("gone");
    }).pipe(withPublicIps(1), logLevel),
  { tags, timeout: 10_800_000 },
);
