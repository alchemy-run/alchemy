import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  gatewayName: string,
  natRuleName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNatRule({
      subscriptionId,
      resourceGroupName,
      gatewayName,
      natRuleName,
    }),
  );

const program = (external: string) =>
  Effect.gen(function* () {
    const { group, wan, hub } = yield* standardHub;
    const gateway = yield* Azure.Network.VpnGateway("S2s", {
      resourceGroup: group.resourceGroupName,
      virtualHubId: hub.virtualHubId,
    });
    const rule = yield* Azure.Network.VpnGatewayNatRule("Egress", {
      resourceGroup: group.resourceGroupName,
      vpnGateway: gateway.vpnGatewayName,
      mode: "EgressSnat",
      internalMappings: [{ addressSpace: "10.4.0.0/24" }],
      externalMappings: [{ addressSpace: external }],
    });
    return { group, wan, hub, gateway, rule };
  });

// Standard hub + VPN gateway: ≈$1 and over an hour per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a VPN gateway NAT rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, gateway, rule } = yield* stack.deploy(
        program("192.168.21.0/24"),
      );
      expect(rule.mode).toEqual("EgressSnat");

      const updated = yield* stack.deploy(program("192.168.22.0/24"));
      expect(updated.rule.natRuleId).toEqual(rule.natRuleId);
      const observed = yield* getRule(
        group.resourceGroupName,
        gateway.vpnGatewayName,
        rule.natRuleName,
      );
      expect(observed.properties?.externalMappings?.[0]?.addressSpace).toEqual(
        "192.168.22.0/24",
      );

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRule(
            group.resourceGroupName,
            gateway.vpnGatewayName,
            rule.natRuleName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);
