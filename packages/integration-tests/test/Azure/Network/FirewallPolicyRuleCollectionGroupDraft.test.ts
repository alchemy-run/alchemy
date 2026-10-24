import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGroup = (
  resourceGroupName: string,
  firewallPolicyName: string,
  ruleCollectionGroupName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetFirewallPolicyRuleCollectionGroup({
      subscriptionId,
      resourceGroupName,
      firewallPolicyName,
      ruleCollectionGroupName,
    }),
  );

const getGroupDraft = (
  resourceGroupName: string,
  firewallPolicyName: string,
  ruleCollectionGroupName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetFirewallPolicyRuleCollectionGroupDraft({
      subscriptionId,
      resourceGroupName,
      firewallPolicyName,
      ruleCollectionGroupName,
    }),
  );

const dnsCollection = (port: string): network.FirewallPolicyRuleCollection => ({
  ruleCollectionType: "FirewallPolicyFilterRuleCollection",
  name: "allow-dns",
  priority: 100,
  action: { type: "Allow" },
  rules: [
    {
      ruleType: "NetworkRule",
      name: "dns",
      ipProtocols: ["UDP"],
      sourceAddresses: ["10.0.0.0/16"],
      destinationAddresses: ["168.63.129.16"],
      destinationPorts: [port],
    },
  ],
});

// Firewall policies, rule collection groups, and their drafts are free
// without firewalls.
const program = (draftPort: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const policy = yield* Azure.Network.FirewallPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
    });
    const rules = yield* Azure.Network.FirewallPolicyRuleCollectionGroup("Rules", {
      resourceGroup: group.resourceGroupName,
      firewallPolicy: policy.firewallPolicyName,
      priority: 200,
      ruleCollections: [dnsCollection("53")],
    });
    const policyDraft = yield* Azure.Network.FirewallPolicyDraft("PolicyDraft", {
      resourceGroup: group.resourceGroupName,
      firewallPolicy: policy.firewallPolicyName,
    });
    const draft = yield* Azure.Network.FirewallPolicyRuleCollectionGroupDraft("RulesDraft", {
      resourceGroup: group.resourceGroupName,
      firewallPolicy: policyDraft.firewallPolicy,
      ruleCollectionGroup: rules.ruleCollectionGroupName,
      priority: 300,
      ruleCollections: [dnsCollection(draftPort)],
    });
    return { group, policy, rules, draft };
  });

test.provider(
  "create, update, and delete a firewall policy rule collection group draft",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy, rules, draft } = yield* stack.deploy(program("5353"));
      expect(draft.draftName).toEqual("default");
      expect(draft.priority).toEqual(300);
      expect(draft.ruleCollectionNames).toEqual(["allow-dns"]);
      const observed = yield* getGroupDraft(
        group.resourceGroupName,
        policy.firewallPolicyName,
        rules.ruleCollectionGroupName,
      );
      expect(observed.properties?.ruleCollections?.[0]?.rules?.[0]?.destinationPorts).toEqual([
        "5353",
      ]);
      // The draft does not change the live group.
      const live = yield* getGroup(
        group.resourceGroupName,
        policy.firewallPolicyName,
        rules.ruleCollectionGroupName,
      );
      expect(live.properties?.priority).toEqual(200);
      expect(live.properties?.ruleCollections?.[0]?.rules?.[0]?.destinationPorts).toEqual(["53"]);

      const updated = yield* stack.deploy(program("8053"));
      expect(updated.draft.draftId).toEqual(draft.draftId);
      const reobserved = yield* getGroupDraft(
        group.resourceGroupName,
        policy.firewallPolicyName,
        rules.ruleCollectionGroupName,
      );
      expect(reobserved.properties?.ruleCollections?.[0]?.rules?.[0]?.destinationPorts).toEqual([
        "8053",
      ]);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGroupDraft(
            group.resourceGroupName,
            policy.firewallPolicyName,
            rules.ruleCollectionGroupName,
          ),
        ),
      ).toEqual("gone");
      expect(
        yield* untilGone(
          getGroup(
            group.resourceGroupName,
            policy.firewallPolicyName,
            rules.ruleCollectionGroupName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
