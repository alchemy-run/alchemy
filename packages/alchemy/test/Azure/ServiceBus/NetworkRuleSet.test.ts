import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicebus from "@distilled.cloud/azure/servicebus";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getRuleSet = (resourceGroupName: string, namespaceName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicebus.GetNamespaceNetworkRuleSet({
      subscriptionId,
      resourceGroupName,
      namespaceName,
    });
  });

const base = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const bus = yield* Azure.ServiceBus.Namespace("Bus", {
    resourceGroup: group.resourceGroupName,
    sku: "Standard",
  });
  return { group, bus };
});

const program = (ipMasks: string[]) =>
  Effect.gen(function* () {
    const { group, bus } = yield* base;
    const firewall = yield* Azure.ServiceBus.NetworkRuleSet("Firewall", {
      resourceGroup: group.resourceGroupName,
      namespace: bus.namespaceName,
      defaultAction: "Deny",
      ipRules: ipMasks.map((ipMask) => ({ ipMask })),
    });
    return { group, bus, firewall };
  });

const masks = (ruleSet: servicebus.GetNamespaceNetworkRuleSetResponse) =>
  (ruleSet.properties?.ipRules ?? []).map((rule) => rule.ipMask).sort();

// Standard namespace + its firewall: ~$0.0135/h, a few minutes (<$0.01).
test.provider(
  "configure, update, and reset a namespace network rule set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, bus, firewall } = yield* stack.deploy(
        program(["203.0.113.0/24"]),
      );
      const rg = group.resourceGroupName;
      expect(firewall.networkRuleSetId).toMatch(/\/networkRuleSets\/default$/i);
      expect(firewall.defaultAction).toEqual("Deny");
      const observed = yield* getRuleSet(rg, bus.namespaceName);
      expect(observed.properties?.defaultAction).toEqual("Deny");
      expect(masks(observed)).toEqual(["203.0.113.0/24"]);

      // In place: change the IP rules.
      yield* stack.deploy(program(["198.51.100.0/24", "203.0.113.7"]));
      const reobserved = yield* getRuleSet(rg, bus.namespaceName);
      expect(
        masks(reobserved).map((mask) => mask?.replace(/\/32$/, "")),
      ).toEqual(["198.51.100.0/24", "203.0.113.7"]);

      // Removing the rule set resets the namespace to allow all traffic.
      yield* stack.deploy(base);
      const reset = yield* getRuleSet(rg, bus.namespaceName);
      expect(reset.properties?.defaultAction).toEqual("Allow");
      expect(masks(reset)).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:servicebus", "live"],
    timeout: 600_000,
  },
);
