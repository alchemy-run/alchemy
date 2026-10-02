import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
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

// Firewall policies and rule collection groups are free without firewalls.
const program = (port: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const policy = yield* Azure.Network.FirewallPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
    });
    const rules = yield* Azure.Network.FirewallPolicyRuleCollectionGroup(
      "Rules",
      {
        resourceGroup: group.resourceGroupName,
        firewallPolicy: policy.firewallPolicyName,
        priority: 200,
        ruleCollections: [
          {
            ruleCollectionType: "FirewallPolicyFilterRuleCollection",
            name: "allow-out",
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
          },
          {
            // A rule collection holds one rule type.
            ruleCollectionType: "FirewallPolicyFilterRuleCollection",
            name: "allow-web",
            priority: 200,
            action: { type: "Allow" },
            rules: [
              {
                ruleType: "ApplicationRule",
                name: "github",
                sourceAddresses: ["10.0.0.0/16"],
                protocols: [{ protocolType: "Https", port: 443 }],
                targetFqdns: ["github.com"],
              },
            ],
          },
        ],
      },
    );
    return { group, policy, rules };
  });

test.provider(
  "create, update, and delete a firewall policy rule collection group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, policy, rules } = yield* stack.deploy(program("53"));
      expect(rules.ruleCollectionNames).toEqual(["allow-out", "allow-web"]);
      const observed = yield* getGroup(
        group.resourceGroupName,
        policy.firewallPolicyName,
        rules.ruleCollectionGroupName,
      );
      expect(observed.properties?.priority).toEqual(200);
      const collection = observed.properties?.ruleCollections?.[0];
      expect(collection?.action?.type).toEqual("Allow");
      expect(collection?.rules?.[0]?.destinationPorts).toEqual(["53"]);
      expect(
        observed.properties?.ruleCollections?.[1]?.rules?.[0]?.targetFqdns,
      ).toEqual(["github.com"]);

      const updated = yield* stack.deploy(program("5353"));
      expect(updated.rules.ruleCollectionGroupId).toEqual(
        rules.ruleCollectionGroupId,
      );
      const reobserved = yield* getGroup(
        group.resourceGroupName,
        policy.firewallPolicyName,
        rules.ruleCollectionGroupName,
      );
      expect(
        reobserved.properties?.ruleCollections?.[0]?.rules?.[0]
          ?.destinationPorts,
      ).toEqual(["5353"]);

      yield* stack.destroy();
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
