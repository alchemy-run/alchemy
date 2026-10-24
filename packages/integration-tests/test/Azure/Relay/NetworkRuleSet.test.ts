import * as Azure from "@alchemy.run/azure";
import * as relay from "@distilled.cloud/azure/relay";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, namespaceProgram, subscriptionId, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRuleSet = (resourceGroupName: string, namespaceName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    relay.GetNamespaceNetworkRuleSet({ subscriptionId, resourceGroupName, namespaceName }),
  );

const program = (props: { ipMasks: string[]; trustedServiceAccessEnabled: boolean }) =>
  Effect.gen(function* () {
    const { group, ns } = yield* namespaceProgram;
    const firewall = yield* Azure.Relay.NetworkRuleSet("Firewall", {
      resourceGroup: group.resourceGroupName,
      namespace: ns.namespaceName,
      defaultAction: "Deny",
      trustedServiceAccessEnabled: props.trustedServiceAccessEnabled,
      ipRules: props.ipMasks.map((ipMask) => ({ ipMask })),
    });
    return { group, ns, firewall };
  });

const masks = (ruleSet: relay.GetNamespaceNetworkRuleSetResponse) =>
  (ruleSet.properties?.ipRules ?? [])
    .map((rule) => (rule.ipMask ?? "").replace(/\/32$/, ""))
    .sort();

// Relay namespace (idle, ~$0) + its firewall (free); a few minutes.
test.provider(
  "configure, update, and reset a relay namespace network rule set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, ns, firewall } = yield* stack.deploy(
        program({ ipMasks: ["203.0.113.0/24"], trustedServiceAccessEnabled: false }),
      );
      const rg = group.resourceGroupName;
      expect(firewall.networkRuleSetId).toMatch(/\/networkRuleSets\/default$/i);
      expect(firewall.defaultAction).toEqual("Deny");
      expect(firewall.trustedServiceAccessEnabled).toEqual(false);
      const observed = yield* getRuleSet(rg, ns.namespaceName);
      expect(observed.properties?.defaultAction).toEqual("Deny");
      expect(masks(observed)).toEqual(["203.0.113.0/24"]);

      // In place: IP rules and trusted service access.
      const updated = yield* stack.deploy(
        program({
          ipMasks: ["198.51.100.0/24", "203.0.113.7"],
          trustedServiceAccessEnabled: true,
        }),
      );
      expect(updated.firewall.networkRuleSetId).toEqual(firewall.networkRuleSetId);
      expect(updated.firewall.trustedServiceAccessEnabled).toEqual(true);
      const reobserved = yield* getRuleSet(rg, ns.namespaceName);
      expect(masks(reobserved)).toEqual(["198.51.100.0/24", "203.0.113.7"]);
      expect(reobserved.properties?.trustedServiceAccessEnabled).toEqual(true);

      // Removing the rule set resets the namespace to allow all traffic.
      yield* stack.deploy(namespaceProgram);
      const reset = yield* getRuleSet(rg, ns.namespaceName);
      expect(reset.properties?.defaultAction).toEqual("Allow");
      expect(masks(reset)).toEqual([]);
      expect(reset.properties?.trustedServiceAccessEnabled ?? false).toEqual(false);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
