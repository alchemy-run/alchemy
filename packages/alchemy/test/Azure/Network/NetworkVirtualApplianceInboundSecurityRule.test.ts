import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { hubNva } from "./nvaFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRules = (
  resourceGroupName: string,
  networkVirtualApplianceName: string,
  ruleCollectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetInboundSecurityRule({
      subscriptionId,
      resourceGroupName,
      networkVirtualApplianceName,
      ruleCollectionName,
    }),
  );

const program = (ports: string[]) =>
  Effect.gen(function* () {
    const { group, nva } = yield* hubNva;
    const rules =
      yield* Azure.Network.NetworkVirtualApplianceInboundSecurityRule("Ssh", {
        resourceGroup: group.resourceGroupName,
        networkVirtualAppliance: nva.networkVirtualApplianceName,
        ruleType: "AutoExpire",
        rules: [
          {
            name: "mgmt",
            protocol: "TCP",
            sourceAddressPrefix: "203.0.113.0/24",
            destinationPortRanges: ports,
          },
        ],
      });
    return { group, nva, rules };
  });

// Needs a marketplace NVA in a Standard hub (blocked on the trial, 30+
// minutes, ~$0.25/hour + vendor licence). Run with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "set, update, and clear NVA inbound security rules",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, nva, rules } = yield* stack.deploy(program(["22"]));
      expect(rules.ruleNames).toEqual(["mgmt"]);

      yield* stack.deploy(program(["22", "443"]));
      const observed = yield* getRules(
        group.resourceGroupName,
        nva.networkVirtualApplianceName,
        rules.ruleCollectionName,
      );
      expect(
        [
          ...(observed.properties?.rules?.[0]?.destinationPortRanges ?? []),
        ].sort(),
      ).toEqual(["22", "443"]);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getRules(
            group.resourceGroupName,
            nva.networkVirtualApplianceName,
            rules.ruleCollectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
